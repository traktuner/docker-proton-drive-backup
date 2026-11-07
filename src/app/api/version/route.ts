import { versions } from '@/server/drive';

export const dynamic = 'force-dynamic';

export async function GET() {
  const v = await versions();
  return Response.json({
    app: v.app,
    build: process.env.APP_VERSION || 'dev',
    imageTag: process.env.IMAGE_TAG || 'dev',
    sdk: v.sdk,
    sdkTag: v.sdkTag,
    sdkCommit: v.sdkCommit,
    appVersionHeader: v.appVersionHeader,
  });
}
