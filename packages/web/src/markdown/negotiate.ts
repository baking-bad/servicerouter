// Every public page has a Markdown version (WB-11): its URL with `.md`, or its own URL requested with
// `Accept: text/markdown`. Both are served by /md/<page path>.

export const markdownRoot = '/md';

const serviceId = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?';
const token = '[A-Za-z0-9_-]{1,128}';
// The HTML pages that have a Markdown version
const pagePatterns: readonly RegExp[] = [
  /^\/$/,
  /^\/discover$/,
  new RegExp(`^/discover/${serviceId}$`),
  /^\/agents$/,
  new RegExp(`^/topup/${token}$`),
];

/** Whether an HTML page has a Markdown version. */
export const hasMarkdown = (pathname: string): boolean => pagePatterns.some(pattern => pattern.test(pathname));

/** The page a `.md` URL stands for: `/index.md` → `/`, `/discover/<id>.md` → `/discover/<id>`. */
export const pageForMarkdownUrl = (pathname: string): string | undefined => {
  if (pathname === '/index.md')
    return '/';
  const page = pathname.endsWith('.md') ? pathname.slice(0, -'.md'.length) : '';

  return page !== '' && page !== '/' && hasMarkdown(page) ? page : undefined;
};

/** Where a page's Markdown is rendered. */
export const markdownRoute = (page: string): string => page === '/' ? markdownRoot : `${markdownRoot}${page}`;

/** A page's public Markdown URL, such as `/discover.md`. */
export const markdownUrl = (page: string): string => page === '/' ? '/index.md' : `${page}.md`;

const quality = (range: string | undefined, accept: readonly { readonly type: string; readonly q: number }[]): number =>
  accept.find(entry => entry.type === range)?.q ?? 0;

/** Whether an Accept header asks for Markdown over HTML, such as `text/markdown` or `text/markdown, text/html;q=0.5`. */
export const prefersMarkdown = (header: string | null | undefined): boolean => {
  if (!header)
    return false;
  const accept = header.split(',').map(part => {
    const [type = '', ...parameters] = part.split(';').map(piece => piece.trim().toLowerCase());
    const q = parameters.find(parameter => parameter.startsWith('q='));

    return { type, q: q === undefined ? 1 : Number(q.slice(2)) || 0 };
  });
  const markdown = quality('text/markdown', accept);

  return markdown > 0 && markdown > quality('text/html', accept);
};
