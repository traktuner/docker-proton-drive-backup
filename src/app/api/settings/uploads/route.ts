import { getUploadConfig, setUploadConfig } from '@/server/upload-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(getUploadConfig());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { concurrency?: number; limitKBps?: number } = {};
  if (body.concurrency != null) patch.concurrency = Number(body.concurrency);
  if (body.limitKBps != null) patch.limitKBps = Number(body.limitKBps);
  setUploadConfig(patch);
  // The engine re-reads the config within a second, also during a running backup.
  return Response.json(getUploadConfig());
}
