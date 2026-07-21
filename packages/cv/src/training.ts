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
  if (running) return { started: false, reason: `job ${running.id} already ${running.status}` };

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

  const lastModel = await prisma.modelVersion.findFirst({ where: { type: 'student' }, orderBy: { version: 'desc' } });
  const version = (lastModel?.version ?? 0) + 1;
  const name = `student_v${version}`;

  const result = await new Promise<{ weights: string; metrics: Record<string, number> }>(
    (resolve, reject) => {
      const p = spawn(pythonBin(), [
        path.join(PY_DIR, 'train.py'),
        '--type', 'student',
        '--data', ds.dataYaml,
        '--weights', 'yolo11n.pt',
        '--epochs', '20',
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
          data: { log: err.slice(-8000) },
        }).catch(() => {});
      });
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`train.py exited ${code}\n${err.slice(-3000)}`));
        const last = out.trim().split('\n').pop()!;
        resolve(JSON.parse(last));
      });
    },
  );

  // events.jsonl regenerated above = the event-detector training set (step 5).
  // Detector metrics decide promotion; event model training is logged for now.
  const current = await getProductionModel('student');
  const currentBall = current ? (JSON.parse(current.metrics).ball_map50 ?? 0) : 0;
  const newBall = result.metrics.ball_map50 ?? 0;
  const promote = !current || current.id === undefined || newBall > currentBall;

  const model = await prisma.modelVersion.create({
    data: {
      type: 'student',
      version,
      weightsPath: result.weights,
      metrics: JSON.stringify(result.metrics),
      status: promote ? 'production' : 'ready',
      trainingJobId: jobId,
    },
  });
  if (promote && current && current.status === 'production') {
    await prisma.modelVersion.update({ where: { id: current.id }, data: { status: 'archived' } });
  }

  await prisma.label.updateMany({ where: { isApproved: true }, data: { usedInTraining: true } });
  await prisma.eventAnnotation.updateMany({ where: { isApproved: true }, data: { usedInTraining: true } });

  await prisma.trainingJob.update({
    where: { id: jobId },
    data: {
      status: 'done',
      finishedAt: new Date(),
      log: `model ${name} ball_map50=${newBall.toFixed(3)} (prev ${currentBall.toFixed(3)}) -> ${promote ? 'PROMOTED to production' : 'kept as ready'}\nevents.jsonl: ${ds.eventCount} samples ready for event-detector training`,
    },
  });

  if (promote) reloadStudent(); // hot-swap in-process student; ws server reloads on "reload" msg
  return model;
}
