import { type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import type { FieldType } from './fields.js';

/**
 * A `FROM` item of a search row's values for a field, as `field.value` text: none when missing, one per array item
 */
export const valuesOf = (field: string) =>
  field === 'id'
    ? sql`LATERAL (SELECT search.id AS value) AS field`
    : sql`LATERAL (SELECT jsonb_path_query(search."values", ${`$."${field}"[*]`}::jsonpath) #>> '{}' AS value) AS field`;

/**
 * Text as the field's type, comparing as OpenSearch does: strings in code point order
 */
export const typed = (type: FieldType, text: Sql) => {
  switch (type) {
    case 'number':
      return sql`(${text})::float8`;
    case 'date':
      return sql`(${text})::timestamptz`;
    case 'boolean':
      return sql`(${text})::boolean`;
    default:
      return sql`(${text}) COLLATE "C"`;
  }
};

export const fieldValue = (type: FieldType) => typed(type, sql`field.value`);

export const parameter = (type: FieldType, value: string | number | boolean | Date) =>
  typed(type, sql`${value instanceof Date ? value.toISOString() : String(value)}::text`);
