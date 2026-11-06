import { checkCliUpdate, checkContainerUpdate } from '@/server/updates';

import { sdkEnabled } from '@/server/sdk-worker';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (sdkEnabled()) return Response.json({ cli: null, container: null });
  const [cli, container] = await Promise.all([checkCliUpdate(), checkContainerUpdate()]);
  return Response.json({ cli, container });
}
