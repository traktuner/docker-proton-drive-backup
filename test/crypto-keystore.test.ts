import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

/**
 * The crypto endpoint keeps every imported or generated key until clearKey(), and
 * the SDK never calls it: each decrypted Drive node (every listed file and folder)
 * stayed in memory for the life of the process. Production: +600 MB live heap in
 * 7 h of listing. The runtime frees a key once nothing holds its reference.
 */
const ROOT = path.resolve(__dirname, '..');
type KeyRef = { _idx: number; getFingerprint(): string };
interface Proxy {
  generateKey(o: unknown): Promise<KeyRef>;
  exportPrivateKey(o: unknown): Promise<string>;
  importPrivateKey(o: unknown): Promise<KeyRef>;
  signMessage(o: unknown): Promise<string>;
}
let CryptoProxy: Proxy;
let cryptoKeyCount: () => number;

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const collect = async () => {
  for (let i = 0; i < 6; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 20)); // finalizers run as tasks after a GC
  }
};

beforeAll(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist-proton/runtime.mjs')))
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-proton.mjs')], { cwd: ROOT, stdio: 'pipe' });
  const mod = await import(pathToFileURL(path.join(ROOT, 'dist-proton/runtime.mjs')).href);
  ({ CryptoProxy, cryptoKeyCount } = mod);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-ks-'));
  await mod.createRuntime({ sessionDir: dir, appVersion: '1.2.3', clientUid: 'x', baseUrl: '127.0.0.1:9' }); // sets the endpoint
}, 120_000);

describe('crypto key store', () => {
  it('frees decrypted keys nobody holds any more and keeps the ones still in use', async () => {
    const passphrase = 'node-passphrase';
    const gen = await CryptoProxy.generateKey({ userIDs: [{ name: 'node', email: 'node@example.com' }], type: 'ecc' });
    const armored = await CryptoProxy.exportPrivateKey({ privateKey: gen, passphrase });
    const kept = await CryptoProxy.importPrivateKey({ armoredKey: armored, passphrase });
    await collect();
    const before = cryptoKeyCount();

    // What a folder listing does: decrypt one node key per child, use it, drop it.
    const listing = async () => {
      for (let i = 0; i < 300; i++) {
        const k = await CryptoProxy.importPrivateKey({ armoredKey: armored, passphrase });
        expect(k.getFingerprint()).toBe(kept.getFingerprint());
      }
    };
    await listing();
    expect(cryptoKeyCount()).toBeGreaterThanOrEqual(before);
    await collect();
    expect(cryptoKeyCount()).toBeLessThanOrEqual(before);

    // A key still referenced stays usable.
    const sig = await CryptoProxy.signMessage({ textData: 'still here', signingKeys: kept, detached: true });
    expect(sig).toContain('BEGIN PGP SIGNATURE');
    expect(gen._idx).not.toBe(kept._idx);
  }, 60_000);
});
