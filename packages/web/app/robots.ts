import type { MetadataRoute } from 'next';

import { readSettings } from '../src/config';

export const dynamic = 'force-dynamic';

// WB-11: every crawler, AI crawlers included, reads the public pages. The console, top-up links, and the
// Markdown renderer's own path stay out.
const robots = (): MetadataRoute.Robots => {
  const { siteUrl } = readSettings();

  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/console', '/topup/', '/md/'] }],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
};

export default robots;
