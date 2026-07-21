import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import type { StudentDetection } from '@autocode/types';
import { PY_DIR, pythonBin } from './python';

/**
 * predictStudent(frame): single-frame fast detection via a persistent
 * yolo-nano python process (stdio mode of student_server.py — the same
 * code the /live websocket server runs). No event logic here; events
 * live in the real-time pipeline.
 */
let proc: ChildProcess | null = null;
let queue: ((v: { modelVersion: string; detections: StudentDetection[] }) => void)[] = [];

function ensureProc() {
  if (proc && !proc.killed) return;
  proc = spawn(pythonBin(), [path.join(PY_DIR, 'student_server.py'), '--stdio'], {
    cwd: PY_DIR,
  });
  let buf = '';
  proc.stdout!.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line && queue.length) queue.shift()!(JSON.parse(line));
    }
  });
  proc.on('close', () => { proc = null; queue = []; });
}

export async function predictStudent(
  frameJpeg: Buffer,
): Promise<{ modelVersion: string; detections: StudentDetection[] }> {
  ensureProc();
  return new Promise((resolve) => {
    queue.push(resolve);
    proc!.stdin!.write(frameJpeg.toString('base64') + '\n');
  });
}

/** Hot-swap to the latest production weights after a training run. */
export function reloadStudent() {
  if (proc && !proc.killed) proc.stdin!.write('reload\n');
}
