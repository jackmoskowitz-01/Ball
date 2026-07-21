import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { prisma, REPO_ROOT } from '@autocode/db';
import { predictTeacher } from '@autocode/cv';

export const dynamic = 'force-dynamic';

export async function GET() {
  const videos = await prisma.video.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { labels: true, events: true } } },
  });
  return NextResponse.json(videos);
}

// Upload -> probe -> create row -> kick teacher auto-label in background.
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'no file' }, { status: 400 });

  const dir = path.join(REPO_ROOT, 'data/videos');
  mkdirSync(dir, { recursive: true });
  const safe = file.name.replace(/[^\w.-]+/g, '_');
  const dest = path.join(dir, `${Date.now()}_${safe}`);
  writeFileSync(dest, Buffer.from(await file.arrayBuffer()));

  let fps = 30, width = 1920, height = 1080, frames = 0;
  try {
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams',
      '-select_streams', 'v:0', dest,
    ]).toString());
    const s = probe.streams[0];
    const [num, den] = (s.avg_frame_rate ?? '30/1').split('/').map(Number);
    fps = den ? num / den : 30;
    width = s.width; height = s.height;
    frames = Number(s.nb_frames) || Math.round(fps * Number(s.duration ?? 0));
  } catch { /* teacher.py overwrites with decoder truth anyway */ }

  const video = await prisma.video.create({
    data: { name: safe, path: dest, fps, width, height, frames },
  });

  predictTeacher(video.id).catch(async (e) => {
    console.error('teacher failed', e);
    await prisma.video.update({ where: { id: video.id }, data: { status: 'uploaded' } });
  });

  return NextResponse.json(video);
}
