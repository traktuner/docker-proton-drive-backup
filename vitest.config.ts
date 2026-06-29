import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Server-logic test runner. The `@/` alias mirrors tsconfig so modules import the
// same way they do at runtime. Each test FILE gets an isolated temp DB / sources
// dir via test/setup.ts, so DB-touching tests never clash.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // better-sqlite3 is a native addon; keep file isolation so each file's cached
    // DB connection is fresh.
    isolate: true,
  },
});
