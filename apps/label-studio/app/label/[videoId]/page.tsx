import LabelEditorLoader from './LabelEditorLoader';

export default async function LabelPage({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  return <LabelEditorLoader videoId={videoId} />;
}
