import { NextResponse } from 'next/server';
import { getProductionModel } from '@autocode/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const model = await getProductionModel('student');
  return NextResponse.json(model
    ? { id: model.id, version: model.version, status: model.status, weightsPath: model.weightsPath, metrics: JSON.parse(model.metrics) }
    : { id: 'coco-pretrained-fallback', version: 0, status: 'fallback' });
}
