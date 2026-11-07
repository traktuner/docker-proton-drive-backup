import { describe, it, expect } from 'vitest';
import { pickUpdate } from './updates';

const TAGS = ['latest', 'main', '0.9.0', '0.9', '0.9.0-21', '0.8.0-12', '1.0.0', '1.0', '1', '1.0.0-1', 'f2400ac', '1.1.0-rc.1'];

describe('container update check (release tags only)', () => {
  it('a CLI-era image (0.9.0-21) is offered the 1.0.0 release with its notes', () => {
    const u = pickUpdate(TAGS, '0.9.0-21', '0.9.0');
    expect(u).toMatchObject({ latest: '1.0.0', updateAvailable: true });
    expect(u.releaseUrl).toMatch(/\/releases\/tag\/v1\.0\.0$/);
  });

  it('the newest release itself is up to date; floating tags, shas and release candidates are ignored', () => {
    expect(pickUpdate(TAGS, '1.0.0', '1.0.0')).toMatchObject({ latest: '1.0.0', updateAvailable: false });
  });

  it('a preview or main build counts as its app version: only a NEWER release is an update', () => {
    expect(pickUpdate(TAGS, '1.0.0-preview.6de71b2', '1.0.0').updateAvailable).toBe(false);
    expect(pickUpdate([...TAGS, '1.0.1'], '1.0.0-preview.6de71b2', '1.0.0')).toMatchObject({ latest: '1.0.1', updateAvailable: true });
  });

  it('compares numerically (1.10.0 > 1.9.0) and copes with no releases at all', () => {
    expect(pickUpdate(['1.9.0', '1.10.0'], '1.9.0', '1.9.0').latest).toBe('1.10.0');
    expect(pickUpdate(['main', 'latest'], '1.0.0', '1.0.0')).toMatchObject({ latest: null, updateAvailable: false });
  });
});
