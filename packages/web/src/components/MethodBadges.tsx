import type { PaymentMethod } from '../api/types';
import { methodInfo } from '../content';

/** How a service or route can be paid (PR-1). */
export const MethodBadges = ({ methods }: { readonly methods: readonly PaymentMethod[] }) => (
  <span className="row">
    {methods.map(method => <span key={method} className={method === 'credits' ? 'badge badge-mint' : 'badge'} title={methodInfo[method].text}>{methodInfo[method].short}</span>)}
  </span>
);
