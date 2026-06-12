import { checkCliUpdate, checkContainerUpdate } from '@/server/updates';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [cli, container] = await Promise.all([checkCliUpdate(), checkContainerUpdate()]);
  return Response.json({ cli, container });
}
