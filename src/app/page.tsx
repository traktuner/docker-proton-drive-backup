'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d) => router.replace(d.authenticated ? '/files' : '/onboarding'))
      .catch(() => router.replace('/onboarding'));
  }, [router]);

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="animate-pulse text-[color:var(--muted)]">Loading…</div>
    </div>
  );
}
