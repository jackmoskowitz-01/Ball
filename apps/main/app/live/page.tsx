'use client';
/**
 * /live — the proof that every hand-label improves live tracking:
 * webcam → student (production weights from the shared DB) → boxes,
 * with FPS counter + the exact production ModelVersion on screen.
 */
import { useEffect, useRef, useState } from 'react';
import { RealtimeDetector, CLASS_COLORS } from '../../lib/realtime-detector';

export default function Live() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const grabRef = useRef<HTMLCanvasElement>(null);
  const [fps, setFps] = useState(0);
  const [modelId, setModelId] = useState('…');
  const [status, setStatus] = useState('connecting');
  const [dbModel, setDbModel] = useState<any>(null);

  useEffect(() => {
    fetch('/api/model').then((r) => r.json()).then(setDbModel);
    const det = new RealtimeDetector();
    det.onStatus = setStatus;
    let raf = 0;

    det.onDetections = (dets) => {
      setFps(Math.round(det.fps));
      setModelId(det.modelVersion);
      const cv = overlayRef.current, v = videoRef.current;
      if (!cv || !v) return;
      const ctx = cv.getContext('2d')!;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.font = 'bold 13px sans-serif';
      for (const d of dets) {
        const color = CLASS_COLORS[d.cls] ?? '#fff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(d.x, d.y, d.w, d.h);
        ctx.fillStyle = color;
        ctx.fillText(`${d.cls} ${(d.confidence * 100) | 0}%`, d.x + 2, d.y - 4);
      }
    };
    det.connect();

    navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } }).then((stream) => {
      const v = videoRef.current!;
      v.srcObject = stream;
      v.play();
      v.onloadedmetadata = () => {
        overlayRef.current!.width = v.videoWidth;
        overlayRef.current!.height = v.videoHeight;
        grabRef.current!.width = v.videoWidth;
        grabRef.current!.height = v.videoHeight;
        const loop = () => {
          const g = grabRef.current!;
          g.getContext('2d')!.drawImage(v, 0, 0, g.width, g.height);
          det.push(g);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      };
    }).catch(() => setStatus('webcam permission denied'));

    return () => { cancelAnimationFrame(raf); det.close(); };
  }, []);

  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 20 }}>
      <div style={{ display: 'flex', gap: 20, alignItems: 'baseline' }}>
        <h1 style={{ color: '#f0883e', margin: 0 }}>/live</h1>
        <span style={{ fontSize: 22, fontWeight: 700, color: fps >= 30 ? '#3fb950' : '#d4a72c' }}>{fps} FPS</span>
        <span>model: <b>{modelId}</b></span>
        {dbModel && <span style={{ color: '#8b949e' }}>DB production: {dbModel.status === 'fallback' ? 'none (COCO fallback)' : `student_v${dbModel.version} (${dbModel.id.slice(-6)})`}</span>}
        <span style={{ color: status.includes('offline') || status.includes('denied') ? '#f85149' : '#3fb950' }}>{status}</span>
      </div>
      <div style={{ position: 'relative' }}>
        <video ref={videoRef} muted playsInline style={{ maxWidth: '90vw', borderRadius: 8 }} />
        <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        <canvas ref={grabRef} style={{ display: 'none' }} />
      </div>
      <p style={{ color: '#8b949e', maxWidth: 720 }}>
        Every label you approve in the studio retrains the student; when its ball mAP50 beats the
        current production model it is promoted and this page hot-swaps to it (the server re-reads
        the DB — no hardcoded weight paths).
      </p>
    </main>
  );
}
