import { PrismaPg } from '@prisma/adapter-pg';
import type { Options } from 'arocapi';
import { PrismaClient } from './generated/prisma/client.ts';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

export const dataSources: Pick<Options, 'prisma'> = { prisma };
