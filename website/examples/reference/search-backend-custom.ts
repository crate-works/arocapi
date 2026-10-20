import {
  capabilitiesFromFields,
  checkSearchVisibility,
  type SearchBackend,
  SearchQueryError,
  type VisibilityCondition,
} from 'arocapi';

type Doc = { id: string; name: string; inLanguage: string[] };

// A read-only backend over a fixed list, for illustration
declare const catalogue: Doc[];

const fields = {
  name: { type: 'text', sort: true },
  inLanguage: { type: 'keyword', facet: true, label: 'Language' },
} as const;

const valuesOf = (doc: Doc, field: string) => (field === 'id' ? [doc.id] : [doc[field as keyof Doc]].flat());

const matches = (condition: VisibilityCondition, doc: Doc): boolean => {
  switch (condition.type) {
    case 'and':
      return condition.clauses.every((clause) => matches(clause, doc));
    case 'or':
      return condition.clauses.some((clause) => matches(clause, doc));
    case 'not':
      return !matches(condition.clause, doc);
    case 'in':
      return valuesOf(doc, condition.field).some((value) => condition.values.includes(value));
    case 'present':
      return valuesOf(doc, condition.field).length > 0;
    case 'range':
      // Only date and number fields take ranges, and this backend declares none
      return false;
  }
};

export const listBackend: SearchBackend = {
  capabilities: capabilitiesFromFields(fields),

  search: async (request) => {
    if (request.searchType !== 'basic') {
      throw new SearchQueryError('Only basic search is supported');
    }

    // Throws, naming the field, on a filter that doesn't fit the declarations: arocapi answers 500 and logs it
    const visibility = checkSearchVisibility(fields, request.visibility);
    const languages = request.filters.terms.inLanguage;
    const words = request.query.toLowerCase().split(/\s+/).filter(Boolean);

    const hits = catalogue
      .filter((doc) => matches(visibility, doc))
      .filter(({ name }) => words.every((word) => name.toLowerCase().includes(word)))
      .filter(({ inLanguage }) => !languages || inLanguage.some((language) => languages.includes(language)));

    const sorted =
      request.sort === 'name'
        ? hits.toSorted((a, b) => a.name.localeCompare(b.name) * (request.order === 'asc' ? 1 : -1))
        : hits.toSorted((a, b) => a.id.localeCompare(b.id));

    const counts = new Map<string, number>();
    for (const language of hits.flatMap(({ inLanguage }) => inLanguage)) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }

    return {
      total: hits.length,
      hits: sorted.slice(request.offset, request.offset + request.limit).map(({ id }) => ({ id })),
      facets: {
        inLanguage: [...counts]
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      },
    };
  },

  index: async () => {
    throw new Error('This backend is read-only');
  },
  remove: async () => {
    throw new Error('This backend is read-only');
  },
};
