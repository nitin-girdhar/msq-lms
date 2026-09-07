import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ServiceWorkerRegistrar, pwaViewport, pwaAppleWebApp, pwaIcons, pwaAppleCapableMeta, pwaManifest } from '@platform/ui-kit';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const viewport = pwaViewport;

export const metadata: Metadata = {
  title: 'FitClass Leads Dashboard',
  description: 'Internal lead management for FitClass branches',
  appleWebApp: pwaAppleWebApp,
  icons: pwaIcons,
  manifest: pwaManifest,
  other: pwaAppleCapableMeta,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.className} dashboard-shell bg-[#F8FAFC]`}
        suppressHydrationWarning
      >
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
