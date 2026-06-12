import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, runCli, getCliAppVersion } from './cli';

/**
 * Storage usage. The CLI exposes no quota command, but it keeps an authenticated
 * session - so we call Proton's /core/v4/users endpoint directly with that
 * session's token (same data the official web client shows). Cached briefly.
 */

const BASE = `https://${process.env.PROTON_DRIVE_BASE_URL || 'drive-api.proton.me'}`;

export interface Quota {
  maxSpace: number; // total account quota (unified across products)
  usedSpace: number; // total used across products
  driveUsed: number; // used by Drive specifically
}

export interface UserInfo {
  email: string | null;
  displayName: string | null;
  quota: Quota | null;
  productUsed: Record<string, number>;
}

function readSession(): { uid: string; token: string } | null {
  try {
    const raw = fs.readFileSync(path.join(CACHE_DIR, 'auth-session.json'), 'utf8');
    const s = JSON.parse(raw).session ?? {};
    const token = s.accessToken ?? s.AccessToken;
    if (s.uid && token) return { uid: s.uid, token };
  } catch {
    /* no session */
  }
  return null;
}

async function callUsers(): Promise<Response | null> {
  const sess = readSession();
  if (!sess) return null;
  const appVersion = await getCliAppVersion();
  return fetch(`${BASE}/core/v4/users`, {
    headers: {
      'x-pm-uid': sess.uid,
      Authorization: `Bearer ${sess.token}`,
      'x-pm-appversion': appVersion,
      Accept: 'application/vnd.protonmail.v1+json',
    },
    signal: AbortSignal.timeout(15_000),
  });
}

let cache: { data: UserInfo; at: number } | null = null;
const TTL = 60_000;

export async function getUserInfo(force = false): Promise<UserInfo | null> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.data;
  try {
    let res = await callUsers();
    if (res && res.status === 401) {
      // Token may be stale - a CLI call refreshes and rewrites the session file.
      await runCli(['filesystem', 'list', '/my-files', '-j'], 20_000).catch(() => {});
      res = await callUsers();
    }
    if (!res || !res.ok) return null;
    const j = await res.json();
    const u = j?.User;
    if (!u || typeof u.MaxSpace !== 'number') return null;
    const data: UserInfo = {
      email: u.Email ?? null,
      displayName: u.DisplayName ?? u.Name ?? null,
      productUsed: u.ProductUsedSpace ?? {},
      quota: {
        maxSpace: u.MaxSpace,
        usedSpace: u.UsedSpace ?? 0,
        driveUsed: u.ProductUsedSpace?.Drive ?? 0,
      },
    };
    cache = { data, at: Date.now() };
    return data;
  } catch {
    return null;
  }
}

/** Quota only (used by the header storage bar). */
export async function getQuota(force = false): Promise<Quota | null> {
  return (await getUserInfo(force))?.quota ?? null;
}
