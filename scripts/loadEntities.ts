import 'dotenv/config';
import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import { type FieldDeclarations, OpenSearchBackend } from '../src/app.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

if (!process.env.OPENSEARCH_URL) {
  throw new Error('OPENSEARCH_URL environment variable is not set');
}

// Initialize OpenSearch client
const opensearch = new Client({
  node: process.env.OPENSEARCH_URL,
});

const INDEX_NAME = 'entities';

// Keep in step with src/index.dev.ts
const fields = {
  name: { type: 'text', weight: 2, sort: true, label: 'Name' },
  description: { type: 'text' },
  entityType: { type: 'keyword', facet: true, label: 'Type' },
  inLanguage: { type: 'keyword', facet: true, label: 'Language' },
  mediaType: { type: 'keyword', facet: true, label: 'Media type' },
  communicationMode: { type: 'keyword', facet: true, label: 'Communication mode' },
  location: { type: 'geo' },
} satisfies FieldDeclarations;
const search = OpenSearchBackend({ client: opensearch, fields, indexName: INDEX_NAME });

const BATCH_SIZE = 100;
const TOTAL_RECORDS = 1000;
const API_URL = 'https://catalog.paradisec.org.au/api/v1/oni';

interface EntityResponse {
  total: number;
  entities: {
    id: string;
    name: string;
    description: string;
    conformsTo: string;
    entityType: string;
    memberOf?: string;
    root?: string;
    // extra: Record<string, any>;
    // searchExtra: Record<string, any>;
  }[];
}

const fetchEntities = async (limit: number, offset: number) => {
  const url = `${API_URL}/entities?limit=${limit}&offset=${offset}`;
  console.log(`Fetching ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }

  const result = (await response.json()) as EntityResponse;

  return result;
};

const generateDummyData = () => {
  const languages = ['English', 'Japanese', 'French', 'Spanish', 'German', 'Italian'];
  const mediaTypes = ['audio/wav', 'audio/mp3', 'video/mp4', 'text/plain', 'image/jpeg'];
  const communicationModes = ['SpokenLanguage', 'WrittenLanguage', 'SignedLanguage', 'Song'];

  // Australian bounding box coordinates
  const lat = -25 + (Math.random() - 0.5) * 20; // -35 to -15
  const lng = 134 + (Math.random() - 0.5) * 40; // 114 to 154

  return {
    inLanguage: languages[Math.floor(Math.random() * languages.length)],
    mediaType: mediaTypes[Math.floor(Math.random() * mediaTypes.length)],
    communicationMode: communicationModes[Math.floor(Math.random() * communicationModes.length)],
    location: { lat, lng },
  };
};

const createIndex = async () => {
  console.log(`Recreating index ${INDEX_NAME}...`);
  await opensearch.indices.delete({ index: INDEX_NAME, ignore_unavailable: true });
  await search.createIndex();
};

const loadEntities = async (): Promise<void> => {
  try {
    console.log('Starting to load entities...');
    await prisma.$connect();

    await createIndex();

    let processedCount = 0;

    while (processedCount < TOTAL_RECORDS) {
      const remainingToFetch = Math.min(BATCH_SIZE, TOTAL_RECORDS - processedCount);
      const data = await fetchEntities(remainingToFetch, processedCount);

      console.log(
        `Fetched ${data.entities.length} entities (${processedCount + data.entities.length}/${TOTAL_RECORDS})`,
      );

      for (const entity of data.entities) {
        await prisma.entity.create({
          data: {
            id: entity.id,
            name: entity.name,
            description: entity.description,
            entityType: entity.entityType,
            memberOf: entity.memberOf || null,
            rootCollection: entity.root || null,
            metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
            contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          },
        });
      }

      await search.index(
        data.entities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          description: entity.description,
          entityType: entity.entityType,
          ...generateDummyData(),
        })),
      );

      processedCount += data.entities.length;
      console.log(`Processed ${processedCount}/${TOTAL_RECORDS} entities`);

      if (data.entities.length < remainingToFetch) {
        console.log('Reached the end of available entities');
        break;
      }
    }

    console.log(`Successfully loaded ${processedCount} entities into database and OpenSearch`);
  } catch (error) {
    console.error('Error loading entities:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
};

loadEntities()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
