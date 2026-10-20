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
    SELECT field.value AS name, count(DISTINCT search.id)::int AS count
    FROM matched AS search, ${valuesOf(name)}
    GROUP BY field.value
    ORDER BY count DESC, field.value COLLATE "C"
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
    SELECT date_trunc('year', ${fieldValue('date')} AT TIME ZONE 'UTC') AS year, count(DISTINCT search.id)::int AS count
    FROM matched AS search, ${valuesOf(name)}
    GROUP BY year
  ) AS bucket
)`;
