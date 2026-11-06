import path from 'node:path';
import { driveVersion } from '@/server/drive';
import { sdkEnabled } from '@/server/sdk-worker';
import { LOCAL_ROOT } from '@/server/local';
import { getUserInfo } from '@/server/quota';
import { uploadsView } from '@/server/traffic';
import { getMirrorSafetyConfig } from '@/server/mirror-safety';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [cli, user] = await Promise.all([driveVersion(), getUserInfo()]);
  return Response.json({
    uploads: uploadsView(),
    mirrorSafety: getMirrorSafetyConfig(),
    app: process.env.APP_VERSION || 'dev',
    imageTag: process.env.IMAGE_TAG || 'dev',
    cli,
    backend: sdkEnabled() ? 'SDK' : 'CLI',
    tz: process.env.TZ || 'UTC',
    localRoot: LOCAL_ROOT,
    dataDir: path.dirname(process.env.DB_PATH || '/data/backup.db'),
    account: { email: user?.email ?? null, displayName: user?.displayName ?? null },
    quota: user?.quota ?? null,
    productUsed: user?.productUsed ?? {},
  });
}
