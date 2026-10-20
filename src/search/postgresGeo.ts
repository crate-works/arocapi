import { type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import type { BoundingBox } from './backend.js';

/**
 * A condition that the `search` row's point lies in the box, which may cross the antimeridian
 */
export const boundingBoxCondition = ({ topRight, bottomLeft }: BoundingBox): Sql => {
  const box = (west: number, east: number) =>
    sql`search.point <@ box(point(${west}::float8, ${bottomLeft.lat}::float8), point(${east}::float8, ${topRight.lat}::float8))`;

  return bottomLeft.lng <= topRight.lng
    ? box(bottomLeft.lng, topRight.lng)
    : sql`(${box(bottomLeft.lng, 180)} OR ${box(-180, topRight.lng)})`;
};

/**
 * Counts of the `matched` rows with a point, per geohash cell of `precision` characters
 */
export const geohashGrid = (precision: number) => sql`(
  SELECT coalesce(jsonb_object_agg(cell.geohash, cell.count), '{}')
  FROM (
    SELECT left(search.geohash, ${precision}::int) AS geohash, count(*)::int AS count
    FROM matched AS search
    WHERE search.geohash IS NOT NULL
    GROUP BY 1
  ) AS cell
)`;
