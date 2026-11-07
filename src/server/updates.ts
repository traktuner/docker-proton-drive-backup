/**
 * On-demand container update check (run when the Settings panel is opened):
 * newest published "<appVersion>-<revision>" image tag vs. the running one.
 * The Proton SDK is part of the image, so there is no separate SDK download.
 */

const REPO = process.env.GITHUB_REPO || 'traktuner/docker-proton-drive-backup';

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
