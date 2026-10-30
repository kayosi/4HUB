export interface Plan {
  id: string; code: string; name: string; description: string; tier: string; priceMinor: number; currency: string;
  durationDays: number | null; features: string[]; isActive: boolean; sortOrder: number;
}
export interface ProviderInfo { id: string; name: string; method: 'mobile_money' | 'card' | 'sandbox'; currencies: string[] }

export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'refunded' | 'partially_refunded';
export interface Payment {
  id: string; status: PaymentStatus; amountMinor: number; currency: string; provider: string; planCode: string; planName: string;
  tier: string; failureReason: string | null; payerHint: string | null; refundedMinor: number; createdAt: string; paidAt: string | null; refundedAt: string | null;
}
export type NextAction = { type: 'prompt'; message: string } | { type: 'redirect'; url: string };

export type SubscriptionStatus = 'active' | 'grace' | 'expired' | 'cancelled';
export interface Subscription {
  tier: string; planCode: string | null; planName: string | null; source: 'payment' | 'admin_grant'; status: SubscriptionStatus; hasAccess: boolean;
  currentPeriodStart: string; currentPeriodEnd: string; graceEndsAt: string | null; cancelAtPeriodEnd: boolean; paymentFailed: boolean; daysLeft: number;
}
export interface Invoice {
  id: string; number: string; description: string; amountMinor: number; currency: string; status: 'paid' | 'refunded' | 'partially_refunded';
  periodStart: string | null; periodEnd: string | null; issuedAt: string; paymentId: string;
}
export interface Receipt {
  number: string; customer: { name: string; email: string }; provider: string | null; payerHint: string | null; transactionId: string | null;
  paidAt: string | null; refundedMinor: number;
}

/** Prices are integer minor units (two decimals for every supported currency). */
export const toMajor = (minor: number) => minor / 100;
export const toMinor = (major: number) => Math.round(major * 100);

export function formatMoney(minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(toMajor(minor));
}

export const perMonthMinor = (p: Pick<Plan, 'priceMinor' | 'durationDays'>): number | null =>
  p.durationDays ? Math.round(p.priceMinor / (p.durationDays / 30)) : null;

/** Percentage saved versus buying the shortest paid plan repeatedly. */
export function savingsPercent(plan: Plan, all: Plan[]): number {
  const paid = all.filter((p) => p.tier === plan.tier && p.durationDays && p.currency === plan.currency);
  const base = paid.sort((a, b) => a.durationDays! - b.durationDays!)[0];
  const mine = perMonthMinor(plan);
  const ref = base ? perMonthMinor(base) : null;
  if (!base || base.id === plan.id || mine === null || ref === null || ref <= 0) return 0;
  return Math.max(0, Math.round((1 - mine / ref) * 100));
}

export const durationLabel = (days: number | null) =>
  days === null ? '' : days % 365 === 0 ? (days === 365 ? 'year' : `${days / 365} years`) : days === 30 ? 'month' : days === 90 ? '3 months' : `${days} days`;

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Pending', succeeded: 'Paid', failed: 'Failed', cancelled: 'Cancelled', refunded: 'Refunded', partially_refunded: 'Partly refunded',
};
export const paymentTone = (s: PaymentStatus) => (s === 'succeeded' ? 'positive' : s === 'failed' || s === 'cancelled' ? 'negative' : 'muted');
export const SUBSCRIPTION_LABEL: Record<SubscriptionStatus, string> = { active: 'Active', grace: 'Renewal overdue', expired: 'Expired', cancelled: 'Cancelled' };

const FAILURES: Record<string, string> = {
  initiation_failed: 'We could not start this payment. Nothing was charged.',
  amount_mismatch: 'We could not confirm the amount for this payment. If you were charged, contact support and we will sort it out.',
  mpesa_1032: 'You cancelled the request on your phone.',
  mpesa_1: 'The M-Pesa payment was declined. Check your balance and try again.',
  mpesa_2001: 'The M-Pesa PIN was wrong.',
  abandoned: 'The card checkout was closed before payment.',
};
export const failureMessage = (code: string | null) => (code && FAILURES[code]) || 'The payment was not completed. You have not been charged for premium.';

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
