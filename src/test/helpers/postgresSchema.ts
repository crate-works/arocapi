import { readdir, readFile } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

const migrations = new URL('../../../prisma/migrations/', import.meta.url);

/**
 * A Prisma client on a fresh Postgres schema with the migrations applied, so a test file's rows can't collide with
 * another file's running at the same time
 */
export const isolatedPrisma = async (schema: string) => {
  const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:password@localhost:5433/catalog_test';
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}`, max: 5 }, { schema }),
  });

  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);

  const names = (await readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  for (const name of names) {
    await prisma.$executeRawUnsafe(await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8'));
  }

  return {
    prisma,
    drop: async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await prisma.$disconnect();
    },
  };
};
