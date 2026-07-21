import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@autocode/db';

export const dynamic = 'force-dynamic';

// Save human labels: creates a LabelVersion snapshot, upserts source='human'
// Label rows for edited frames, replaces human events.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json() as {
    note?: string;
    frames: { frameNumber: number; objects: unknown[] }[];
    events: {
      type: string; keyFrame: number; startFrame?: number | null; endFrame?: number | null;
      payload: Record<string, unknown>; features?: Record<string, unknown> | null;
    }[];
  };

  const version = await prisma.labelVersion.create({
    data: { videoId: id, note: body.note ?? `save ${new Date().toISOString()}` },
  });

  for (const f of body.frames) {
    await prisma.label.upsert({
      where: { videoId_frameNumber_source: { videoId: id, frameNumber: f.frameNumber, source: 'human' } },
      create: {
        videoId: id, frameNumber: f.frameNumber, source: 'human',
        objects: JSON.stringify(f.objects), versionId: version.id, isApproved: false,
      },
      update: { objects: JSON.stringify(f.objects), versionId: version.id, isApproved: false, usedInTraining: false },
    });
  }

  await prisma.eventAnnotation.deleteMany({ where: { videoId: id, source: 'human' } });
  if (body.events.length) {
    await prisma.eventAnnotation.createMany({
      data: body.events.map((e) => ({
        videoId: id, type: e.type, keyFrame: e.keyFrame,
        startFrame: e.startFrame ?? null, endFrame: e.endFrame ?? null,
        payload: JSON.stringify(e.payload),
        features: e.features ? JSON.stringify(e.features) : null,
        source: 'human',
      })),
    });
  }

  await prisma.video.update({ where: { id }, data: { status: 'in_review' } });
  return NextResponse.json({ ok: true, versionId: version.id, frames: body.frames.length, events: body.events.length });
}
