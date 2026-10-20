import { join, type Sql, sqltag as sql } from '@prisma/client/runtime/client';
import { type AdvancedQuery, SearchQueryError } from './backend.js';
import { type FieldDeclarations, parseDate } from './fields.js';
import { fieldValue, parameter, valuesOf } from './postgresValues.js';

// A tsquery's lexemes as text: single-quoted, with quotes doubled
const LEXEME = "'((?:[^']|'')*)'";

const exactValue = (field: string, type: string, value: string) => {
  switch (type) {
    case 'boolean':
      if (value !== 'true' && value !== 'false') {
        throw new SearchQueryError(`"${field}" is a boolean field: "${value}" isn't true or false`);
      }

      return value === 'true';
    case 'date': {
      const date = parseDate(value);
      if (!date) {
        throw new SearchQueryError(`"${field}" is a date field: "${value}" isn't a date`);
      }

      return date;
    }
    default:
      return value;
  }
};

/**
 * Translate an advanced query tree to a SQL condition on the `search` row, and a rank over its positive text matches
 * Text values match on the `text` tsvector, whose lexemes are prefixed `<field>.`
 */
export const advancedQueryFor = (query: AdvancedQuery, fields: FieldDeclarations, config: Sql) => {
  const ranked: Sql[] = [];

  const tsquery = (field: string, value: string, phrase: boolean) => {
    const parsed = phrase
      ? sql`phraseto_tsquery(${config}, ${value}::text)`
      : sql`plainto_tsquery(${config}, ${value}::text)`;

    return sql`regexp_replace(${parsed}::text, ${LEXEME}::text, ${`'${field}.\\1'`}::text, 'g')::tsquery`;
  };

  const translate = (node: AdvancedQuery, negated: boolean): Sql => {
    switch (node.type) {
      case 'and':
        return sql`(${join(
          node.clauses.map((clause) => translate(clause, negated)),
          ' AND ',
        )})`;
      case 'or':
        return sql`(${join(
          node.clauses.map((clause) => translate(clause, negated)),
          ' OR ',
        )})`;
      case 'not':
        return sql`NOT ${translate(node.clause, !negated)}`;
      case 'match': {
        const { field, value, phrase } = node;
        const { type } = fields[field];
        if (type === 'text') {
          const matching = tsquery(field, value, phrase);
          if (!negated) {
            ranked.push(matching);
          }

          return sql`search.text @@ ${matching}`;
        }

        return sql`EXISTS (
          SELECT FROM ${valuesOf(field)} WHERE ${fieldValue(type)} = ${parameter(type, exactValue(field, type, value))}
        )`;
      }
      default:
        return sql`TRUE`;
    }
  };

  const condition = translate(query, false);
  const rank = ranked.length > 0 ? sql`ts_rank(search.text, ${join(ranked, ' || ')})` : sql`0`;

  return { condition, rank };
};
