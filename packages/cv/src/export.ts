import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'fs';
import path from 'path';
import { prisma, REPO_ROOT } from '@autocode/db';
import type { ObjectAnnotation, EventSample } from '@autocode/types';
import { CLASSES, CLASS_IDS, EVENT_TYPE_TO_CLASS, toDetectorClass } from './classes';

const FRAMES_DIR = path.join(REPO_ROOT, 'data/frames');
const TEACHER_DIR = path.join(REPO_ROOT, 'data/teacher');
const REALTIME_DIR = path.join(REPO_ROOT, 'data/realtime');

/** Extract specific frames of a video into data/frames/{videoId}/f{n}.jpg (cached). */
export function extractFrames(videoPath: string, videoId: string, frameNumbers: number[], fps: number) {
  const dir = path.join(FRAMES_DIR, videoId);
  mkdirSync(dir, { recursive: true });
  const missing = [...new Set(frameNumbers)]
    .sort((a, b) => a - b)
    .filter((n) => !existsSync(path.join(dir, `f${n}.jpg`)));

  // one accurate seek per frame: -ss before -i is keyframe-fast, then decodes
  // to the exact timestamp; mid-frame time avoids landing on n-1
  for (const n of missing) {
    execFileSync('ffmpeg', [
      '-y', '-ss', ((n + 0.5) / fps).toFixed(5), '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', path.join(dir, `f${n}.jpg`),
    ], { stdio: 'pipe' });
  }
  return (n: number) => path.join(dir, `f${n}.jpg`);
}

function polyBBox(o: ObjectAnnotation) {
  if (o.polygon && o.polygon.length >= 3) {
    const xs = o.polygon.map((p) => p.x);
    const ys = o.polygon.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

/**
 * Build every training artifact from the approved labels:
 *   a) data/teacher/coco.json           — full COCO, all classes, court as segmentation
 *   b) data/realtime/{data.yaml,images,labels} — YOLO detect dataset, all object classes
 *   c) data/realtime/events.jsonl       — one line per event keyframe with features
 * Val split: videos flagged holdout -> val; otherwise every 5th frame.
 */
export async function exportDatasets() {
  const labels = await prisma.label.findMany({
    where: { isApproved: true },
    include: { video: true },
  });
  const events = await prisma.eventAnnotation.findMany({
    where: { isApproved: true },
    include: { video: true },
  });

  for (const sub of ['images/train', 'images/val', 'labels/train', 'labels/val']) {
    rmSync(path.join(REALTIME_DIR, sub), { recursive: true, force: true });
    mkdirSync(path.join(REALTIME_DIR, sub), { recursive: true });
  }
  mkdirSync(TEACHER_DIR, { recursive: true });

  // frames needed per video: labeled frames + event keyframes
  const byVideo = new Map<string, { video: any; frames: Set<number> }>();
  for (const l of labels) {
    const e = byVideo.get(l.videoId) ?? { video: l.video, frames: new Set<number>() };
    e.frames.add(l.frameNumber);
    byVideo.set(l.videoId, e);
  }
  for (const ev of events) {
    const e = byVideo.get(ev.videoId) ?? { video: ev.video, frames: new Set<number>() };
    e.frames.add(ev.keyFrame);
    byVideo.set(ev.videoId, e);
  }
  const framePathOf = new Map<string, (n: number) => string>();
  for (const [vid, { video, frames }] of byVideo) {
    framePathOf.set(vid, extractFrames(video.path, vid, [...frames], video.fps));
  }

  const classCounts: Record<string, number> = {};
  const bump = (c: string) => { classCounts[c] = (classCounts[c] ?? 0) + 1; };

  // ---- COCO + YOLO ----
  const cocoImages: any[] = [];
  const cocoAnns: any[] = [];
  let imgId = 0, annId = 0;

  for (const l of labels) {
    const objects: ObjectAnnotation[] = JSON.parse(l.objects);
    const src = framePathOf.get(l.videoId)!(l.frameNumber);
    if (!existsSync(src)) continue;
    const { width: W, height: H } = l.video;
    const split = l.video.holdout ? 'val' : l.frameNumber % 5 === 0 ? 'val' : 'train';
    const stem = `${l.videoId}_f${l.frameNumber}`;

    imgId++;
    cocoImages.push({ id: imgId, file_name: src, width: W, height: H });

    const yoloLines: string[] = [];
    for (const o of objects) {
      if (o.visible === false) continue;
      const det = toDetectorClass(o.cls);
      if (!det) continue;
      const bb = polyBBox(o);
      if (bb.w <= 1 || bb.h <= 1) continue;
      bump(det);
      annId++;
      cocoAnns.push({
        id: annId, image_id: imgId, category_id: CLASS_IDS[det],
        bbox: [bb.x, bb.y, bb.w, bb.h], area: bb.w * bb.h, iscrowd: 0,
        attributes: {
          trackingId: o.trackingId, occluded: o.occluded, blurry: o.blurry,
          jerseyNumber: o.jerseyNumber, vx: o.vx, vy: o.vy,
          polygonKind: o.polygonKind ?? null,
        },
        segmentation: o.polygon ? [o.polygon.flatMap((p) => [p.x, p.y])] : undefined,
      });
      const cx = (bb.x + bb.w / 2) / W, cy = (bb.y + bb.h / 2) / H;
      yoloLines.push(
        `${CLASS_IDS[det]} ${cx.toFixed(6)} ${cy.toFixed(6)} ${(bb.w / W).toFixed(6)} ${(bb.h / H).toFixed(6)}`,
      );
    }
    if (!yoloLines.length) continue;
    copyFileSync(src, path.join(REALTIME_DIR, `images/${split}/${stem}.jpg`));
    writeFileSync(path.join(REALTIME_DIR, `labels/${split}/${stem}.txt`), yoloLines.join('\n') + '\n');
    // ball frames are rare and the ball is tiny — duplicate them in train so
    // the weak class gets ~2x gradient (never duplicate val: it would skew eval)
    const hasVisibleBall = objects.some((o) => o.cls === 'ball' && o.visible !== false && !o.occluded);
    if (split === 'train' && hasVisibleBall) {
      copyFileSync(src, path.join(REALTIME_DIR, `images/train/${stem}_ball2.jpg`));
      writeFileSync(path.join(REALTIME_DIR, `labels/train/${stem}_ball2.txt`), yoloLines.join('\n') + '\n');
    }
  }

  writeFileSync(path.join(TEACHER_DIR, 'coco.json'), JSON.stringify({
    info: { description: 'AUTOCODE teacher dataset' },
    images: cocoImages,
    annotations: cocoAnns,
    categories: CLASSES.map((c, i) => ({ id: i, name: c })),
  }));

  writeFileSync(path.join(REALTIME_DIR, 'data.yaml'), [
    `path: ${REALTIME_DIR}`,
    'train: images/train',
    'val: images/val',
    'names:',
    ...CLASSES.map((c, i) => `  ${i}: ${c}`),
    '',
  ].join('\n'));

  // ---- events.jsonl ----
  // human-confirmed events lack pose features (the editor can't run pose) —
  // backfill wrist/elbow from the teacher's proposal of the same event
  const teacherEvents = await prisma.eventAnnotation.findMany({ where: { source: 'teacher' } });
  const lines: string[] = [];
  for (const ev of events) {
    const cls = EVENT_TYPE_TO_CLASS[ev.type];
    if (!cls) continue;
    const payload = JSON.parse(ev.payload);
    const feat = ev.features ? JSON.parse(ev.features) : {};
    if (feat.wrist_y == null && ev.source === 'human') {
      const twin = teacherEvents.find((t) => t.videoId === ev.videoId && t.type === ev.type
        && Math.abs(t.keyFrame - ev.keyFrame) <= 5 && t.features);
      if (twin) {
        const tf = JSON.parse(twin.features!);
        feat.wrist_y = tf.wrist_y ?? null;
        feat.elbow_y = tf.elbow_y ?? null;
        feat.ball_in_hand_dist = feat.ball_in_hand_dist ?? tf.ball_in_hand_dist ?? null;
      }
    }
    const framePath = framePathOf.get(ev.videoId)!(ev.keyFrame);
    const participants = [
      payload.shooterTrackingId, payload.rebounderTrackingId,
      payload.assisterTrackingId, payload.blockerTrackingId,
      payload.stealerTrackingId, payload.loserTrackingId,
    ].filter((x: any) => x !== undefined && x !== null);
    const sample: EventSample = {
      framePath,
      eventType: cls,
      participants,
      vx: feat.vx ?? null,
      vy: feat.vy ?? null,
      wrist_y: feat.wrist_y ?? null,
      elbow_y: feat.elbow_y ?? null,
      ball_in_hand_dist: feat.ball_in_hand_dist ?? null,
    };
    bump(cls);
    lines.push(JSON.stringify(sample));
  }
  writeFileSync(path.join(REALTIME_DIR, 'events.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));

  return {
    classCounts,
    labelCount: labels.length,
    eventCount: lines.length,
    dataYaml: path.join(REALTIME_DIR, 'data.yaml'),
    cocoJson: path.join(TEACHER_DIR, 'coco.json'),
    eventsJsonl: path.join(REALTIME_DIR, 'events.jsonl'),
  };
}
