/**
 * The Prisma client singleton. One instance shared by the whole app.
 *
 * Reused across hot reloads in dev, so `next dev` doesn't open a new
 * connection pool on every file edit — a fresh `PrismaClient` per HMR pass
 * exhausts Postgres's connection limit within a few dozen saves.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export * from '@prisma/client';
