import Link from 'next/link';
import { getProductionModel } from '@autocode/db';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const model = await getProductionModel('student');
  return (
    <main style={{ maxWidth: 700, margin: '60px auto', padding: 16 }}>
      <h1 style={{ color: '#f0883e' }}>AUTOCODE — Real-Time</h1>
      <p>
        Production student model:{' '}
        {model
          ? <b>student_v{model.version} ({model.status})</b>
          : <b>none yet — COCO-pretrained fallback (label + approve in the studio to train one)</b>}
      </p>
      <p><Link href="/live" style={{ color: '#3fb950', fontSize: 18 }}>→ /live webcam pipeline</Link></p>
      <p><a href="http://localhost:3001" style={{ color: '#8b949e' }}>Label Studio (teacher) ↗</a></p>
    </main>
  );
}
