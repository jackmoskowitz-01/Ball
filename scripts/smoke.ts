// End-to-end smoke: register demo video -> teacher auto-label -> approve ->
// export datasets -> verify artifacts. Run: npx tsx scripts/smoke.ts
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { prisma, REPO_ROOT } from '@autocode/db';
import { predictTeacher, exportDatasets } from '@autocode/cv';

async function main() {
  const src = path.join(REPO_ROOT, 'demo/tracked.mp4');
  const dest = path.join(REPO_ROOT, 'data/videos/smoke_demo.mp4');
  mkdirSync(path.dirname(dest), { recursive: true });
  if (!existsSync(dest)) copyFileSync(src, dest);

  let video = await prisma.video.findFirst({ where: { path: dest } });
  if (!video) {
    video = await prisma.video.create({
      data: { name: 'smoke_demo.mp4', path: dest, fps: 30, width: 1296, height: 724, frames: 393 },
    });
  }
  console.log('video', video.id);

  const t = await predictTeacher(video.id, { model: 'yolo11n.pt', maxFrames: 150 });
  console.log('teacher ingested:', t);

  // simulate human review: approve everything the teacher produced
  await prisma.label.updateMany({ where: { videoId: video.id }, data: { isApproved: true } });
  await prisma.eventAnnotation.updateMany({ where: { videoId: video.id }, data: { isApproved: true } });

  const ds = await exportDatasets();
  console.log('export:', JSON.stringify(ds, null, 1));

  const yaml = readFileSync(ds.dataYaml, 'utf8');
  console.log('--- data.yaml ---\n' + yaml);
  const coco = JSON.parse(readFileSync(ds.cocoJson, 'utf8'));
  console.log('coco: images', coco.images.length, 'anns', coco.annotations.length, 'cats', coco.categories.map((c: any) => c.name).join(','));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
