import type { CatalogPage } from '../api/types';
import type { SiteSettings } from '../config';
import { discoverMarkdown } from '../markdown/pages';
import { platformGuide } from './guide';
import { platformSkills, skillDocument } from './skills';

/** `/llms-full.txt` (WB-11): the guide, both skills, and the whole catalog, in one file. */
export const fullDocument = (settings: SiteSettings, catalog: { readonly value: CatalogPage; readonly sample: boolean }): string => [
  platformGuide(settings),
  ...platformSkills.map(skill => skillDocument(skill, settings)),
  discoverMarkdown(settings, catalog.value, { sort: 'popular' }, catalog.sample),
].join('\n---\n\n');
