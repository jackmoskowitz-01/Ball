import { NextResponse } from 'next/server';
import { prisma } from '@autocode/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const jobs = await prisma.trainingJob.findMany({
    orderBy: { createdAt: 'desc' }, take: 20,
    include: { datasetVersion: true, models: true },
  });
  const models = await prisma.modelVersion.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  return NextResponse.json({ jobs, models });
}
