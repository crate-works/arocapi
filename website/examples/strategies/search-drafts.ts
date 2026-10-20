import type { SearchVisibilityFilter } from 'arocapi';

export const searchVisibilityFilter: SearchVisibilityFilter = () => ({
  bool: { must_not: { term: { draft: true } } },
});
