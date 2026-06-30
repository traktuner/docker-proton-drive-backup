import { getUploadConfig, setUploadConfig } from '@/server/upload-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(getUploadConfig());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { concurrency?: number } = {};
  if (body.concurrency != null) patch.concurrency = Number(body.concurrency);
  return Response.json(setUploadConfig(patch));
}
