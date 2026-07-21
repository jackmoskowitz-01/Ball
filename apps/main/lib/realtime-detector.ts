'use client';
import type { StudentDetection } from '@autocode/types';

/**
 * Real-time pipeline client. Streams webcam JPEG frames to the student
 * server (ws://localhost:8765 — which loads the production ModelVersion's
 * weightsPath straight from the shared DB; no hardcoded paths) and yields
 * detections. Keeps a small number of frames in flight so encode/infer
 * overlap and throughput stays >30 FPS on nano weights.
 */
export class RealtimeDetector {
  private ws: WebSocket | null = null;
  private inflight = 0;
  private readonly maxInflight = 2;
  modelVersion = 'connecting…';
  fps = 0;
  private frameTimes: number[] = [];

  onDetections: (dets: StudentDetection[]) => void = () => {};
  onStatus: (s: string) => void = () => {};

  connect(url = 'ws://localhost:8765') {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.onStatus('connected');
    this.ws.onclose = () => { this.onStatus('student server offline — run: npm run student:server'); this.inflight = 0; };
    this.ws.onerror = () => this.onStatus('student server offline — run: npm run student:server');
    this.ws.onmessage = (m) => {
      this.inflight = Math.max(0, this.inflight - 1);
      const data = JSON.parse(m.data);
      if (data.reloaded) { this.modelVersion = data.reloaded; return; }
      this.modelVersion = data.modelVersion;
      const now = performance.now();
      this.frameTimes.push(now);
      while (this.frameTimes.length && now - this.frameTimes[0] > 2000) this.frameTimes.shift();
      this.fps = this.frameTimes.length / 2;
      this.onDetections(data.detections);
    };
  }

  /** Push one frame if the pipe has room; drops frames instead of queueing lag. */
  push(canvas: HTMLCanvasElement) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.inflight >= this.maxInflight) return;
    this.inflight++;
    canvas.toBlob(async (blob) => {
      if (blob && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(await blob.arrayBuffer());
      } else {
        this.inflight = Math.max(0, this.inflight - 1);
      }
    }, 'image/jpeg', 0.7);
  }

  reload() { this.ws?.readyState === WebSocket.OPEN && this.ws.send('reload'); }
  close() { this.ws?.close(); }
}

export const CLASS_COLORS: Record<string, string> = {
  ball: '#f0883e', player: '#3fb950', rim: '#f85149',
  backboard: '#58a6ff', net: '#d2a8ff', court: '#8b949e',
};
