import type { QueryContainer } from '@opensearch-project/opensearch/api/_types/_common.query_dsl.js';
import type { AdvancedQuery } from './backend.js';
import type { FieldDeclarations } from './fields.js';

/**
 * Translate an advanced query tree to OpenSearch DSL: text matches all words or the phrase, other types match exactly
 */
export const advancedQueryFor = (query: AdvancedQuery, fields: FieldDeclarations): QueryContainer => {
  switch (query.type) {
    case 'and':
      return { bool: { must: query.clauses.map((clause) => advancedQueryFor(clause, fields)) } };
    case 'or':
      return {
        bool: { should: query.clauses.map((clause) => advancedQueryFor(clause, fields)), minimum_should_match: 1 },
      };
    case 'not':
      return { bool: { must_not: [advancedQueryFor(query.clause, fields)] } };
    case 'match': {
      const { field, value, phrase } = query;
      if (fields[field].type !== 'text') {
        return { term: { [field]: value } };
      }

      return phrase ? { match_phrase: { [field]: value } } : { match: { [field]: { query: value, operator: 'and' } } };
    }
    default:
      return { match_all: {} };
  }
};
