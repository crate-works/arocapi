import { type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import { type BoundingBox, GEOHASH_GRID_CELLS } from '../backend.js';
import type { GeoPoint } from '../fields.js';

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * A point's 12-character geohash
 */
export const geohash = ({ lat, lng }: GeoPoint) => {
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
 * Counts of the `matched` rows with a point, per geohash cell of `precision` characters (at most `GEOHASH_GRID_CELLS`, those with the most)
 */
export const geohashGrid = (precision: number) => sql`(
  SELECT coalesce(jsonb_object_agg(cell.geohash, cell.count), '{}')
  FROM (
    SELECT left(search.geohash, ${precision}::int) COLLATE "C" AS geohash, count(*)::int AS count
    FROM matched AS search
    WHERE search.geohash IS NOT NULL
    GROUP BY 1
    ORDER BY count DESC, geohash
    LIMIT ${GEOHASH_GRID_CELLS}::int
  ) AS cell
)`;
