import { setUploadConfig } from '@/server/upload-config';
import { uploadsView } from '@/server/traffic';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(uploadsView());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { concurrency?: number; limitKBps?: number } = {};
  if (body.concurrency != null) patch.concurrency = Number(body.concurrency);
  if (body.limitKBps != null) patch.limitKBps = Number(body.limitKBps);
  setUploadConfig(patch);
  // The cap is (re)applied by the runner around each run so it doesn't throttle the
  // UI/API between runs — so no immediate tc call here, just persist + report.
  return Response.json(uploadsView());
}
