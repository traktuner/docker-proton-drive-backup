import { checkContainerUpdate } from '@/server/updates';
import { runtime } from '@/server/drive';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [container, rt] = await Promise.all([checkContainerUpdate(), runtime()]);
  // The SDK is bundled into the image; Proton announces required/suggested SDK
  // versions in response headers, surfaced here as notices.
  return Response.json({ container, sdk: { current: rt.versions.sdk, notices: rt.notices() } });
}
