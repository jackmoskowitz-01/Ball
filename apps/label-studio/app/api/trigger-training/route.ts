import { NextResponse } from 'next/server';
import { runTrainingIfReady } from '@autocode/cv';

export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await runTrainingIfReady();
  return NextResponse.json(result);
}
