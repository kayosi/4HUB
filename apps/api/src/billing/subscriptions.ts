import { TIERS, isTier, type Capability, type TierId } from './tiers.js';

export interface SubscriptionFields {
  tier: string;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  revoked_at: Date | null;
  last_failed_payment_at: Date | null;
}

export type SubscriptionStatus = 'active' | 'grace' | 'expired' | 'cancelled';

export interface SubscriptionState {
  status: SubscriptionStatus;
  /** True while the member is entitled to the tier's capabilities. */
  hasAccess: boolean;
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  paymentFailed: boolean;
}

export const DAY_MS = 86_400_000;
export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);

/**
 * THE rule that maps stored dates to a state. Access is never stored, only derived from this at the moment
 * of the request, so a subscription lapses on time with no background job.
 *
 *   revoked (refund / admin revoke)            -> cancelled, no access
 *   now <  period end                          -> active   (access; may be flagged "cancels at period end")
 *   now >= end, not cancelling, within grace   -> grace    (access retained while a renewal is overdue)
 *   otherwise                                  -> expired, no access
 */
export function subscriptionState(sub: SubscriptionFields, now: Date, graceDays: number): SubscriptionState {
  const end = sub.current_period_end;
  const base = { cancelAtPeriodEnd: sub.cancel_at_period_end, paymentFailed: sub.last_failed_payment_at !== null };
  if (sub.revoked_at !== null) return { ...base, status: 'cancelled', hasAccess: false, graceEndsAt: null };
  if (now < end) return { ...base, status: 'active', hasAccess: true, graceEndsAt: null };
  const graceEndsAt = sub.cancel_at_period_end ? null : addDays(end, graceDays);
  if (graceEndsAt !== null && now < graceEndsAt) return { ...base, status: 'grace', hasAccess: true, graceEndsAt };
  return { ...base, status: 'expired', hasAccess: false, graceEndsAt };
}

export interface Entitlement {
  /** Highest tier the member currently has access to. */
  tier: TierId;
  capabilities: Capability[];
}

export const FREE_ENTITLEMENT: Entitlement = { tier: 'free', capabilities: [] };

export function buildEntitlement(subs: SubscriptionFields[], now: Date, graceDays: number): Entitlement {
  const tiers = subs.filter((s) => isTier(s.tier) && subscriptionState(s, now, graceDays).hasAccess).map((s) => s.tier as TierId);
  if (tiers.length === 0) return FREE_ENTITLEMENT;
  const best = tiers.reduce((a, b) => (TIERS[b].rank > TIERS[a].rank ? b : a));
  const caps = new Set<Capability>();
  for (const t of tiers) for (const c of TIERS[t].capabilities) caps.add(c);
  return { tier: best, capabilities: [...caps] };
}
