import { join, type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import { type FieldDeclarations, type FieldType, type Scalar, toWire } from '../fields.js';
import type { VisibilityCondition } from '../visibility.js';
import { fieldValue, parameter, valuesOf, valuesPath } from './values.js';

const OPERATORS = { lt: sql`<`, lte: sql`<=`, gt: sql`>`, gte: sql`>=` };

// Boolean filter values arrive as text
const literal = (type: FieldType, value: Scalar) =>
  JSON.stringify(type === 'boolean' && (value === 'true' || value === 'false') ? value === 'true' : toWire(value));

/**
 * Translate a checked search visibility filter to a parameterised SQL condition on the `search` row
 * Equality is JSON path containment, so the `values` index can serve it
 */
export const visibilityCondition = (condition: VisibilityCondition, fields: FieldDeclarations): Sql => {
  const translate = (node: VisibilityCondition): Sql => {
    switch (node.type) {
      case 'and':
        return sql`(${join([sql`TRUE`, ...node.clauses.map(translate)], ' AND ')})`;
      case 'or':
        return sql`(${join([sql`FALSE`, ...node.clauses.map(translate)], ' OR ')})`;
      case 'not':
        return sql`NOT ${translate(node.clause)}`;
      case 'present':
        return node.field === 'id' ? sql`TRUE` : sql`search."values" @? ${valuesPath(node.field)}::jsonpath`;
      case 'in': {
        const { field, values } = node;
        if (field === 'id') {
          return sql`search.id = ANY(${values.map(String)}::text[])`;
        }
        if (values.length === 0) {
          return sql`FALSE`;
        }

        const { type } = fields[field];
        const equals = values.map((value) => `@ == ${literal(type, value)}`).join(' || ');

        return sql`search."values" @? ${`${valuesPath(field)} ? (${equals})`}::jsonpath`;
      }
      case 'range': {
        const { type } = fields[node.field];
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
