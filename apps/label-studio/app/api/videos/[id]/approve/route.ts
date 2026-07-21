import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@autocode/db';

export const dynamic = 'force-dynamic';

// "Approved for training": human rows approved outright; teacher rows approved
// only for frames the human left untouched (reviewed-and-accepted yellow boxes).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { approved } = await req.json() as { approved: boolean };

  if (!approved) {
    await prisma.label.updateMany({ where: { videoId: id }, data: { isApproved: false } });
    await prisma.eventAnnotation.updateMany({ where: { videoId: id }, data: { isApproved: false } });
    await prisma.video.update({ where: { id }, data: { status: 'in_review' } });
    return NextResponse.json({ ok: true, approved: false });
  }

  const humanFrames = await prisma.label.findMany({
    where: { videoId: id, source: 'human' },
    select: { frameNumber: true },
  });
  const humanSet = humanFrames.map((f) => f.frameNumber);

  await prisma.label.updateMany({ where: { videoId: id, source: 'human' }, data: { isApproved: true } });
  await prisma.label.updateMany({
    where: { videoId: id, source: 'teacher', frameNumber: { notIn: humanSet } },
    data: { isApproved: true },
  });
  await prisma.eventAnnotation.updateMany({ where: { videoId: id, source: 'human' }, data: { isApproved: true } });
  await prisma.video.update({ where: { id }, data: { status: 'approved' } });

  const count = await prisma.label.count({ where: { isApproved: true, usedInTraining: false } });
  return NextResponse.json({ ok: true, approved: true, newApprovedLabels: count });
}
