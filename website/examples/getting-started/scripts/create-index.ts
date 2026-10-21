import { opensearch, search } from '../src/search.ts';

await search.createIndex();
await opensearch.close();
