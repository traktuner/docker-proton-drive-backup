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

export async function POST(req: Request) {
  const text = await req.text();
  if (!text.trim()) return Response.json({ error: 'empty config' }, { status: 400 });
  const result = importConfig(text);
  return Response.json(result);
}
