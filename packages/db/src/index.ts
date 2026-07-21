import { PrismaClient } from '@prisma/client';
import { existsSync } from 'fs';
import path from 'path';

// Resolve the sqlite file absolutely so every consumer (either Next app, CLI
// scripts, python via the same file) hits the same DB regardless of cwd.
// __dirname is unreliable under Next's bundler, so walk up from cwd to the
// monorepo root (marked by turbo.json). AUTOCODE_ROOT overrides.
function findRepoRoot(): string {
  if (process.env.AUTOCODE_ROOT) return process.env.AUTOCODE_ROOT;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'turbo.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

const dbFile = path.join(findRepoRoot(), 'data/ball.db');
process.env.DATABASE_URL = process.env.DATABASE_URL ?? `file:${dbFile}`;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export const DB_FILE = dbFile;
export const REPO_ROOT = findRepoRoot();

/** Latest production model of a type; falls back to latest ready. */
export async function getProductionModel(type: 'student' | 'teacher' | 'event') {
  const prod = await prisma.modelVersion.findFirst({
    where: { type, status: 'production' },
    orderBy: { version: 'desc' },
  });
  if (prod) return prod;
  return prisma.modelVersion.findFirst({
    where: { type, status: 'ready' },
    orderBy: { version: 'desc' },
  });
}
