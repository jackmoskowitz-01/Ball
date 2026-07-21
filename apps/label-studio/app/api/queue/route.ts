import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@autocode/db';
import { computeDisagreements } from '@autocode/cv';

export const dynamic = 'force-dynamic';

// Active learning queries. ?mode=
//   low_conf            — 20 frames with lowest teacher confidence (any class)
//   low_conf_ball       — 20 frames whose lowest-confidence object is the ball
//   disagreement        — frames where teacher & student disagree most (computes a batch on demand)
//   unlabeled_blocks    — teacher block proposals not yet human-confirmed
//   shots_no_shooter    — shot events missing shooterTrackingId
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') ?? 'low_conf';

  if (mode === 'disagreement') {
    const computed = await computeDisagreements(60);
    const rows = await prisma.label.findMany({
      where: { source: 'teacher', isApproved: false, disagreement: { not: null } },
      orderBy: { disagreement: 'desc' },
      take: 20,
      include: { video: { select: { name: true } } },
    });
    return NextResponse.json(rows.map((r) => ({
      kind: 'frame', videoId: r.videoId, videoName: r.video.name,
      frameNumber: r.frameNumber, confidence: r.disagreement, computed,
    })));
  }

  if (mode === 'low_conf' || mode === 'low_conf_ball') {
    const rows = await prisma.label.findMany({
      where: { source: 'teacher', isApproved: false, minConfidence: { not: null } },
      orderBy: { minConfidence: 'asc' },
      take: mode === 'low_conf_ball' ? 400 : 20,
      include: { video: { select: { name: true } } },
    });
    let out = rows;
    if (mode === 'low_conf_ball') {
      out = rows.filter((r) => {
        const objs = JSON.parse(r.objects) as { cls: string; confidence: number | null }[];
        const min = Math.min(...objs.map((o) => o.confidence ?? 1));
        return objs.some((o) => o.cls === 'ball' && (o.confidence ?? 1) === min);
      }).slice(0, 20);
    }
    return NextResponse.json(out.map((r) => ({
      kind: 'frame', videoId: r.videoId, videoName: r.video.name,
      frameNumber: r.frameNumber, confidence: r.minConfidence,
    })));
  }

  if (mode === 'unlabeled_blocks') {
    const rows = await prisma.eventAnnotation.findMany({
      where: { type: 'block', source: 'teacher', isApproved: false },
      orderBy: { confidence: 'asc' },
      include: { video: { select: { name: true } } },
    });
    return NextResponse.json(rows.map((r) => ({
      kind: 'event', videoId: r.videoId, videoName: r.video.name,
      frameNumber: r.keyFrame, type: r.type, confidence: r.confidence,
    })));
  }

  if (mode === 'shots_no_shooter') {
    const rows = await prisma.eventAnnotation.findMany({
      where: { type: 'shot' },
      include: { video: { select: { name: true } } },
    });
    const missing = rows.filter((r) => {
      const p = JSON.parse(r.payload);
      return p.shooterTrackingId === undefined || p.shooterTrackingId === null;
    });
    return NextResponse.json(missing.map((r) => ({
      kind: 'event', videoId: r.videoId, videoName: r.video.name,
      frameNumber: r.keyFrame, type: r.type, confidence: r.confidence,
    })));
  }

  return NextResponse.json({ error: 'unknown mode' }, { status: 400 });
}
