import type { PaymentMethod } from './api/types';

// The website's words, shared by each page and its Markdown version (WB-11), so the two never drift.

export const siteName = 'Service Router';
export const tagline = 'Pay-per-call APIs for every agent';
export const pitch = 'One account and one payment key pay any API listed here. Agents pay per call with prepaid credits, x402, or MPP, and sellers get paid for every successful answer.';

export interface Step {
  readonly title: string;
  readonly text: string;
}

export const buyerSteps: readonly Step[] = [
  { title: 'Sign up in one call', text: 'One POST creates an account and its master key. No email, no card, no forms.' },
  { title: 'Give agents payment keys', text: 'Each key has its own daily budget, total allowance, price cap, and expiry. The master key stays with you.' },
  { title: 'Call any listed API', text: 'Pay with credits, x402, or MPP. Only successful answers are charged.' },
];

export const sellerSteps: readonly Step[] = [
  { title: 'Describe your API', text: 'One YAML file: your OpenAPI document, prices per route, and your payout address.' },
  { title: 'Submit it with your keys', text: 'Upstream keys are sealed, bound to your host, and never shown to agents.' },
  { title: 'Get paid per call', text: 'Agents find you in the catalog and in generated llms.txt, skills, and OpenAPI. Payouts are monthly, in USDM.' },
];

export interface MethodInfo {
  readonly title: string;
  readonly short: string;
  readonly text: string;
  readonly networks: string;
}

export const methodInfo: Readonly<Record<PaymentMethod, MethodInfo>> = {
  credits: {
    title: 'Credits',
    short: 'Credits',
    text: 'A prepaid USD balance and a payment key. No on-chain fee per call, so sub-cent prices work.',
    networks: 'Top up with USDM on Cardano',
  },
  x402: {
    title: 'x402',
    short: 'x402',
    text: 'Pay each call from a wallet, no account needed. Settled through the facilitator after a successful answer.',
    networks: 'USDC on Base and Solana, USDM on Cardano',
  },
  mpp: {
    title: 'MPP',
    short: 'MPP',
    text: 'The Machine Payments Protocol: the agent signs a stablecoin transfer, broadcast only after a successful answer.',
    networks: 'Stablecoins on Tempo',
  },
};

export const sampleNotice = 'Sample data: shown until the Platform API serves it. These services and numbers aren\'t real.';
