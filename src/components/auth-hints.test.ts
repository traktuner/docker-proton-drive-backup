import { describe, expect, it } from 'vitest';
import { looksLikeAuthError } from '@/components/AuthProvider';
import { cleanDriveError } from '@/server/drive';

describe('looksLikeAuthError (client mirror of the server patterns)', () => {
  it('shows the reconnect banner for "You need to login first"', () => {
    expect(looksLikeAuthError('You need to login first')).toBe(true);
  });

  it('recognises every message the server sends for a lost session', () => {
    expect(looksLikeAuthError(cleanDriveError(null, 'UNAUTHENTICATED'))).toBe(true);
    expect(looksLikeAuthError('Proton session expired — reconnect to Proton Drive to resume.')).toBe(true);
    expect(looksLikeAuthError(cleanDriveError(null, 'NETWORK'))).toBe(false);
  });

  it('stays false for unrelated text', () => {
    expect(looksLikeAuthError('network connection refused')).toBe(false);
    expect(looksLikeAuthError('')).toBe(false);
    expect(looksLikeAuthError(null)).toBe(false);
  });
});
