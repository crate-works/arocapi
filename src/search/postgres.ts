import { join, type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import { SearchQueryError, type SearchRequest, type SearchResult } from './backend.js';
import {
  capabilitiesFromFields,
  type FieldDeclarations,
  type GeoPoint,
  type SearchDocument,
  storeDocuments,
} from './fields.js';
import { advancedQueryFor } from './postgresAdvanced.js';
import { valueBuckets, yearBuckets } from './postgresFacets.js';
import { boundingBoxCondition, geohashGrid } from './postgresGeo.js';
import { typed, valuesOf } from './postgresValues.js';
import { visibilityCondition } from './postgresVisibility.js';
import { checkSearchVisibility } from './visibility.js';

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
const DEFAULT_FACET_SIZE = 20;
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

  const facets = declared
    .filter(([, { facet }]) => facet)
    .map(([name, { type, facet }]) => {
      const buckets =
        type === 'date'
          ? yearBuckets(name)
          : valueBuckets(name, typeof facet === 'object' ? facet.size : DEFAULT_FACET_SIZE);

      return sql`jsonb_build_object(${name}::text, ${buckets})`;
    });

  const orderFor = ({ sort, order }: SearchRequest) =>
    sort === 'relevance'
      ? sql`search.rank DESC`
      : sql`${typed(fields[sort].type, sql`search."values" ->> ${sort}::text`)} ${order === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`;

  const queryFor = (request: SearchRequest) => {
    if (request.searchType === 'advanced') {
      return advancedQueryFor(request.query, fields, TEXT_SEARCH_CONFIG);
    }
    if (request.query.trim() === '') {
      return { condition: sql`TRUE`, rank: sql`0` };
    }
    const tsquery = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${request.query}::text)`;

    return { condition: sql`search.basic @@ ${tsquery}`, rank: sql`ts_rank(search.basic, ${tsquery})` };
  };

  return {
    capabilities,

    search: async (request: SearchRequest): Promise<SearchResult> => {
      const { condition: matches, rank } = queryFor(request);
      const conditions = [
        matches,
        ...Object.entries(request.filters.terms).map(
          ([name, values]) => sql`EXISTS (SELECT FROM ${valuesOf(name)} WHERE field.value = ANY(${values}::text[]))`,
        ),
        ...Object.entries(request.filters.ranges).map(([name, ranges]) =>
          visibilityCondition(
            { type: 'or', clauses: ranges.map((bounds) => ({ type: 'range', field: name, bounds })) },
            fields,
          ),
        ),
        ...(request.boundingBox ? [boundingBoxCondition(request.boundingBox)] : []),
        visibilityCondition(checkSearchVisibility(fields, request.visibility), fields),
      ];

      const { geohashPrecision } = request;
      const [result] = await asQueryErrors(
        prisma.$queryRaw<(Pick<SearchResult, 'total' | 'facets' | 'geohashGrid'> & { hits: string[] })[]>(sql`
        WITH matched AS (
          SELECT search.id, search."values", search.geohash, ${rank} AS rank
          FROM entity_search AS search
          WHERE ${join(conditions, ' AND ')}
        )
        SELECT
          (SELECT count(*)::int FROM matched) AS total,
          (
            SELECT coalesce(jsonb_agg(page.id ORDER BY page.position), '[]')
            FROM (
              SELECT search.id, row_number() OVER (ORDER BY ${orderFor(request)}, search.id COLLATE "C") AS position
              FROM matched AS search
              ORDER BY position
              LIMIT ${request.limit}::int OFFSET ${request.offset}::int
            ) AS page
          ) AS hits,
          ${join([sql`'{}'::jsonb`, ...facets], ' || ')} AS facets,
          ${geohashPrecision === undefined ? sql`NULL` : geohashGrid(geohashPrecision)} AS "geohashGrid"
      `),
      );

      return {
        total: result.total,
        hits: result.hits.map((id) => ({ id })),
        facets: result.facets,
        ...(result.geohashGrid && { geohashGrid: result.geohashGrid }),
      };
    },

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

type DriverAdapterError = {
  meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } };
};

// Data exceptions (22) come from query values a field can't hold; program limits (54) from queries too big to run
const QUERY_ERROR_CLASSES = ['22', '54'];

const asQueryErrors = async <T>(query: PromiseLike<T>) => {
  try {
    return await query;
  } catch (error) {
    const cause = (error as DriverAdapterError).meta?.driverAdapterError?.cause;
    if (cause && QUERY_ERROR_CLASSES.some((errorClass) => cause.originalCode?.startsWith(errorClass))) {
      throw new SearchQueryError(cause.originalMessage);
    }

    throw error;
  }
};

const toJson = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
