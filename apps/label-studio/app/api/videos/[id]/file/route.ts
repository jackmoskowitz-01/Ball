import { NextRequest } from 'next/server';
import { createReadStream, statSync } from 'fs';
import { Readable } from 'stream';
import { prisma } from '@autocode/db';

export const dynamic = 'force-dynamic';

// Range-aware video streaming — without 206 responses <video> can't seek,
// and frame-accurate labeling is impossible.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) return new Response('not found', { status: 404 });

  const size = statSync(video.path).size;
  const range = req.headers.get('range');
  if (range) {
    // handle all three range forms: bytes=a-b, bytes=a-, bytes=-n (suffix —
    // Chrome uses this to grab the trailing moov atom; mishandling it stalls
    // playback with no error)
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start: number, end: number;
    if (m && m[1] === '' && m[2] !== '') {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = m && m[1] !== '' ? Number(m[1]) : 0;
      end = m && m[2] !== '' ? Number(m[2]) : Math.min(start + 4 * 1024 * 1024, size - 1);
    }
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    end = Math.min(end, size - 1);
    const stream = Readable.toWeb(createReadStream(video.path, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': 'video/mp4',
      },
    });
  }
  const stream = Readable.toWeb(createReadStream(video.path)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Length': String(size),
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    },
  });
}
