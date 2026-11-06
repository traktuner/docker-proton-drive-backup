import { driveVersion } from '@/server/drive';
import { sdkEnabled } from '@/server/sdk-worker';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cli = await driveVersion();
  return Response.json({
    app: process.env.APP_VERSION || 'dev',
    imageTag: process.env.IMAGE_TAG || 'dev',
    cli,
    backend: sdkEnabled() ? 'SDK' : 'CLI',
  });
}
