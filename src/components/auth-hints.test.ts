import { describe, expect, it } from 'vitest';
import { looksLikeAuthError } from '@/components/AuthProvider';
import { looksUnauthenticated } from '@/server/cli';

describe('looksLikeAuthError (client mirror of the server patterns)', () => {
  it('shows the reconnect banner for "You need to login first"', () => {
    expect(looksLikeAuthError('You need to login first')).toBe(true);
  });

  it('agrees with the server on every text that the server treats as a lost session', () => {
    for (const text of [
      'no session',
      'Please login first',
      'Error: not authenticated',
      'user is not signed in',
      'ERR_SECRETS could not be read',
      'You need to login first',
    ]) {
      expect(looksUnauthenticated(text)).toBe(true);
      expect(looksLikeAuthError(text)).toBe(true);
    }
  });

  it('stays false for unrelated text', () => {
    expect(looksLikeAuthError('network connection refused')).toBe(false);
    expect(looksLikeAuthError('')).toBe(false);
    expect(looksLikeAuthError(null)).toBe(false);
  });
});
