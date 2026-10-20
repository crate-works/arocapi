import { capabilitiesFromFields, type SearchBackend, SearchQueryError } from 'arocapi';

type Doc = { id: string; name: string; inLanguage: string[] };

// A read-only backend over a fixed list, for illustration
declare const catalogue: Doc[];

const fields = {
  name: { type: 'text', sort: true },
  inLanguage: { type: 'keyword', facet: true, label: 'Language' },
} as const;

export const listBackend: SearchBackend = {
  capabilities: capabilitiesFromFields(fields),

  search: async (request) => {
    if (request.searchType !== 'basic') {
      throw new SearchQueryError('Only basic search is supported');
    }

    const words = request.query.toLowerCase().split(/\s+/).filter(Boolean);
    const languages = request.filters.terms.inLanguage;
    const matches = catalogue
      .filter(({ name }) => words.every((word) => name.toLowerCase().includes(word)))
      .filter(({ inLanguage }) => !languages || inLanguage.some((language) => languages.includes(language)));

    const sorted =
      request.sort === 'name'
        ? matches.toSorted((a, b) => a.name.localeCompare(b.name) * (request.order === 'asc' ? 1 : -1))
        : matches.toSorted((a, b) => a.id.localeCompare(b.id));

    const counts = new Map<string, number>();
    for (const language of matches.flatMap(({ inLanguage }) => inLanguage)) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }

    return {
      total: matches.length,
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
