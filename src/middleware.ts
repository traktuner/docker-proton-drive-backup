import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Minimal CSRF guard for the (unauthenticated) API: reject state-changing requests
 * that a browser marks as cross-site. This blocks a malicious page from POSTing to
 * the app via the victim's browser (e.g. a hidden form triggering logout/trash/run).
 *
 * Uses `Sec-Fetch-Site` (sent automatically by modern browsers) rather than an
 * Origin/Host comparison, so it works behind any reverse proxy and never depends on
 * forwarded-host config. Non-browser clients (curl, scripts, older browsers) don't
 * send the header and are allowed, so existing automation keeps working.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function middleware(req: NextRequest) {
  if (!MUTATING.has(req.method)) return NextResponse.next();
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ error: 'cross-site request blocked' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
