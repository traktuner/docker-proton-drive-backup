import { getCliVersion } from '@/server/cli';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cli = await getCliVersion();
  return Response.json({
    app: process.env.APP_VERSION || 'dev',
    imageTag: process.env.IMAGE_TAG || 'dev',
    cli,
  });
}
