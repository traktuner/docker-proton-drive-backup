/**
 * In-memory live progress for running backup sets. Not persisted - progress is
 * only meaningful while a run is in flight (a server restart kills the run too).
 * The backup-sets API merges this into each set's response for the UI to poll.
 */
export interface Progress {
  doneFiles: number;
  totalFiles: number;
  doneBytes: number;
  totalBytes: number;
  current: string; // current folder / phase
  bytesPerSec?: number; // rolling upload speed
}

const g = globalThis as unknown as { __pdProgress?: Map<string, Progress> };
const store = g.__pdProgress ?? (g.__pdProgress = new Map());

export const progress = {
  set(id: string, p: Progress) {
    store.set(id, p);
  },
  get(id: string): Progress | undefined {
    return store.get(id);
  },
  clear(id: string) {
    store.delete(id);
  },
};
