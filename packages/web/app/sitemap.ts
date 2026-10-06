import type { MetadataRoute } from 'next';

import { listAllCatalog } from '../src/api/catalog';
import { readSettings } from '../src/config';

export const dynamic = 'force-dynamic';

// WB-11: the public pages and every service
const sitemap = async (): Promise<MetadataRoute.Sitemap> => {
  const settings = readSettings();
  const catalog = await listAllCatalog(settings);
  const page = (path: string, priority: number) => ({ url: `${settings.siteUrl}${path}`, changeFrequency: 'daily' as const, priority });

  return [
    page('/', 1),
    page('/discover', 0.9),
    page('/agents', 0.8),
    page('/llms.txt', 0.7),
    ...catalog.value.services.map(item => ({ ...page(`/discover/${item.id}`, 0.6), lastModified: item.updatedAt })),
  ];
};

export default sitemap;
