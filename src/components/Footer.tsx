'use client';

import { useEffect, useState } from 'react';

export default function Footer() {
  const [v, setV] = useState<{ imageTag: string; cli: string } | null>(null);

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
      <span className="font-mono" title="Container image tag (cliVersion-revision)">{v ? v.imageTag : '…'}</span>
      <span className="opacity-40">·</span>
      <span className="font-mono" title="proton-drive CLI version">CLI {v ? v.cli : '…'}</span>
      <span className="opacity-40">·</span>
      <span className="opacity-70" title="Independent community project - not made, endorsed, or supported by Proton AG.">
        Unofficial · not affiliated with Proton
      </span>
    </footer>
  );
}
