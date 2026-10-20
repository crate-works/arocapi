import { isDeepStrictEqual } from 'node:util';
import type { Client } from '@opensearch-project/opensearch';
import type { SortOrder } from '@opensearch-project/opensearch/api/_types/_common.js';
import type { QueryContainer } from '@opensearch-project/opensearch/api/_types/_common.query_dsl.js';
import type { Search_RequestBody, Search_Response } from '@opensearch-project/opensearch/api/index.js';
import {
  type BoundingBox,
  type FacetBucket,
  type RangeBound,
  SearchQueryError,
  type SearchRequest,
  type SearchResult,
} from './backend.js';
import {
  capabilitiesFromFields,
  type FieldDeclaration,
  type FieldDeclarations,
  isFilter,
  type SearchDocument,
  storeDocuments,
} from './fields.js';

export type OpenSearchBackendOptions<Fields extends FieldDeclarations> = {
  client: Client;
  fields: Fields;
  /** Default `entities` */
  indexName?: string;
};

// A keyword term is limited to 32766 bytes, up to 4 per character
const EXACT_FORM = { exact: { type: 'keyword', ignore_above: 8191 } };

const mappingFor = (declaration: FieldDeclaration) => {
  const { type } = declaration;
  switch (type) {
    case 'text':
      return declaration.sort || isFilter(declaration) ? { type, fields: EXACT_FORM } : { type };
    case 'number':
      return { type: 'double' };
    case 'geo':
      return { type: 'geo_point' };
    default:
      return { type };
  }
};

const DEFAULT_FACET_SIZE = 20;
const FACET_ORDER: Record<string, SortOrder>[] = [{ _count: 'desc' }, { _key: 'asc' }];

type TermsBucket = { key: string | number; key_as_string?: string; doc_count: number };

// Not a valid field name, so it can't collide with a facet
const GEOHASH_GRID = 'geohash-grid';

// Epoch milliseconds, which date fields accept as well as numbers
const toOpenSearchBound = (bound: RangeBound | undefined) => (bound instanceof Date ? bound.getTime() : bound);

const geoBox = ({ topRight, bottomLeft }: BoundingBox) => ({
  top_left: { lat: topRight.lat, lon: bottomLeft.lng },
  bottom_right: { lat: bottomLeft.lat, lon: topRight.lng },
});

type BulkItem = Record<
  string,
  { _id?: string | null; status: number; error?: { type: string; reason?: string | null } }
>;

/**
 * OpenSearch search backend: holds one search document per entity in an index built from the field declarations
 */
export const OpenSearchBackend = <const Fields extends FieldDeclarations>({
  client,
  fields,
  indexName = 'entities',
}: OpenSearchBackendOptions<Fields>) => {
  const capabilities = capabilitiesFromFields(fields);
  const declared = Object.entries(fields);
  const geoField = declared.find(([, { type }]) => type === 'geo')?.[0];

  const exactField = (name: string) => (fields[name].type === 'text' ? `${name}.exact` : name);
  const isBasic = ({ type, basic }: FieldDeclaration) => (type === 'text' ? basic !== false : basic);
  const basicFields = declared
    .filter(([, declaration]) => isBasic(declaration))
    .map(([name, { weight = 1 }]) => `${name}^${weight}`);
  const facets = declared.filter(([, { facet }]) => facet);
  const highlight: Search_RequestBody['highlight'] = {
    fields: Object.fromEntries(
      declared
        .filter(
          ([, declaration]) =>
            ['text', 'keyword'].includes(declaration.type) && (isBasic(declaration) || declaration.advanced),
        )
        .map(([name]) => [name, {}]),
    ),
  };

  const queryFor = (request: SearchRequest): QueryContainer => {
    if (request.searchType === 'advanced' || request.query.trim() === '') {
      return { match_all: {} };
    }
    if (basicFields.length === 0) {
      return { match_none: {} };
    }

    return { multi_match: { query: request.query, fields: basicFields, type: 'best_fields', fuzziness: 'AUTO' } };
  };

  const sortFor = ({ sort, order }: SearchRequest): Search_RequestBody['sort'] => [
    sort === 'relevance' ? { _score: { order: 'desc' } } : { [exactField(sort)]: { order, missing: '_last' } },
    { id: { order: 'asc' } },
  ];

  const aggregations: Search_RequestBody['aggs'] = Object.fromEntries(
    facets.map(([name, { type, facet }]) => [
      name,
      type === 'date'
        ? {
            date_histogram: {
              field: name,
              calendar_interval: 'year',
              format: 'yyyy',
              time_zone: 'UTC',
              min_doc_count: 1,
              order: { _key: 'asc' },
            },
          }
        : {
            terms: {
              field: exactField(name),
              size: typeof facet === 'object' ? facet.size : DEFAULT_FACET_SIZE,
              order: FACET_ORDER,
            },
          },
    ]),
  );

  const properties: Record<string, object> = {
    id: { type: 'keyword' },
    ...Object.fromEntries(Object.entries(fields).map(([name, declaration]) => [name, mappingFor(declaration)])),
  };

  const bulk = async (operations: object[], tolerated: number[] = []) => {
    if (operations.length === 0) {
      return;
    }

    const { body } = await client.bulk({ body: operations, refresh: true });
    const failure = (body.items as BulkItem[])
      .map((item) => Object.values(item)[0])
      .find(({ error, status }) => error && !tolerated.includes(status));
    if (failure?.error) {
      const { _id, error } = failure;
      throw new Error(`Search document "${_id}" failed in index "${indexName}": ${error.type}: ${error.reason}`);
    }
  };

  return {
    capabilities,

    search: async (request: SearchRequest): Promise<SearchResult> => {
      const { boundingBox, geohashPrecision } = request;
      const filter: QueryContainer[] = [
        ...Object.entries(request.filters.terms).map(([name, values]) => ({ terms: { [exactField(name)]: values } })),
        ...Object.entries(request.filters.ranges).map(([name, ranges]) => ({
          bool: {
            should: ranges.map(({ gte, lte }) => ({
              range: { [name]: { gte: toOpenSearchBound(gte), lte: toOpenSearchBound(lte) } },
            })),
            minimum_should_match: 1,
          },
        })),
        ...(geoField && boundingBox ? [{ geo_bounding_box: { [geoField]: geoBox(boundingBox) } }] : []),
        request.visibility as QueryContainer,
      ];
      const geohashGrid: Search_RequestBody['aggs'] =
        geoField && geohashPrecision !== undefined
          ? { [GEOHASH_GRID]: { geohash_grid: { field: geoField, precision: geohashPrecision } } }
          : {};

      let response: Search_Response;
      try {
        response = await client.search({
          index: indexName,
          body: {
            query: { bool: { must: [queryFor(request)], filter } },
            aggs: { ...aggregations, ...geohashGrid },
            highlight,
            sort: sortFor(request),
            from: request.offset,
            size: request.limit,
            track_total_hits: true,
            _source: false,
          },
        });
      } catch (error) {
        const { statusCode, message } = error as Error & { statusCode?: number };
        if (statusCode === 400) {
          throw new SearchQueryError(message);
        }

        throw error;
      }

      const { hits, aggregations: buckets = {} } = response.body;

      return {
        total: (hits.total as { value: number }).value,
        hits: hits.hits.map(({ _id, _score, highlight: highlighted }) => {
          const searchExtra = {
            ...(typeof _score === 'number' && { score: _score }),
            ...(highlighted && Object.keys(highlighted).length > 0 && { highlight: highlighted }),
          };

          return { id: _id as string, ...(Object.keys(searchExtra).length > 0 && { searchExtra }) };
        }),
        facets: Object.fromEntries(
          facets.map(([name]) => [
            name,
            (buckets[name] as { buckets: TermsBucket[] }).buckets.map(
              ({ key, key_as_string, doc_count }): FacetBucket => ({
                name: key_as_string ?? String(key),
                count: doc_count,
              }),
            ),
          ]),
        ),
        ...(GEOHASH_GRID in buckets && {
          geohashGrid: Object.fromEntries(
            (buckets[GEOHASH_GRID] as { buckets: TermsBucket[] }).buckets.map(({ key, doc_count }) => [key, doc_count]),
          ),
        }),
      };
    },

    /**
     * Create the index with a mapping built from the field declarations
     * Does nothing if it exists with that mapping, and throws, naming the field, if it exists with another
     */
    createIndex: async () => {
      const { body: exists } = await client.indices.exists({ index: indexName });
      if (!exists) {
        await client.indices.create({ index: indexName, body: { mappings: { dynamic: 'strict', properties } } });

        return;
      }

      const { body } = await client.indices.getMapping({ index: indexName });
      const existing = (body[indexName].mappings.properties ?? {}) as Record<string, unknown>;
      const differing = [...new Set([...Object.keys(properties), ...Object.keys(existing)])].find(
        (name) => !isDeepStrictEqual(properties[name], existing[name]),
      );
      if (differing) {
        throw new Error(
          `Index "${indexName}" exists with a different mapping for field "${differing}" than its declaration: ` +
            `${JSON.stringify(existing[differing] ?? null)} instead of ${JSON.stringify(properties[differing] ?? null)}`,
        );
      }
    },

    /**
     * Upsert search documents, replacing any already indexed with the same id
     */
    index: async (docs: SearchDocument<Fields>[]) => {
      const stored = storeDocuments(fields, docs);

      await bulk(
        stored.flatMap(({ id, values }) => {
          const point = geoField && values[geoField];
          const source = point ? { ...values, [geoField]: toGeoPoint(point) } : values;

          return [{ index: { _index: indexName, _id: id } }, { id, ...source }];
        }),
      );
    },

    /**
     * Remove search documents, ignoring ids that aren't indexed
     */
    remove: async (ids: string[]) => {
      await bulk(
        ids.map((id) => ({ delete: { _index: indexName, _id: id } })),
        [404],
      );
    },
  };
};

const toGeoPoint = (point: unknown) => {
  const { lat, lng } = point as { lat: number; lng: number };

  return { lat, lon: lng };
};
