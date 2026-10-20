import { sqltag as sql } from '@prisma/client/runtime/client';
import { fieldValue, valuesOf } from './postgresValues.js';

/**
 * A facet's buckets over the `matched` rows: the `size` commonest values, most matches first
 */
export const valueBuckets = (name: string, size: number) => sql`(
  SELECT coalesce(jsonb_agg(
    jsonb_build_object('name', bucket.name, 'count', bucket.count) ORDER BY bucket.count DESC, bucket.name COLLATE "C"
  ), '[]')
  FROM (
    SELECT value.name, count(*)::int AS count
    FROM matched AS search, LATERAL (SELECT DISTINCT field.value AS name FROM ${valuesOf(name)}) AS value
    GROUP BY value.name
    ORDER BY count DESC, value.name COLLATE "C"
    LIMIT ${size}::int
  ) AS bucket
)`;

/**
 * A date facet's buckets over the `matched` rows: one per UTC year with matches, named `YYYY`, in year order
 */
export const yearBuckets = (name: string) => sql`(
  SELECT coalesce(jsonb_agg(
    jsonb_build_object('name', to_char(bucket.year, 'YYYY'), 'count', bucket.count) ORDER BY bucket.year
  ), '[]')
  FROM (
    SELECT value.year, count(*)::int AS count
    FROM matched AS search, LATERAL (
      SELECT DISTINCT date_trunc('year', ${fieldValue('date')} AT TIME ZONE 'UTC') AS year FROM ${valuesOf(name)}
    ) AS value
    GROUP BY value.year
  ) AS bucket
)`;
