import { getUploadConfig } from './upload-config';

/**
 * Upload speed limit.
 *
 * With the SDK in-process the app owns the byte stream, so the limit is a token
 * bucket on the bytes READ for upload, shared by all parallel uploads. That
 * replaces the CLI-era `tc` traffic shaping: no NET_ADMIN capability, no effect on
 * the web UI or other traffic, and it applies mid-run when the setting changes.
 * (Encryption adds a small, roughly constant overhead on the wire.)
 */
export function makeThrottle(limitKBps: () => number) {
  let tokens = 0;
  let last = Date.now();
  let rateAt = 0;
  let rate = 0;
  return async (bytes: number): Promise<void> => {
    const now = Date.now();
    if (now - rateAt > 1000) {
      rate = Math.max(0, limitKBps()) * 1024;
      rateAt = now;
    }
    if (rate <= 0) return;
    // Refill, capped at one second of burst.
    tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);
    last = now;
    tokens -= bytes;
    if (tokens < 0) {
      const waitMs = (-tokens / rate) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)));
    }
  };
}
