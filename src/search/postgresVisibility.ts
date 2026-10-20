import { join, type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import type { FieldDeclarations } from './fields.js';
import { fieldValue, parameter, valuesOf } from './postgresValues.js';
import type { VisibilityCondition } from './visibility.js';

const OPERATORS = { lt: sql`<`, lte: sql`<=`, gt: sql`>`, gte: sql`>=` };

/**
 * Translate a checked search visibility filter to a parameterised SQL condition on the `search` row
 */
export const visibilityCondition = (condition: VisibilityCondition, fields: FieldDeclarations): Sql => {
  const typeOf = (field: string) => (field === 'id' ? 'keyword' : fields[field].type);

  const translate = (node: VisibilityCondition): Sql => {
    switch (node.type) {
      case 'and':
        return sql`(${join([sql`TRUE`, ...node.clauses.map(translate)], ' AND ')})`;
      case 'or':
        return sql`(${join([sql`FALSE`, ...node.clauses.map(translate)], ' OR ')})`;
      case 'not':
        return sql`NOT ${translate(node.clause)}`;
      case 'present':
        return sql`EXISTS (SELECT FROM ${valuesOf(node.field)})`;
      case 'in': {
        const type = typeOf(node.field);
        const values = node.values.map((value) => parameter(type, value));

        return sql`EXISTS (
          SELECT FROM ${valuesOf(node.field)}
          WHERE ${fieldValue(type)} IN (${join([sql`NULL`, ...values])})
        )`;
      }
      case 'range': {
        const type = typeOf(node.field);
        const bounds = Object.entries(node.bounds).map(
          ([bound, value]) =>
            sql`${fieldValue(type)} ${OPERATORS[bound as keyof typeof OPERATORS]} ${parameter(type, value)}`,
        );

        return sql`EXISTS (SELECT FROM ${valuesOf(node.field)} WHERE ${join(bounds, ' AND ')})`;
      }
    }
  };

  return translate(condition);
};
