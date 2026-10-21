import type { SearchVisibilityFilter } from 'arocapi';

const fields = {
  name: { type: 'text' },
  draft: { type: 'boolean' },
} as const;

// Also matches entities with no draft flag
export const searchVisibilityFilter: SearchVisibilityFilter<typeof fields> = () => ({ draft: { not: true } });
