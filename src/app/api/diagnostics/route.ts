import { runtime, uploadsBusy } from '@/server/drive';
import { catalog } from '@/server/catalog';
import { engineActivity } from '@/server/engine';

export const dynamic = 'force-dynamic';

/** Process and Proton API counters (benchmarks, troubleshooting). No secrets. */
export async function GET() {
  const rt = await runtime();
  const m = process.memoryUsage();
  return Response.json({
    versions: rt.versions,
    uptimeS: Math.round(process.uptime()),
    busy: uploadsBusy(),
    memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers },
    cpu: process.cpuUsage(),
    requests: rt.requestStats(),
    caches: rt.cacheStats(),
    notices: rt.notices(),
    // Drive folders fully listed once (never listed again), per backup set.
    listedDirs: catalog.listedSummary(),
    // Drive listings of running backups; a large idleS means the listing is stalled.
    activity: engineActivity(),
  });
}
