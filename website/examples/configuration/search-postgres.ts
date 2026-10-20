import { PrismaPg } from '@prisma/adapter-pg';
import { type FieldDeclarations, PostgresBackend } from 'arocapi';
import { PrismaClient } from './generated/prisma/client.ts';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const fields = {
  name: { type: 'text', weight: 3, sort: true, label: 'Name' },
  description: { type: 'text' },
  inLanguage: { type: 'keyword', facet: { size: 500 }, label: 'Language' },
  draft: { type: 'boolean' },
} satisfies FieldDeclarations;

export const search = PostgresBackend({ prisma, fields });

// The search document commits, or rolls back, with its entity
await prisma.$transaction(async (tx) => {
  await tx.entity.create({
    data: {
      id: 'https://example.org/collection',
      name: 'Songs from the coast',
      description: 'Recordings made in 1971',
      entityType: 'http://pcdm.org/models#Collection',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
    },
  });
  await search.index(
    [{ id: 'https://example.org/collection', name: 'Songs from the coast', inLanguage: ['eng', 'nys'], draft: false }],
    { tx },
  );
});
