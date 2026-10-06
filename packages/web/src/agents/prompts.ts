import type { SiteSettings } from '../config';

// One-line prompts people paste into an agent (WB-11). Each asks the agent to check before it spends.

/** The platform's: read the guide, and set up paying for calls. */
export const platformPrompt = ({ siteUrl }: SiteSettings): string =>
  `Read ${siteUrl}/llms.txt and set me up to pay for API calls through Service Router. Ask me before you sign up or spend anything.`;

/** A service's: read its instructions, and call it through the platform. */
export const servicePrompt = ({ title, llms }: { readonly title: string; readonly llms: string }): string =>
  `Use the ${title} API through Service Router. Read ${llms} for how to call and pay for it. Ask me before you spend anything.`;

/** A seller's: list an API on the platform. */
export const sellerPrompt = ({ siteUrl }: SiteSettings): string =>
  `Read ${siteUrl}/skills/servicerouter-seller/SKILL.md and help me list my API on Service Router. Show me the config before you submit it.`;
