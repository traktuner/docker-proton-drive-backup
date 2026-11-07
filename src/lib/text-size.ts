/**
 * Text size (accessibility): scales the whole UI through the root font size.
 * Everything is sized in rem, so spacing grows with the text. Percentages keep the
 * user's own browser font setting as the base. Stored per browser (localStorage).
 */
export const TEXT_SIZES = [
  { id: 's', label: 'Small', pct: 93.75 },
  { id: 'm', label: 'Default', pct: 106.25 },
  { id: 'l', label: 'Large', pct: 118.75 },
  { id: 'xl', label: 'Larger', pct: 131.25 },
] as const;
export type TextSize = (typeof TEXT_SIZES)[number]['id'];
export const TEXT_SIZE_KEY = 'pdb.textSize';
export const DEFAULT_TEXT_SIZE: TextSize = 'm';

export function applyTextSize(id: TextSize): void {
  const t = TEXT_SIZES.find((x) => x.id === id) ?? TEXT_SIZES[1];
  document.documentElement.style.fontSize = `${t.pct}%`;
  document.documentElement.dataset.textSize = t.id;
}

/** Runs before first paint (inline in <head>): no jump from default to the saved size. */
export const TEXT_SIZE_BOOT = `(function(){try{var m={s:93.75,m:106.25,l:118.75,xl:131.25};var v=localStorage.getItem('${TEXT_SIZE_KEY}');var p=m[v]||m.m;document.documentElement.style.fontSize=p+'%';document.documentElement.dataset.textSize=m[v]?v:'m';}catch(e){}})();`;
