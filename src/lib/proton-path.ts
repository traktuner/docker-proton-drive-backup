/** The "My files" root of a Proton Drive volume, as the app writes Drive paths. */
export const PROTON_ROOT = '/my-files';

/**
 * One spelling per Drive location: "/Backups", "Backups/", "/my-files/Backups" and
 * "//Backups" all become "/my-files/Backups". Used for display paths and to tell
 * whether two sets point at the same Drive folder.
 */
export function normalizeProtonPath(p: string): string {
  const segs = (p || '').split('/').filter(Boolean);
  if (segs[0] === PROTON_ROOT.slice(1)) segs.shift();
  return segs.length ? `${PROTON_ROOT}/${segs.join('/')}` : PROTON_ROOT;
}
