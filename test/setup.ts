import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Per-file isolated environment: a fresh temp dir for the SQLite DB and the local
// source root, so DB/catalog/config tests don't touch real data or each other.
// Runs before each test file's imports, so db.ts/local.ts read these values.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-test-'));
process.env.DB_PATH = path.join(dir, 'backup.db');
process.env.LOCAL_ROOT = path.join(dir, 'sources');
process.env.CONFIG_DIR = path.join(dir, 'config');
process.env.PROTON_DRIVE_CACHE_DIR = path.join(dir, 'proton');
process.env.TZ = 'UTC';
fs.mkdirSync(process.env.LOCAL_ROOT, { recursive: true });

// Expose the temp root for tests that need to create fixture files.
(globalThis as unknown as { __TEST_DIR__: string }).__TEST_DIR__ = dir;
