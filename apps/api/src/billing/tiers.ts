/**
 * Tier registry: the ONE place that says what each subscription tier unlocks.
 * Adding VIP or Copy Trading later = add an entry here (and plans in the database); no other code changes
 * are needed for the subscription, payment or entitlement machinery.
 */
export type Capability = 'premium_signals';

interface TierDef {
  rank: number;
  label: string;
  capabilities: readonly Capability[];
}

export const TIERS = {
  free: { rank: 0, label: 'Free', capabilities: [] },
  premium: { rank: 1, label: 'Premium', capabilities: ['premium_signals'] },
  // vip: { rank: 2, label: 'VIP', capabilities: ['premium_signals', 'vip_signals'] },
  // copy_trading: { rank: 2, label: 'Copy Trading', capabilities: ['premium_signals', 'copy_trading'] },
} as const satisfies Record<string, TierDef>;

export type TierId = keyof typeof TIERS;
export const TIER_IDS = Object.keys(TIERS) as TierId[];
export const isTier = (v: string): v is TierId => v in TIERS;
export const PAID_TIER_IDS = TIER_IDS.filter((t) => t !== 'free');

/** Currencies with two minor-unit decimals; keeps price maths and M-Pesa whole-shilling rules unambiguous. */
export const SUPPORTED_CURRENCIES = ['KES', 'USD', 'EUR', 'GBP', 'ZAR', 'NGN', 'GHS'] as const;
