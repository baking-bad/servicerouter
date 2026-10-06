import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { readSettings } from '../src/config';
import { pitch, siteName, tagline } from '../src/content';
import { SiteFooter } from '../src/components/SiteFooter';
import { SiteHeader } from '../src/components/SiteHeader';
import { requestNonce } from '../src/nonce';

// Settings come from the environment per request, so one image serves every deployment (WB-6)
export const generateMetadata = async (): Promise<Metadata> => {
  const { siteUrl } = readSettings();

  return {
    metadataBase: new URL(siteUrl),
    title: { default: `${siteName}: ${tagline}`, template: `%s · ${siteName}` },
    description: pitch,
    applicationName: siteName,
    openGraph: { siteName, type: 'website', title: `${siteName}: ${tagline}`, description: pitch },
    twitter: { card: 'summary_large_image' },
    icons: { icon: [{ url: '/logo.svg', type: 'image/svg+xml' }, { url: '/icon', type: 'image/png' }], apple: '/apple-icon' },
  };
};

export const viewport: Viewport = { themeColor: '#17191B', colorScheme: 'dark' };

const RootLayout = async ({ children }: { readonly children: ReactNode }) => {
  // Every page renders per request, with its own CSP nonce (WB-12)
  await requestNonce();

  return (
    <html lang="en">
      <body>
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
};

export default RootLayout;
