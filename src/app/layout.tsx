import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { ToastProvider } from '@/components/Toast';
import { AuthProvider } from '@/components/AuthProvider';
import { TEXT_SIZE_BOOT } from '@/lib/text-size';
import './globals.css';

// Geist gives the app a deliberate, modern product typeface instead of the
// system stack. The `geist` package bundles the font files locally (sets
// --font-sans / --font-mono), so there's no build-time Google Fonts fetch and no
// layout shift — deterministic for the container build.

export const metadata: Metadata = {
  title: 'Proton Drive Backup',
  description: 'Back up local folders to Proton Drive',
  appleWebApp: { capable: true, title: 'Drive Backup', statusBarStyle: 'black-translucent' },
};

// Edge-to-edge on phones (content respects the safe areas), dark browser chrome.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark',
  themeColor: '#16141c',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Saved text size before first paint (see src/lib/text-size.ts). */}
        <script dangerouslySetInnerHTML={{ __html: TEXT_SIZE_BOOT }} />
      </head>
      <body>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
