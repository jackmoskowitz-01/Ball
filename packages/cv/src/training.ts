import { spawn } from 'child_process';
import path from 'path';
import { prisma, REPO_ROOT, getProductionModel } from '@autocode/db';
import { exportDatasets } from './export';
import { PY_DIR, pythonBin } from './python';
import { reloadStudent } from './student';

export const MIN_NEW_APPROVED = 10;

/**
 * The automatic learning loop. Called by /api/trigger-training.
 * 1. >=10 approved-but-unused labels -> queue TrainingJob
 * 2. DatasetVersion with classCounts
 * 3. exportDatasets() -> data/teacher + data/realtime (+ events.jsonl)
 * 4. train.py on all classes -> student_v{n}
 * 5. event data logged (events.jsonl is the event-detector training set)
 * 6. ModelVersion; promote to production if ball_map50 beats current
 * 7. mark labels usedInTraining
 * 8. main app / student server pick up new weights via getProductionModel()
 */
export async function runTrainingIfReady(): Promise<
  { started: false; reason: string } | { started: true; jobId: string }
> {
  const newLabels = await prisma.label.count({ where: { isApproved: true, usedInTraining: false } });
  const newEvents = await prisma.eventAnnotation.count({ where: { isApproved: true, usedInTraining: false } });
  if (newLabels + newEvents < MIN_NEW_APPROVED) {
    return { started: false, reason: `${newLabels + newEvents}/${MIN_NEW_APPROVED} new approved labels` };
  }
  const running = await prisma.trainingJob.findFirst({ where: { status: { in: ['queued', 'running'] } } });
  if (running) {
    // a job left 'running' after a server crash would block training forever —
    // treat anything older than 2h as dead and clear it
    const ageMin = (Date.now() - running.createdAt.getTime()) / 60000;
    if (ageMin > 120) {
      await prisma.trainingJob.update({
        where: { id: running.id },
        data: { status: 'failed', finishedAt: new Date(), log: running.log + '\nmarked stale after 2h' },
      });
    } else {
      return { started: false, reason: `training already in progress (~${Math.round(ageMin)}min in) — watch /queue` };
    }
  }

  const job = await prisma.trainingJob.create({ data: { type: 'student', status: 'queued' } });
  // fire and forget — the route returns immediately, /queue shows progress
  runJob(job.id).catch(async (e) => {
    await prisma.trainingJob.update({
      where: { id: job.id },
      data: { status: 'failed', log: String(e).slice(0, 8000), finishedAt: new Date() },
    });
  });
  return { started: true, jobId: job.id };
}

async function runJob(jobId: string) {
  await prisma.trainingJob.update({ where: { id: jobId }, data: { status: 'running' } });

  const ds = await exportDatasets();
  const lastDs = await prisma.datasetVersion.findFirst({ orderBy: { version: 'desc' } });
  const dsVersion = (lastDs?.version ?? 0) + 1;
  const dataset = await prisma.datasetVersion.create({
    data: {
      version: dsVersion,
      classCounts: JSON.stringify(ds.classCounts),
      labelCount: ds.labelCount,
      eventCount: ds.eventCount,
    },
  });
  await prisma.trainingJob.update({
    where: { id: jobId },
    data: { datasetVersionId: dataset.id, log: `dataset v${dsVersion}: ${JSON.stringify(ds.classCounts)}\n` },
  });

  const trainOne = (type: 'student' | 'teacher', base: string, epochs: number, name: string) =>
    new Promise<{ weights: string; metrics: Record<string, number> }>((resolve, reject) => {
      const p = spawn(pythonBin(), [
        path.join(PY_DIR, 'train.py'),
        '--type', type,
        '--data', ds.dataYaml,
        '--weights', base,
        '--epochs', String(epochs),
        '--project', path.join(REPO_ROOT, 'data/weights'),
        '--name', name,
      ], { cwd: PY_DIR });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', async (d) => {
        err += d;
        // stream tail of training log into the job row so /queue can show it
        await prisma.trainingJob.update({
          where: { id: jobId },
          data: { log: `[${name}]\n` + err.slice(-8000) },
        }).catch(() => {});
      });
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`train.py exited ${code}\n${err.slice(-3000)}`));
        const last = out.trim().split('\n').pop()!;
        resolve(JSON.parse(last));
      });
    });

  // promote by the metric that matters for that role: student = ball (the
  // live-tracking weak point), teacher = overall mAP (label quality).
  const finish = async (
    type: 'student' | 'teacher', version: number,
    result: { weights: string; metrics: Record<string, number> }, metricKey: string,
  ) => {
    const current = await getProductionModel(type);
    const currentScore = current ? (JSON.parse(current.metrics)[metricKey] ?? 0) : 0;
    const newScore = result.metrics[metricKey] ?? 0;
    const promote = !current || newScore > currentScore;
    const model = await prisma.modelVersion.create({
      data: {
        type, version,
        weightsPath: result.weights,
        metrics: JSON.stringify(result.metrics),
        status: promote ? 'production' : 'ready',
        trainingJobId: jobId,
      },
    });
    if (promote && current && current.status === 'production') {
      await prisma.modelVersion.update({ where: { id: current.id }, data: { status: 'archived' } });
    }
    return { model, promote, newScore, currentScore };
  };

  const nextVersion = async (type: string) => {
    const last = await prisma.modelVersion.findFirst({ where: { type }, orderBy: { version: 'desc' } });
    return (last?.version ?? 0) + 1;
  };

  // 1) student — fast nano, powers /live
  const sv = await nextVersion('student');
  const studentResult = await trainOne('student', 'yolo11n.pt', 20, `student_v${sv}`);
  const student = await finish('student', sv, studentResult, 'ball_map50');

  // 2) teacher — heavier medium model; once promoted, teacher.py auto-labels
  //    the NEXT video with fine-tuned weights (all 6 classes), so hand-label
  //    effort compounds instead of staying constant
  const tv = await nextVersion('teacher');
  const teacherResult = await trainOne('teacher', 'yolo11m.pt', 15, `teacher_v${tv}`);
  const teacher = await finish('teacher', tv, teacherResult, 'map50');

  await prisma.label.updateMany({ where: { isApproved: true }, data: { usedInTraining: true } });
  await prisma.eventAnnotation.updateMany({ where: { isApproved: true }, data: { usedInTraining: true } });

  await prisma.trainingJob.update({
    where: { id: jobId },
    data: {
      status: 'done',
      finishedAt: new Date(),
      log: [
        `student_v${sv} ball_map50=${student.newScore.toFixed(3)} (prev ${student.currentScore.toFixed(3)}) -> ${student.promote ? 'PROMOTED to production' : 'kept as ready'}`,
        `teacher_v${tv} map50=${teacher.newScore.toFixed(3)} (prev ${teacher.currentScore.toFixed(3)}) -> ${teacher.promote ? 'PROMOTED — next auto-labels use fine-tuned teacher' : 'kept as ready'}`,
        `events.jsonl: ${ds.eventCount} samples ready for event-detector training`,
      ].join('\n'),
    },
  });
  const model = student.model;

  if (student.promote) reloadStudent(); // hot-swap in-process student; ws server reloads on "reload" msg
  return model;
}
