import { readFileSync } from 'fs';
import { prisma } from '@autocode/db';
import type { ObjectAnnotation, StudentDetection } from '@autocode/types';
import { toDetectorClass } from './classes';
import { extractFrames } from './export';
import { predictStudent } from './student';

/**
 * Active-learning signal #2: where do Teacher and Student disagree most?
 * Those frames are exactly where a hand-label buys the most model improvement —
 * either the teacher hallucinated (label it right) or the student is blind
 * (it needs that example). Score per frame:
 *   mean(1 - bestIoU per teacher object) + 0.5 * unmatched-student-boxes ratio,
 * with ball objects weighted 3x (the class that matters most and fails most).
 */

function iou(a: { x: number; y: number; w: number; h: number }, b: StudentDetection) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function scoreDisagreement(teacherObjs: ObjectAnnotation[], studentDets: StudentDetection[]) {
  const tObjs = teacherObjs
    .map((o) => ({ ...o, det: toDetectorClass(o.cls) }))
    .filter((o) => o.det && o.det !== 'court' && o.visible !== false);
  if (!tObjs.length && !studentDets.length) return 0;

  let weighted = 0, weightSum = 0;
  const matched = new Set<number>();
  for (const t of tObjs) {
    let best = 0, bestIdx = -1;
    studentDets.forEach((s, i) => {
      if (s.cls !== t.det) return;
      const v = iou(t, s);
      if (v > best) { best = v; bestIdx = i; }
    });
    if (bestIdx >= 0 && best > 0.3) matched.add(bestIdx);
    const w = t.det === 'ball' ? 3 : 1;
    weighted += (1 - best) * w;
    weightSum += w;
  }
  const objTerm = weightSum ? weighted / weightSum : 0;
  const spurious = studentDets.filter((s, i) => !matched.has(i) && s.confidence > 0.4).length;
  const spuriousTerm = studentDets.length ? spurious / studentDets.length : 0;
  return objTerm + 0.5 * spuriousTerm;
}

/**
 * Score up to `limit` unapproved teacher frames that have no cached score yet
 * (spread across the video: every Nth frame), store scores on the Label rows.
 * Returns how many were computed. Called from /api/queue?mode=disagreement.
 */
export async function computeDisagreements(limit = 60): Promise<number> {
  const rows = await prisma.label.findMany({
    where: { source: 'teacher', isApproved: false, disagreement: null },
    include: { video: true },
    orderBy: { frameNumber: 'asc' },
  });
  if (!rows.length) return 0;

  // spread the budget instead of scoring a contiguous blob at the start
  const stride = Math.max(1, Math.floor(rows.length / limit));
  const sample = rows.filter((_, i) => i % stride === 0).slice(0, limit);

  let done = 0;
  for (const row of sample) {
    const framePath = extractFrames(row.video.path, row.videoId, [row.frameNumber], row.video.fps)(row.frameNumber);
    const { detections } = await predictStudent(readFileSync(framePath));
    const score = scoreDisagreement(JSON.parse(row.objects), detections);
    await prisma.label.update({ where: { id: row.id }, data: { disagreement: score } });
    done++;
  }
  return done;
}
