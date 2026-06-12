import { getCliVersion } from './cli';

/**
 * On-demand update checks (run when the Settings panel is opened):
 *  - CLI: probe Proton's download server for a newer version than the running one.
 *  - Container: compare the built git sha (APP_VERSION) to GitHub's main HEAD.
 */

const DL = 'https://proton.me/download/drive/cli';
const REPO = process.env.GITHUB_REPO || 'traktuner/docker-proton-drive-backup';

async function versionExists(v: string): Promise<boolean> {
  try {
    const r = await fetch(`${DL}/${v}/linux-x64/proton-drive`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
    });
    return r.status === 200;
  } catch {
    return false;
  }
}

export interface CliUpdate {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export async function checkCliUpdate(): Promise<CliUpdate> {
  const current = await getCliVersion();
  let best = current;
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (m) {
    let [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // higher patches on the current minor
    for (let p = pat + 1; p <= pat + 30; p++) {
      if (await versionExists(`${maj}.${min}.${p}`)) best = `${maj}.${min}.${p}`;
      else break;
    }
    // higher minors (and their highest patch)
    for (let mi = min + 1; mi <= min + 10; mi++) {
      if (!(await versionExists(`${maj}.${mi}.0`))) break;
      best = `${maj}.${mi}.0`;
      for (let p = 1; p <= 30; p++) {
        if (await versionExists(`${maj}.${mi}.${p}`)) best = `${maj}.${mi}.${p}`;
        else break;
      }
    }
  }
  return { current, latest: best, updateAvailable: best !== current };
}

export interface ContainerUpdate {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

/** Parse a "<maj>.<min>.<patch>-<revision>" image tag into comparable parts. */
function parseImageTag(t: string): [number, number, number, number] | null {
  const m = t.match(/^(\d+)\.(\d+)\.(\d+)-(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

function tagGreater(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Newest published image tag vs. the running one. Only proper
 * "<cliVersion>-<revision>" tags from GHCR are considered; floating tags like
 * `latest` are ignored (a rebuild of `latest` alone must not read as an update).
 * Uses an anonymous pull token, which works for the public image without creds.
 */
export async function checkContainerUpdate(): Promise<ContainerUpdate> {
  const current = process.env.IMAGE_TAG || 'dev';
  try {
    const tok = await fetch(`https://ghcr.io/token?scope=repository:${REPO}:pull&service=ghcr.io`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!tok.ok) return { current, latest: null, updateAvailable: false };
    const token = (await tok.json())?.token;
    if (!token) return { current, latest: null, updateAvailable: false };

    const res = await fetch(`https://ghcr.io/v2/${REPO}/tags/list`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { current, latest: null, updateAvailable: false };

    const tags: string[] = (await res.json())?.tags ?? [];
    const versioned = tags
      .map((t) => ({ tag: t, parts: parseImageTag(t) }))
      .filter((x): x is { tag: string; parts: [number, number, number, number] } => x.parts !== null)
      .sort((a, b) => (tagGreater(a.parts, b.parts) ? 1 : -1));
    const newest = versioned[versioned.length - 1];
    if (!newest) return { current, latest: null, updateAvailable: false };

    const cur = parseImageTag(current);
    return {
      current,
      latest: newest.tag,
      updateAvailable: cur ? tagGreater(newest.parts, cur) : false,
    };
  } catch {
    return { current, latest: null, updateAvailable: false };
  }
}
