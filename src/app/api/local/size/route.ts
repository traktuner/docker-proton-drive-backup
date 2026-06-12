import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveLocal } from '@/server/local';

export const dynamic = 'force-dynamic';

/**
 * Streams a running size/file/folder count for the selected source paths via
 * Server-Sent Events, so the UI can show a live estimate without blocking.
 * Closing the EventSource aborts the walk (req.signal).
 */
export async function GET(req: Request) {
  const paths = new URL(req.url).searchParams.getAll('path');
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let bytes = 0;
      let files = 0;
      let folders = 0;
      let last = 0;

      const send = (done: boolean) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ bytes, files, folders, done })}\n\n`));
        } catch {
          /* controller closed */
        }
      };
      const maybeSend = () => {
        const now = Date.now();
        if (now - last >= 200) {
          last = now;
          send(false);
        }
      };

      async function walk(abs: string) {
        if (req.signal.aborted) throw new Error('aborted');
        let dirents;
        try {
          dirents = await fs.readdir(abs, { withFileTypes: true });
        } catch {
          return;
        }
        for (const d of dirents) {
          if (req.signal.aborted) throw new Error('aborted');
          if (d.name.startsWith('.')) continue;
          const child = path.join(abs, d.name);
          if (d.isDirectory()) {
            folders++;
            maybeSend();
            await walk(child);
          } else if (d.isFile()) {
            files++;
            try {
              bytes += (await fs.stat(child)).size;
            } catch {
              /* skip unreadable */
            }
            maybeSend();
          }
        }
      }

      try {
        for (const p of paths) {
          if (req.signal.aborted) break;
          const abs = resolveLocal(p);
          const st = await fs.stat(abs).catch(() => null);
          if (!st) continue;
          if (st.isFile()) {
            files++;
            bytes += st.size;
          } else if (st.isDirectory()) {
            await walk(abs);
          }
        }
        send(true);
      } catch {
        /* aborted */
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
