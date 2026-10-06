import { jsonLdText } from '../seo/jsonld';

/** schema.org data for the page (WB-11), with this response's CSP nonce (WB-12). */
export const JsonLd = ({ data, nonce }: { readonly data: Record<string, unknown>; readonly nonce: string | undefined }) => (
  <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />
);
