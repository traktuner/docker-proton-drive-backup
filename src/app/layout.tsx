import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { ToastProvider } from '@/components/Toast';
import './globals.css';

// Geist gives the app a deliberate, modern product typeface instead of the
// system stack. The `geist` package bundles the font files locally (sets
// --font-sans / --font-mono), so there's no build-time Google Fonts fetch and no
// layout shift — deterministic for the container build.

export const metadata: Metadata = {
  title: 'Proton Drive Backup',
  description: 'Back up local folders to Proton Drive',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
