import { siteName } from '../content';
import { Logo } from './Logo';

const links = [
  { href: '/discover', label: 'Discover' },
  { href: '/agents', label: 'For agents' },
  { href: '/#sell', label: 'Sell your API' },
] as const;

export const SiteHeader = () => (
  <header className="site-header">
    <div className="container">
      <a href="/" className="brand" aria-label={`${siteName}, home`}>
        <Logo />
        <span>{siteName}</span>
      </a>
      <nav className="nav" aria-label="Main">
        {links.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}
      </nav>
    </div>
  </header>
);
