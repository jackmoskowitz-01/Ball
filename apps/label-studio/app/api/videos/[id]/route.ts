import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@autocode/db';

export const dynamic = 'force-dynamic';

// Video meta + merged labels (human beats teacher per frame) + all events.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const labels = await prisma.label.findMany({ where: { videoId: id } });
  const merged: Record<number, { objects: string; source: string; isApproved: boolean }> = {};
  for (const l of labels) {
    if (!merged[l.frameNumber] || l.source === 'human') {
      merged[l.frameNumber] = { objects: l.objects, source: l.source, isApproved: l.isApproved };
    }
  }
  const events = await prisma.eventAnnotation.findMany({
    where: { videoId: id },
    orderBy: { keyFrame: 'asc' },
  });
  return NextResponse.json({
    video,
    frames: Object.entries(merged).map(([f, v]) => ({
      frameNumber: Number(f),
      objects: JSON.parse(v.objects),
      source: v.source,
      isApproved: v.isApproved,
    })),
    events: events.map((e) => ({
      ...e,
      payload: JSON.parse(e.payload),
      features: e.features ? JSON.parse(e.features) : null,
    })),
  });
}
