import { parseUsd } from '../../money';
import type { KeyLimits, PaymentKey } from '../types';

// The payment key form's fields (AK-6), checked in the browser before the API checks them again.

export interface KeyFormValues {
  readonly label: string;
  readonly dailyBudget: string;
  readonly allowance: string;
  readonly maxPrice: string;
  // yyyy-mm-dd, or empty
  readonly expires: string;
}

export const emptyKeyForm: KeyFormValues = { label: '', dailyBudget: '5', allowance: '', maxPrice: '', expires: '' };

export const keyFormOf = (key: PaymentKey): KeyFormValues => ({
  label: key.label ?? '',
  dailyBudget: key.dailyBudget,
  allowance: key.allowance ?? '',
  maxPrice: key.maxPrice ?? '',
  expires: key.expiresAt?.slice(0, 10) ?? '',
});

/**
 * The form's values as the API's limits, or the first problem. On create, empty optional limits are left
 * out. On change, they are `null`, which clears them.
 */
export const toKeyLimits = (values: KeyFormValues, mode: 'create' | 'change', now: Date): { readonly limits: KeyLimits } | { readonly problem: string } => {
  const amount = (field: string, text: string): string | undefined | { readonly problem: string } => {
    const trimmed = text.trim().replace(/^\$/, '');
    if (trimmed === '')
      return undefined;

    return parseUsd(trimmed) === undefined ? { problem: `${field} must be a USD amount, such as 0.05` } : trimmed;
  };
  const dailyBudget = amount('The daily budget', values.dailyBudget);
  const allowance = amount('The allowance', values.allowance);
  const maxPrice = amount('The maximum price', values.maxPrice);
  for (const value of [dailyBudget, allowance, maxPrice]) {
    if (typeof value === 'object')
      return value;
  }
  if (dailyBudget === undefined)
    return { problem: 'Every payment key has a daily budget' };
  if (values.label.length > 60)
    return { problem: 'The label is longer than 60 characters' };
  let expiresAt: string | undefined;
  if (values.expires !== '') {
    const end = new Date(`${values.expires}T23:59:59.000Z`);
    if (Number.isNaN(end.getTime()) || end.getTime() <= now.getTime())
      return { problem: 'The expiry must be a day in the future' };
    expiresAt = end.toISOString();
  }
  const optional = (value: string | undefined) => mode === 'change' ? value ?? null : value;
  const label = values.label.trim() === '' ? undefined : values.label.trim();

  return {
    limits: Object.fromEntries(Object.entries({
      label: optional(label),
      dailyBudget,
      allowance: optional(allowance as string | undefined),
      maxPrice: optional(maxPrice as string | undefined),
      expiresAt: optional(expiresAt),
    }).filter(([, value]) => value !== undefined)) as KeyLimits,
  };
};
