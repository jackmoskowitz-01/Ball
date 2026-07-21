'use client';
import dynamic from 'next/dynamic';

// Konva touches window at import time — client-only.
const LabelEditor = dynamic(() => import('./LabelEditor'), { ssr: false });

export default function LabelEditorLoader({ videoId }: { videoId: string }) {
  return <LabelEditor videoId={videoId} />;
}
