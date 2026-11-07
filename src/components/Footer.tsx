'use client';

import { useEffect, useState } from 'react';

export default function Footer() {
  const [v, setV] = useState<{ app: string; imageTag: string; sdk: string } | null>(null);

  useEffect(() => {
    fetch('/api/version')
      .then((r) => r.json())
      .then(setV)
      .catch(() => {});
  }, []);

  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-[color:var(--border)] px-4 py-2 text-center text-[11px] text-[color:var(--muted)]">
      <span>Proton Drive Backup</span>
      <span className="opacity-40">·</span>
      <span className="font-mono" title="App release (image tag: appVersion-revision)">{v ? `v${v.app}` : '…'}</span>
      <span className="opacity-40">·</span>
      <span className="font-mono" title="Bundled Proton Drive SDK version">SDK {v ? v.sdk : '…'}</span>
      <span className="opacity-40">·</span>
      <span className="opacity-70" title="Independent community project - not made, endorsed, or supported by Proton AG.">
        Unofficial · not affiliated with Proton
      </span>
    </footer>
  );
}
