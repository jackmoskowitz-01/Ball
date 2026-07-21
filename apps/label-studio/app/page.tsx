'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

type VideoRow = {
  id: string; name: string; status: string; fps: number; frames: number;
  createdAt: string; _count: { labels: number; events: number };
};

export default function Home() {
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => fetch('/api/videos').then((r) => r.json()).then(setVideos);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000); // watch auto-label progress
    return () => clearInterval(t);
  }, []);

  async function upload(f: File) {
    setUploading(true);
    const fd = new FormData();
    fd.append('file', f);
    await fetch('/api/videos', { method: 'POST', body: fd });
    setUploading(false);
    load();
  }

  return (
    <main className="page">
      <h1>Videos</h1>
      <div className="card">
        <input ref={fileRef} type="file" accept="video/*"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        {uploading && <span className="dim"> uploading… teacher auto-label starts on arrival</span>}
        <p className="dim" style={{ marginTop: 8 }}>
          Upload film → the Teacher (YOLO11x + ByteTrack) auto-labels every frame and proposes
          events (yellow). You correct + approve → the Student retrains → <b>/live</b> gets better.
        </p>
      </div>
      <table>
        <thead><tr><th>Video</th><th>Status</th><th>Frames</th><th>Labels</th><th>Events</th><th /></tr></thead>
        <tbody>
          {videos.map((v) => (
            <tr key={v.id}>
              <td><Link href={`/label/${v.id}`}>{v.name}</Link></td>
              <td><span className={`pill ${v.status}`}>{v.status}</span></td>
              <td>{v.frames}</td>
              <td>{v._count.labels}</td>
              <td>{v._count.events}</td>
              <td><Link className="btn" href={`/label/${v.id}`}>Label →</Link></td>
            </tr>
          ))}
          {!videos.length && <tr><td colSpan={6} className="dim">No videos yet — upload game film above.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
