import type { Metadata } from 'next';

import { listCatalog } from '../../src/api/catalog';
import { catalogSorts, paymentMethods, type CatalogCategory, type CatalogQuery } from '../../src/api/types';
import { catalogQueryParams, parseCatalogQuery, type SearchParams } from '../../src/catalog/query';
import { SampleBadge } from '../../src/components/SampleBadge';
import { ServiceCard } from '../../src/components/ServiceCard';
import { readSettings } from '../../src/config';
import { methodInfo } from '../../src/content';

interface DiscoverProps {
  readonly searchParams: Promise<SearchParams>;
}

export const generateMetadata = async ({ searchParams }: DiscoverProps): Promise<Metadata> => {
  const params = catalogQueryParams(parseCatalogQuery(await searchParams)).toString();

  return {
    title: 'Discover services',
    description: 'Every API listed on Service Router, with prices, payment methods, and how each performs. Filter by category, volume, price, and payment method.',
    alternates: { canonical: '/discover', types: { 'text/markdown': `/discover.md${params ? `?${params}` : ''}` } },
  };
};

const sortLabels = { popular: 'Most called', price: 'Cheapest', newest: 'Newest', success: 'Most reliable' } as const;
const priceCaps = ['0.0005', '0.001', '0.005', '0.01', '0.05'] as const;

const href = (query: CatalogQuery, changes: Partial<Record<keyof CatalogQuery, string | undefined>>): string => {
  const params = catalogQueryParams(query, { ...changes, cursor: undefined }).toString();

  return `/discover${params ? `?${params}` : ''}`;
};

// Top-level categories, each followed by its subcategories, the empty ones left out
const categoryTree = (categories: readonly CatalogCategory[]): readonly (CatalogCategory & { readonly sub: boolean })[] =>
  categories.filter(category => !category.id.includes('/')).flatMap(top => [
    { ...top, sub: false },
    ...categories.filter(category => category.id.startsWith(`${top.id}/`)).map(category => ({ ...category, sub: true })),
  ]).filter(category => category.count > 0);

const DiscoverPage = async ({ searchParams }: DiscoverProps) => {
  const settings = readSettings();
  const query = parseCatalogQuery(await searchParams);
  const { value: page, sample } = await listCatalog(settings, query);
  const titles = new Map(page.categories.map(category => [category.id, category.title]));

  return (
    <div className="container">
      <section className="section">
        <div className="section-head">
          <div className="stack">
            <div className="row"><h1>Discover services</h1><SampleBadge sample={sample} /></div>
            <p className="muted">Every API here is called at <code>{settings.payUrl}/service/&lt;id&gt;/…</code> and paid per call. Only successful answers are charged.</p>
          </div>
        </div>

        <div className="discover">
          <nav className="category-tree card" aria-label="Categories">
            <a href={href(query, { category: undefined })} aria-current={query.category === undefined ? 'page' : undefined}>
              <span>All</span>
            </a>
            {categoryTree(page.categories).map(category => (
              <a key={category.id} href={href(query, { category: category.id })} className={category.sub ? 'sub' : undefined} aria-current={query.category === category.id ? 'page' : undefined}>
                <span>{category.title}</span><span className="count num">{category.count}</span>
              </a>
            ))}
          </nav>

          <div>
            <form className="filters" method="get" action="/discover" role="search">
              {query.category ? <input type="hidden" name="category" value={query.category} /> : null}
              <input className="input" type="search" name="q" placeholder="Search services" defaultValue={query.q ?? ''} aria-label="Search" />
              <select className="select" name="method" defaultValue={query.method ?? ''} aria-label="Payment method">
                <option value="">Any payment method</option>
                {paymentMethods.map(method => <option key={method} value={method}>{methodInfo[method].title}</option>)}
              </select>
              <select className="select" name="maxPrice" defaultValue={query.maxPrice ?? ''} aria-label="Maximum price">
                <option value="">Any price</option>
                {priceCaps.map(cap => <option key={cap} value={cap}>Up to ${cap}</option>)}
              </select>
              <select className="select" name="sort" defaultValue={query.sort} aria-label="Sort">
                {catalogSorts.map(sort => <option key={sort} value={sort}>{sortLabels[sort]}</option>)}
              </select>
              <button className="button button-primary" type="submit">Apply</button>
            </form>

            {page.services.length === 0
              ? <div className="card muted">No service matches. <a href="/discover" className="mono">Clear the filters</a></div>
              : (
                <div className="grid grid-2" data-results={page.services.length}>
                  {page.services.map(item => <ServiceCard key={item.id} item={item} categoryTitle={titles.get(item.category)} />)}
                </div>
              )}
            {page.next === null
              ? null
              : <div className="row mt-16"><a className="button" href={`/discover?${catalogQueryParams(query, { cursor: page.next }).toString()}`}>More services</a></div>}
            <p className="faint mt-16">
              For agents: this list as Markdown at <a className="mono" href={`/discover.md${catalogQueryParams(query).toString() ? `?${catalogQueryParams(query).toString()}` : ''}`}>/discover.md</a>.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default DiscoverPage;
