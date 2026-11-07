import { PerformanceObserver, constants } from 'node:perf_hooks';
import v8 from 'node:v8';

/**
 * Heap size right after each major (mark-compact) GC: that is the memory really
 * in use. `heapUsed` alone also counts garbage V8 has not collected yet, which
 * can be hundreds of MiB while a run decrypts many Drive nodes. Diagnostics only.
 * On globalThis: Next.js can instantiate this module more than once.
 */
interface GcState {
  majorGcs: number;
  lastMajorAt: number | null;
  /** heapUsed measured just after the latest major GC. */
  liveHeap: number | null;
  /** Largest liveHeap seen since start (a leak makes this climb run after run). */
  maxLiveHeap: number;
}

const g = globalThis as unknown as { __pdGc?: GcState };

export function startGcStats(): void {
  if (g.__pdGc) return;
  const st: GcState = { majorGcs: 0, lastMajorAt: null, liveHeap: null, maxLiveHeap: 0 };
  g.__pdGc = st;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const kind = (e as { detail?: { kind?: number } }).detail?.kind;
        if (kind !== constants.NODE_PERFORMANCE_GC_MAJOR) continue;
        st.majorGcs++;
        st.lastMajorAt = Date.now();
        st.liveHeap = process.memoryUsage().heapUsed;
        st.maxLiveHeap = Math.max(st.maxLiveHeap, st.liveHeap);
      }
    });
    obs.observe({ entryTypes: ['gc'] });
  } catch {
    /* gc entries unavailable: diagnostics only */
  }
}

export function gcStats() {
  startGcStats();
  const spaces: Record<string, number> = {};
  for (const s of v8.getHeapSpaceStatistics()) spaces[s.space_name] = s.space_used_size;
  return { ...g.__pdGc!, heapLimit: v8.getHeapStatistics().heap_size_limit, spaces };
}
