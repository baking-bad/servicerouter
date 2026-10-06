import { textResponse } from '../../../src/agents/text';
import { getCatalogService, listCatalog } from '../../../src/api/catalog';
import { getTopup } from '../../../src/api/topup';
import { parseCatalogQuery } from '../../../src/catalog/query';
import { readSettings } from '../../../src/config';
import { hasMarkdown } from '../../../src/markdown/negotiate';
import { agentsMarkdown, discoverMarkdown, landingMarkdown, serviceMarkdown, topupMarkdown } from '../../../src/markdown/pages';

export const dynamic = 'force-dynamic';

const notFound = (): Response => new Response('# Not found\n', { status: 404, headers: { 'content-type': 'text/markdown; charset=utf-8' } });

/**
 * The Markdown version of a public page (WB-11). proxy.ts rewrites `<page>.md`, and a page asked for with
 * `Accept: text/markdown`, to `/md/<page>`.
 */
export const GET = async (request: Request, { params }: { readonly params: Promise<{ readonly path?: readonly string[] }> }): Promise<Response> => {
  const segments = (await params).path ?? [];
  const page = `/${segments.join('/')}`;
  if (!hasMarkdown(page))
    return notFound();

  const settings = readSettings();
  const [section, id] = segments;
  if (section === undefined) {
    const popular = await listCatalog(settings, { sort: 'popular', limit: 6 });

    return textResponse(landingMarkdown(settings, { services: popular.value.services, sample: popular.sample }), 'text/markdown');
  }
  if (section === 'agents')
    return textResponse(agentsMarkdown(settings), 'text/markdown');
  if (section === 'discover' && id === undefined) {
    const query = parseCatalogQuery(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listCatalog(settings, query);

    return textResponse(discoverMarkdown(settings, page.value, query, page.sample), 'text/markdown');
  }
  if (section === 'discover' && id !== undefined) {
    const found = await getCatalogService(settings, id);

    return found ? textResponse(serviceMarkdown(settings, found.value, found.sample), 'text/markdown') : notFound();
  }
  if (section === 'topup' && id !== undefined) {
    const found = await getTopup(settings, id);

    return found ? textResponse(topupMarkdown(found.value, found.sample), 'text/markdown') : notFound();
  }

  return notFound();
};
