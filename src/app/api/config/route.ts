import { exportConfig, importConfig } from '@/server/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(exportConfig(), {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="proton-drive-backup.yaml"',
    },
  });
}

const MAX_CONFIG_BYTES = 256 * 1024; // real backup-set configs are a few KB

export async function POST(req: Request) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_CONFIG_BYTES) {
    return Response.json({ error: 'config too large' }, { status: 413 });
  }
  const text = await req.text();
  if (text.length > MAX_CONFIG_BYTES) {
    return Response.json({ error: 'config too large' }, { status: 413 });
  }
  if (!text.trim()) return Response.json({ error: 'empty config' }, { status: 400 });
  const result = importConfig(text);
  return Response.json(result);
}
