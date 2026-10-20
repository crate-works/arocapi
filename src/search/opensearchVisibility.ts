import type { QueryContainer } from '@opensearch-project/opensearch/api/_types/_common.query_dsl.js';
import { toWire } from './fields.js';
import type { VisibilityCondition } from './visibility.js';

/**
 * Translate a checked search visibility filter to an OpenSearch filter, comparing each field's exact form
 */
export const visibilityQuery = (
  condition: VisibilityCondition,
  exactField: (name: string) => string,
): QueryContainer => {
  const translate = (node: VisibilityCondition): QueryContainer => {
    switch (node.type) {
      case 'and':
        return { bool: { filter: node.clauses.map(translate) } };
      case 'or':
        return node.clauses.length === 0
          ? { match_none: {} }
          : { bool: { should: node.clauses.map(translate), minimum_should_match: 1 } };
      case 'not':
        return { bool: { must_not: [translate(node.clause)] } };
      case 'in':
        return { terms: { [exactField(node.field)]: node.values.map(toWire) } };
      case 'present':
        return { exists: { field: node.field } };
      case 'range':
        return {
          range: {
            [node.field]: Object.fromEntries(
              Object.entries(node.bounds).map(([bound, value]) => [bound, toWire(value)]),
            ),
          },
        };
    }
  };

  return translate(condition);
};
