import { spawn } from 'child_process';
import { readFileSync, mkdirSync } from 'fs';
import path from 'path';
import { prisma, REPO_ROOT, getProductionModel } from '@autocode/db';
import type { TeacherResult } from '@autocode/types';
import { PY_DIR, pythonBin } from './python';

/**
 * Run the heavy teacher model over a whole video, then ingest its frames as
 * source='teacher' Labels (yellow boxes in the UI) and its event proposals
 * as source='teacher' EventAnnotations. Uses fine-tuned teacher weights once
 * a teacher training run has produced them; COCO-pretrained until then.
 */
export async function predictTeacher(
  videoId: string,
  opts: { maxFrames?: number; stride?: number; model?: string } = {},
): Promise<{ frames: number; events: number }> {
  const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
  await prisma.video.update({ where: { id: videoId }, data: { status: 'auto_labeling' } });

  const outDir = path.join(REPO_ROOT, 'data/teacher/runs');
  mkdirSync(outDir, { recursive: true });
  const outJson = path.join(outDir, `${videoId}.json`);

  const teacherModel = await getProductionModel('teacher');
  const args = [path.join(PY_DIR, 'teacher.py'), video.path, outJson];
  if (teacherModel) args.push('--weights', teacherModel.weightsPath);
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxFrames) args.push('--max-frames', String(opts.maxFrames));
  if (opts.stride) args.push('--stride', String(opts.stride));

  await new Promise<void>((resolve, reject) => {
    const p = spawn(pythonBin(), args, { cwd: PY_DIR });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`teacher.py exited ${code}\n${err.slice(-2000)}`)),
    );
  });

  const result: TeacherResult = JSON.parse(readFileSync(outJson, 'utf8'));

  // real fps/dims come from the decoder, not the upload heuristic
  await prisma.video.update({
    where: { id: videoId },
    data: { fps: result.fps, width: result.width, height: result.height, frames: result.frameCount },
  });

  await prisma.$transaction([
    prisma.label.deleteMany({ where: { videoId, source: 'teacher' } }),
    prisma.eventAnnotation.deleteMany({ where: { videoId, source: 'teacher' } }),
  ]);

  const CHUNK = 500;
  for (let i = 0; i < result.frames.length; i += CHUNK) {
    await prisma.label.createMany({
      data: result.frames.slice(i, i + CHUNK).map((f) => ({
        videoId,
        frameNumber: f.frameNumber,
        objects: JSON.stringify(f.objects),
        source: 'teacher',
        minConfidence: f.objects.length
          ? Math.min(...f.objects.map((o) => o.confidence ?? 1))
          : null,
      })),
    });
  }
  if (result.events.length) {
    await prisma.eventAnnotation.createMany({
      data: result.events.map((e: any) => ({
        videoId,
        type: e.type,
        keyFrame: e.keyFrame,
        startFrame: e.payload.startFrame ?? e.payload.gatherFrame ?? null,
        endFrame: e.payload.endFrame ?? null,
        payload: JSON.stringify(e.payload),
        features: e.features ? JSON.stringify(e.features) : null,
        source: 'teacher',
        confidence: e.confidence,
      })),
    });
  }

  await prisma.video.update({ where: { id: videoId }, data: { status: 'auto_labeled' } });
  return { frames: result.frames.length, events: result.events.length };
}
