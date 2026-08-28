import { getMirrorSafetyConfig, setMirrorSafetyConfig } from '@/server/mirror-safety';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(getMirrorSafetyConfig());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<typeof setMirrorSafetyConfig>[0] = {};

  if (body.enabled != null) {
    if (typeof body.enabled !== 'boolean') {
      return Response.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }
    patch.enabled = body.enabled;
  }

  if (body.deleteSafetyPct != null) {
    if (typeof body.deleteSafetyPct !== 'number' || !Number.isFinite(body.deleteSafetyPct)) {
      return Response.json({ error: 'deleteSafetyPct must be a number' }, { status: 400 });
    }
    if (body.deleteSafetyPct < 0.01 || body.deleteSafetyPct > 0.99) {
      return Response.json({ error: 'deleteSafetyPct must be between 0.01 and 0.99' }, { status: 400 });
    }
    patch.deleteSafetyPct = body.deleteSafetyPct;
  }

  try {
    return Response.json(setMirrorSafetyConfig(patch));
  } catch {
    return Response.json({ error: 'could not persist Mirror safety settings' }, { status: 500 });
  }
}
