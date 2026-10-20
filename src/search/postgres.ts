import { join, type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import {
  capabilitiesFromFields,
  type FieldDeclarations,
  type GeoPoint,
  type SearchDocument,
  storeDocuments,
} from './fields.js';

/**
 * The Prisma client PostgresBackend needs: any Prisma 7 client on a schema that includes the arocapi models,
 * including the client inside `$transaction`
 */
export type PostgresClient = {
  $queryRaw<T = unknown>(query: Sql): PromiseLike<T>;
  $executeRaw(query: Sql): PromiseLike<number>;
};

export type PostgresBackendOptions<Fields extends FieldDeclarations> = {
  prisma: PostgresClient;
  fields: Fields;
};

const TEXT_SEARCH_CONFIG = sql`'simple'::regconfig`;
const WEIGHT_LABELS = ['D', 'C', 'B', 'A'];
const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

const geohash = ({ lat, lng }: GeoPoint) => {
  const ranges = [
    [-180, 180],
    [-90, 90],
  ];
  let hash = '';
  let bits = 0;
  for (let bit = 0; bit < 60; bit++) {
    const axis = bit % 2;
    const range = ranges[axis];
    const middle = (range[0] + range[1]) / 2;
    const upper = (axis === 0 ? lng : lat) >= middle;
    range[upper ? 0 : 1] = middle;
    bits = bits * 2 + Number(upper);
    if (bit % 5 === 4) {
      hash += GEOHASH_ALPHABET[bits];
      bits = 0;
    }
  }

  return hash;
};

/**
 * Postgres search backend: holds one search document per entity in the `EntitySearch` table
 */
export const PostgresBackend = <const Fields extends FieldDeclarations>({
  prisma,
  fields,
}: PostgresBackendOptions<Fields>) => {
  const capabilities = capabilitiesFromFields(fields);
  const declared = Object.entries(fields);
  const geoField = declared.find(([, { type }]) => type === 'geo')?.[0];
  const textFields = declared.filter(([, { type }]) => type === 'text').map(([name]) => name);

  const basicVectors = declared
    .filter(([, { type, basic }]) => (type === 'text' && basic !== false) || (type === 'keyword' && basic))
    .map(
      ([name, { weight = 1 }]) =>
        sql`coalesce(setweight(to_tsvector(${TEXT_SEARCH_CONFIG}, docs."values" -> ${name}), ${WEIGHT_LABELS[weight - 1]}::"char"), '')`,
    );
  const basicVector = basicVectors.length > 0 ? join(basicVectors, ' || ') : sql`''::tsvector`;

  // Built as text so each field keeps its own positions; tsvector `||` would shift them towards the 16383 limit
  const textVector = sql`(
    SELECT coalesce(string_agg(
      '''' || replace(replace(field || '.' || lexeme, '\\', '\\\\'), '''', '''''') || ''':' || array_to_string(positions, ','),
      ' '
    ), '')::tsvector
    FROM unnest(${textFields}::text[]) AS field, unnest(to_tsvector(${TEXT_SEARCH_CONFIG}, docs."values" -> field))
  )`;

  return {
    capabilities,

    /**
     * Upsert search documents, replacing any already indexed with the same id
     * Throws, naming them, if any entities don't exist, and then stores nothing from the batch
     */
    index: async (docs: SearchDocument<Fields>[], { tx }: { tx?: PostgresClient } = {}) => {
      const stored = storeDocuments(fields, docs);

      const rows = [...new Map(stored.map((doc) => [doc.id, doc])).values()].map(({ id, values }) => {
        const location = geoField && (values[geoField] as GeoPoint | undefined);
        const json = Object.fromEntries(
          Object.entries(values)
            .filter(([name]) => name !== geoField)
            .map(([name, value]) => [name, Array.isArray(value) ? value.map(toJson) : toJson(value)]),
        );

        return { id, values: json, ...(location && { ...location, geohash: geohash(location) }) };
      });

      const missing = await (tx ?? prisma).$queryRaw<{ id: string }[]>(sql`
        WITH docs AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
            AS docs(id text, "values" jsonb, lat float8, lng float8, geohash text)
        ),
        missing AS (
          SELECT docs.id FROM docs WHERE NOT EXISTS (SELECT FROM entity WHERE entity.id = docs.id)
        ),
        upserted AS (
          INSERT INTO entity_search (id, "values", basic, text, point, geohash)
          SELECT docs.id, docs."values", ${basicVector}, ${textVector}, point(docs.lng, docs.lat), docs.geohash
          FROM docs
          WHERE NOT EXISTS (SELECT FROM missing)
          ON CONFLICT (id) DO UPDATE SET
            "values" = excluded."values",
            basic = excluded.basic,
            text = excluded.text,
            point = excluded.point,
            geohash = excluded.geohash
        )
        SELECT id FROM missing ORDER BY id
      `);

      if (missing.length > 0) {
        throw new Error(
          `Search documents reference entities that don't exist: ${missing.map(({ id }) => JSON.stringify(id)).join(', ')}`,
        );
      }
    },

    /**
     * Remove search documents, ignoring ids that aren't indexed
     */
    remove: async (ids: string[]) => {
      await prisma.$executeRaw(sql`DELETE FROM entity_search WHERE id = ANY(${ids}::text[])`);
    },
  };
};

const toJson = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
