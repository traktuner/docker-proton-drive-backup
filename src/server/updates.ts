/**
 * On-demand container update check (run when the Settings panel is opened): the
 * newest published release image vs. the running one. The Proton SDK is part of
 * the image, so there is no separate SDK download.
 *
 * Tag scheme (see docs/RELEASING.md):
 *  - releases:          "1.2.3" (plus "1.2", "1", "latest") — the only tags compared here
 *  - CLI-era releases:  "0.9.0-21" ("<version>-<revision>"), still understood for the running image
 *  - main / previews:   "main", "<sha>", "<branch>" — never offered as an update
 */
import { APP_VERSION } from './drive';

const REPO = process.env.GITHUB_REPO || 'traktuner/docker-proton-drive-backup';

export interface ContainerUpdate {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Release notes of `latest` on GitHub. */
  releaseUrl: string | null;
}

type Ver = [number, number, number];

const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const LEGACY = /^(\d+)\.(\d+)\.(\d+)-(\d+)$/; // 0.x: "<cliVersion>-<revision>"

function parse(re: RegExp, t: string): Ver | null {
  const m = re.exec(t);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Pure decision (tested): newest release tag vs. the running image. A preview or
 * main build counts as its app version, so it is only told about a NEWER release.
 */
export function pickUpdate(tags: string[], imageTag: string, appVersion: string): ContainerUpdate {
  const releases = tags.map((t) => ({ t, v: parse(RELEASE, t) })).filter((x): x is { t: string; v: Ver } => x.v !== null);
  releases.sort((a, b) => cmp(a.v, b.v));
  const newest = releases[releases.length - 1];
  const cur = parse(RELEASE, imageTag) ?? parse(LEGACY, imageTag) ?? parse(RELEASE, appVersion);
  if (!newest) return { current: imageTag, latest: null, updateAvailable: false, releaseUrl: null };
  const latest = newest.v.join('.');
  return {
    current: imageTag,
    latest,
    updateAvailable: cur ? cmp(newest.v, cur) > 0 : false,
    releaseUrl: `https://github.com/${REPO}/releases/tag/v${latest}`,
  };
}

/** Uses an anonymous pull token, which works for the public image without credentials. */
export async function checkContainerUpdate(): Promise<ContainerUpdate> {
  const current = process.env.IMAGE_TAG || 'dev';
  const none: ContainerUpdate = { current, latest: null, updateAvailable: false, releaseUrl: null };
  try {
    const tok = await fetch(`https://ghcr.io/token?scope=repository:${REPO}:pull&service=ghcr.io`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!tok.ok) return none;
    const token = (await tok.json())?.token;
    if (!token) return none;
    const res = await fetch(`https://ghcr.io/v2/${REPO}/tags/list?n=1000`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return none;
    const tags: string[] = (await res.json())?.tags ?? [];
    return pickUpdate(tags, current, APP_VERSION);
  } catch {
    return none;
  }
}
