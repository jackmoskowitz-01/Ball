'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

type Item = { kind: string; videoId: string; videoName: string; frameNumber: number; type?: string; confidence: number | null };

export default function Queue() {
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState('low_conf');
  const [jobs, setJobs] = useState<any>({ jobs: [], models: [] });

  const loadQueue = (m: string) => {
    setMode(m);
    fetch(`/api/queue?mode=${m}`).then((r) => r.json()).then(setItems);
  };
  const loadJobs = () => fetch('/api/jobs').then((r) => r.json()).then(setJobs);

  useEffect(() => {
    loadQueue('low_conf'); loadJobs();
    const t = setInterval(loadJobs, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <main className="page">
      <h1>Active Learning Queue</h1>
      <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className={mode === 'low_conf' ? 'primary' : ''} onClick={() => loadQueue('low_conf')}>20 lowest-confidence frames</button>
        <button className={mode === 'low_conf_ball' ? 'primary' : ''} onClick={() => loadQueue('low_conf_ball')}>20 lowest ball confidence</button>
        <button className={mode === 'unlabeled_blocks' ? 'primary' : ''} onClick={() => loadQueue('unlabeled_blocks')}>All unlabeled blocks</button>
        <button className={mode === 'shots_no_shooter' ? 'primary' : ''} onClick={() => loadQueue('shots_no_shooter')}>Shots without shooter</button>
      </div>
      <table>
        <thead><tr><th>Video</th><th>Frame</th><th>Type</th><th>Confidence</th><th /></tr></thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>{it.videoName}</td>
              <td>{it.frameNumber}</td>
              <td>{it.type ?? 'objects'}</td>
              <td>{it.confidence?.toFixed(2) ?? '—'}</td>
              <td><Link className="btn" href={`/label/${it.videoId}?f=${it.frameNumber}`}>Fix →</Link></td>
            </tr>
          ))}
          {!items.length && <tr><td colSpan={5} className="dim">Queue is empty for this filter.</td></tr>}
        </tbody>
      </table>

      <h2>Training jobs</h2>
      <table>
        <thead><tr><th>Job</th><th>Status</th><th>Dataset</th><th>Log tail</th></tr></thead>
        <tbody>
          {jobs.jobs.map((j: any) => (
            <tr key={j.id}>
              <td>{j.id.slice(-6)} <span className="dim">{j.type}</span></td>
              <td><span className={`pill ${j.status}`}>{j.status}</span></td>
              <td>{j.datasetVersion ? `v${j.datasetVersion.version} (${j.datasetVersion.labelCount} labels)` : '—'}</td>
              <td style={{ maxWidth: 420 }}><pre style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{(j.log ?? '').slice(-300)}</pre></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Models</h2>
      <table>
        <thead><tr><th>Model</th><th>Status</th><th>ball mAP50</th><th>mAP50</th><th>Weights</th></tr></thead>
        <tbody>
          {jobs.models.map((m: any) => {
            const met = JSON.parse(m.metrics || '{}');
            return (
              <tr key={m.id}>
                <td>{m.type}_v{m.version}</td>
                <td><span className={`pill ${m.status === 'production' ? 'approved' : ''}`}>{m.status}</span></td>
                <td>{met.ball_map50?.toFixed(3) ?? '—'}</td>
                <td>{met.map50?.toFixed(3) ?? '—'}</td>
                <td className="dim" style={{ fontSize: 11 }}>{m.weightsPath}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
