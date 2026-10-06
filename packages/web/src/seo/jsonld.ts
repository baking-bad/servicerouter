import type { CatalogService } from '../api/types';
import type { SiteSettings } from '../config';
import { pitch, siteName } from '../content';

// schema.org JSON-LD (WB-11), so search engines and agents read the site's structure.

/** The landing page's: the site, its catalog search, and who runs it. */
export const websiteJsonLd = ({ siteUrl }: SiteSettings): Record<string, unknown> => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: siteName,
  url: siteUrl,
  description: pitch,
  potentialAction: {
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl}/discover?q={search_term_string}` },
    'query-input': 'required name=search_term_string',
  },
  publisher: { '@type': 'Organization', name: 'Baking Bad' },
});

/** A service page's: the API, its documents, and an offer per route. */
export const serviceJsonLd = ({ siteUrl }: SiteSettings, service: CatalogService): Record<string, unknown> => ({
  '@context': 'https://schema.org',
  '@type': 'WebAPI',
  name: service.title,
  description: service.summary,
  url: `${siteUrl}/discover/${service.id}`,
  documentation: service.docs.openapi,
  category: service.category,
  keywords: service.tags.join(', '),
  ...(service.contact.name ? { provider: { '@type': 'Organization', name: service.contact.name, ...(service.contact.url ? { url: service.contact.url } : {}) } } : {}),
  offers: service.routes.map(route => ({
    '@type': 'Offer',
    name: route.summary,
    price: route.price,
    priceCurrency: 'USD',
    url: `${service.payUrl}${route.path}`,
  })),
});

/** JSON for a `<script type="application/ld+json">`: nothing in it can close the tag. */
export const jsonLdText = (data: Record<string, unknown>): string => JSON.stringify(data).replace(/</g, '\\u003c');
