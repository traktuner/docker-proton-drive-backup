'use client';

import { useEffect, useState } from 'react';

const REPO = 'https://github.com/traktuner/docker-proton-drive-backup';
const SDK_REPO = 'https://github.com/ProtonDriveApps/sdk';

interface Version {
  app: string;
  build: string;
  imageTag: string;
  sdk: string;
  sdkTag: string;
}

export default function Footer() {
  const [v, setV] = useState<Version | null>(null);

  useEffect(() => {
    fetch('/api/version')
      .then((r) => r.json())
      .then(setV)
      .catch(() => {});
  }, []);

  // A real git sha links to that commit; local builds report "dev".
  const sha = v && /^[0-9a-f]{7,40}$/i.test(v.build) ? v.build.slice(0, 7) : null;
  const link = 'hover:underline decoration-dotted underline-offset-2';

  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-[color:var(--border)] px-4 py-2 text-center text-[11px] text-[color:var(--muted)]">
      <span>Proton Drive Backup</span>
      <span className="opacity-40">·</span>
      <span className="font-mono" title={v ? `App release ${v.app}, image ${v.imageTag}` : 'App release'}>
        {v ? `v${v.app}` : '…'}
        {sha && (
          <>
            {' '}
            (
            <a href={`${REPO}/commit/${v!.build}`} target="_blank" rel="noopener noreferrer" className={link}>
              {sha}
            </a>
            )
          </>
        )}
      </span>
      <span className="opacity-40">·</span>
      <span className="font-mono" title="Bundled Proton Drive SDK (TypeScript, @protontech/drive-sdk)">
        {v ? (
          <a href={`${SDK_REPO}/tree/${v.sdkTag}`} target="_blank" rel="noopener noreferrer" className={link}>
            Proton Drive SDK (TS) {v.sdk}
          </a>
        ) : (
          '…'
        )}
      </span>
      <span className="opacity-40">·</span>
      <span className="opacity-70" title="Independent community project - not made, endorsed, or supported by Proton AG.">
        Unofficial · not affiliated with Proton
      </span>
    </footer>
  );
}
