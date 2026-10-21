import { join, type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import { SearchQueryError, type SearchRequest, type SearchResult } from '../backend.js';
import {
  capabilitiesFromFields,
  type FieldDeclarations,
  resolveFields,
  type SearchDocument,
  storeDocuments,
  toWire,
} from '../fields.js';
import { filtersCondition } from '../requestFilters.js';
import { checkSearchVisibility } from '../visibility.js';
import { advancedQueryFor } from './advanced.js';
import { valueBuckets, yearBuckets } from './facets.js';
import { boundingBoxCondition, geohash, geohashGrid } from './geo.js';
import { TEXT_SEARCH_CONFIG, typed } from './values.js';
import { visibilityCondition } from './visibility.js';

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

const WEIGHT_LABELS = ['D', 'C', 'B', 'A'];

/**
 * Postgres search backend: holds one search document per entity in the `EntitySearch` table
 */
export const PostgresBackend = <const Fields extends FieldDeclarations>({
  prisma,
  fields,
}: PostgresBackendOptions<Fields>) => {
  const capabilities = capabilitiesFromFields(fields);
  const { basic, facets } = resolveFields(fields);
  const textFields = Object.keys(fields).filter((name) => fields[name].type === 'text');

  const basicVectors = basic.map(
    ({ name, weight }) =>
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

  const facetBuckets = facets.map(
    ({ name, type, size }) =>
      sql`jsonb_build_object(${name}::text, ${type === 'date' ? yearBuckets(name) : valueBuckets(name, size)})`,
  );

  const queryFor = (request: SearchRequest) => {
    if (request.searchType === 'advanced') {
      return advancedQueryFor(request.query, fields);
    }
    if (request.query.trim() === '') {
      return { condition: sql`TRUE`, rank: sql`0` };
    }
    const tsquery = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${request.query}::text)`;

    // A query with no words left after parsing, such as `*`, matches everything
    return {
      condition: sql`(numnode(${tsquery}) = 0 OR search.basic @@ ${tsquery})`,
      rank: sql`ts_rank(search.basic, ${tsquery})`,
    };
  };

  return {
    capabilities,

    search: async (request: SearchRequest): Promise<SearchResult> => {
      const { condition: matches, rank } = queryFor(request);
      const conditions = [
        matches,
        visibilityCondition(filtersCondition(request.filters), fields),
        ...(request.boundingBox ? [boundingBoxCondition(request.boundingBox)] : []),
        visibilityCondition(checkSearchVisibility(fields, request.visibility), fields),
      ];

      const { sort, order, geohashPrecision } = request;
      const [key, direction] =
        sort === 'relevance'
          ? [rank, sql`DESC`]
          : [
              typed(fields[sort].type, sql`search."values" ->> ${sort}::text`),
              order === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`,
            ];
      const [result] = await asQueryErrors(
        prisma.$queryRaw<(Pick<SearchResult, 'total' | 'facets' | 'geohashGrid'> & { hits: string[] })[]>(sql`
        WITH matched AS (
          SELECT search.id, search."values", search.geohash, ${key} AS key
          FROM entity_search AS search
          WHERE ${join(conditions, ' AND ')}
        )
        SELECT
          (SELECT count(*)::int FROM matched) AS total,
          (
            SELECT coalesce(jsonb_agg(page.id ORDER BY page.key ${direction}, page.id COLLATE "C"), '[]')
            FROM (
              SELECT search.id, search.key
              FROM matched AS search
              ORDER BY search.key ${direction}, search.id COLLATE "C"
              LIMIT ${request.limit}::int OFFSET ${request.offset}::int
            ) AS page
          ) AS hits,
          ${join([sql`'{}'::jsonb`, ...facetBuckets], ' || ')} AS facets,
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

      const rows = [...new Map(stored.map((doc) => [doc.id, doc])).values()].map(({ id, values, point }) => ({
        id,
        values: Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.map(toWire) : toWire(value),
          ]),
        ),
        ...(point && { ...point, geohash: geohash(point) }),
      }));

      const ids = rows.map(({ id }) => id);
      const upsert = (tx ?? prisma).$queryRaw<{ id: string }[]>(sql`
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

      let missing: { id: string }[];
      try {
        missing = await upsert;
      } catch (error) {
        if (driverErrorOf(error)?.originalCode !== FOREIGN_KEY_VIOLATION) {
          throw error;
        }

        // An entity was deleted after the check; `tx` is aborted, so look outside it
        missing = await prisma.$queryRaw<{ id: string }[]>(sql`
          SELECT doc.id FROM unnest(${ids}::text[]) AS doc(id)
          WHERE NOT EXISTS (SELECT FROM entity WHERE entity.id = doc.id)
          ORDER BY doc.id
        `);
        if (missing.length === 0) {
          throw error;
        }
      }

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

const driverErrorOf = (error: unknown) => (error as DriverAdapterError).meta?.driverAdapterError?.cause;

const FOREIGN_KEY_VIOLATION = '23503';

// Data exceptions (22) come from query values a field can't hold; program limits (54) from queries too big to run
const QUERY_ERROR_CLASSES = ['22', '54'];

const asQueryErrors = async <T>(query: PromiseLike<T>) => {
  try {
    return await query;
  } catch (error) {
    const cause = driverErrorOf(error);
    if (cause && QUERY_ERROR_CLASSES.some((errorClass) => cause.originalCode?.startsWith(errorClass))) {
      throw new SearchQueryError(cause.originalMessage);
    }

    throw error;
  }
};
