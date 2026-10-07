import { buyerSkillPath, sellerSkillPath } from '../agents/guide';
import { siteName } from '../content';

export const SiteFooter = () => (
  <footer className="site-footer">
    <div className="container">
      <span>{siteName} · by <a href="https://bakingbad.dev">Baking Bad</a></span>
      <nav className="footer-links" aria-label="For agents">
        <a href="/llms.txt">llms.txt</a>
        <a href="/llms-full.txt">llms-full.txt</a>
        <a href={buyerSkillPath}>Buyer skill</a>
        <a href={sellerSkillPath}>Seller skill</a>
        <a href="/sitemap.xml">Sitemap</a>
      </nav>
    </div>
  </footer>
);
