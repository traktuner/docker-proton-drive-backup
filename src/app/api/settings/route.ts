import { getUploadConfig } from '@/server/upload-config';
import path from 'node:path';
import { versions } from '@/server/drive';
import { LOCAL_ROOT } from '@/server/local';
import { getUserInfo } from '@/server/quota';
import { getMirrorSafetyConfig } from '@/server/mirror-safety';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [v, user] = await Promise.all([versions(), getUserInfo()]);
  return Response.json({
    uploads: getUploadConfig(),
    mirrorSafety: getMirrorSafetyConfig(),
    app: v.app,
    build: process.env.APP_VERSION || 'dev',
    imageTag: process.env.IMAGE_TAG || 'dev',
    sdk: { version: v.sdk, tag: v.sdkTag, commit: v.sdkCommit, crypto: v.crypto, appVersionHeader: v.appVersionHeader },
    tz: process.env.TZ || 'UTC',
    localRoot: LOCAL_ROOT,
    dataDir: path.dirname(process.env.DB_PATH || '/data/backup.db'),
    account: { email: user?.email ?? null, displayName: user?.displayName ?? null },
    quota: user?.quota ?? null,
    productUsed: user?.productUsed ?? {},
  });
}
