import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { getMirrorSafetyConfig } from '@/server/mirror-safety';

const FILE = path.join(path.dirname(process.env.DB_PATH!), 'mirror-safety.json');

function update(body: unknown) {
  return POST(
    new Request('http://localhost/api/settings/mirror-safety', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe('/api/settings/mirror-safety', () => {
  it('returns the backwards-compatible 30% default', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, deleteSafetyPct: 0.3 });
  });

  it('persists a threshold and can disable only the percentage gate', async () => {
    const response = await update({ enabled: false, deleteSafetyPct: 0.6 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, deleteSafetyPct: 0.6 });
    expect(getMirrorSafetyConfig()).toEqual({ enabled: false, deleteSafetyPct: 0.6 });
  });

  it.each([
    [{ enabled: 'yes' }, /enabled must be a boolean/],
    [{ deleteSafetyPct: '0.5' }, /must be a number/],
    [{ deleteSafetyPct: 0 }, /between 0.01 and 0.99/],
    [{ deleteSafetyPct: 1 }, /between 0.01 and 0.99/],
  ])('rejects invalid input without changing the default: %j', async (body, error) => {
    const response = await update(body);
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.error).toMatch(error);
    expect(getMirrorSafetyConfig()).toEqual({ enabled: true, deleteSafetyPct: 0.3 });
  });
});
