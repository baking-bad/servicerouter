import { getCatalogService } from '../api/catalog';
import type { CatalogService } from '../api/types';
import { isMocked, readSettings } from '../config';

// The website serves a service's agent documents while they are sample data (WB-10). With the
// `agent-docs` group off, these URLs are 404 and every link points at the Platform API's (AR1).

const notFound = (): Response => new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export const serviceDocument = async (
  id: string,
  render: (service: CatalogService, siteUrl: string) => { readonly body: string; readonly contentType: string },
): Promise<Response> => {
  const settings = readSettings();
  if (!isMocked(settings, 'agent-docs'))
    return notFound();
  const found = await getCatalogService(settings, id);
  if (!found)
    return notFound();
  const { body, contentType } = render(found.value, settings.siteUrl);

  return new Response(body, { headers: { 'content-type': contentType, 'cache-control': 'public, max-age=300' } });
};
