import { isDeepStrictEqual } from 'node:util';
import type { Client } from '@opensearch-project/opensearch';
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
  const geoField = Object.keys(fields).find((name) => fields[name].type === 'geo');

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
