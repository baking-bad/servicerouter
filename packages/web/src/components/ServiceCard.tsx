import type { CatalogItem } from '../api/types';
import { serviceHref } from '../catalog/query';
import { compactCount, percent } from '../format';
import { displayUsd } from '../money';
import { MethodBadges } from './MethodBadges';

/** One service in a list: what it does, its price, how to pay, and how it performs. A routed endpoint is labeled Unverified (AR14). */
export const ServiceCard = ({ item, categoryTitle }: { readonly item: CatalogItem; readonly categoryTitle: string | undefined }) => (
  <a href={serviceHref(item)} className="card card-link service-card" data-service={item.id} {...item.verified ? {} : { rel: 'nofollow' }}>
    <span className="label">{item.verified ? categoryTitle ?? item.category : 'Unverified'}</span>
    <h3 title={item.title}>{item.title}</h3>
    <p className="summary">{item.summary}</p>
    <div className="row spread">
      <span><span className="faint">from </span><span className="price num">{displayUsd(item.priceFrom)}</span></span>
      <MethodBadges methods={item.methods} />
    </div>
    {item.verified
      ? (
        <span className="metrics num">
          <span><b>{compactCount(item.stats.calls30d)}</b> calls in 30 days</span>
          <span><b>{percent(item.stats.successRate)}</b> success</span>
        </span>
      )
      : <span className="metrics">No stats for a routed endpoint</span>}
  </a>
);
