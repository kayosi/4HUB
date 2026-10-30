import type { InvoiceRow, PaymentRow, PlanRow, AdminPaymentRow, SubscriptionRow } from './repo.js';
import type { SubscriptionState } from './subscriptions.js';
import type { PaymentProvider } from './providers/types.js';

export const serializePlan = (p: PlanRow) => ({
  id: p.id, code: p.code, name: p.name, description: p.description, tier: p.tier, priceMinor: p.price_minor,
  currency: p.currency, durationDays: p.duration_days, features: p.features, isActive: p.is_active, sortOrder: p.sort_order,
});

export const serializeProvider = (p: PaymentProvider) => ({ id: p.id, name: p.displayName, method: p.method, currencies: p.supportedCurrencies });

/** Never includes provider references, idempotency keys or anything else a customer has no need to see. */
export const serializePayment = (p: PaymentRow) => ({
  id: p.id, status: p.status, amountMinor: p.amount_minor, currency: p.currency, provider: p.provider,
  planCode: p.plan_snapshot.code, planName: p.plan_snapshot.name, tier: p.plan_snapshot.tier,
  failureReason: p.failure_reason, payerHint: p.payer_hint, refundedMinor: p.refunded_minor,
  createdAt: p.created_at, paidAt: p.paid_at, refundedAt: p.refunded_at,
});

export const serializeAdminPayment = (p: AdminPaymentRow) => ({
  ...serializePayment(p), userEmail: p.user_email, userName: p.user_name, providerReference: p.provider_reference,
});

export const invoiceNumber = (i: Pick<InvoiceRow, 'seq' | 'issued_at'>) => `4H-${i.issued_at.getUTCFullYear()}-${String(i.seq).padStart(6, '0')}`;

export const serializeInvoice = (i: InvoiceRow) => ({
  id: i.id, number: invoiceNumber(i), description: i.description, amountMinor: i.amount_minor, currency: i.currency,
  status: i.status, periodStart: i.period_start, periodEnd: i.period_end, issuedAt: i.issued_at, paymentId: i.payment_id,
});

export const serializeSubscription = (s: SubscriptionRow, plan: PlanRow | undefined, st: SubscriptionState, now: Date) => ({
  tier: s.tier, planCode: plan?.code ?? null, planName: plan?.name ?? null, source: s.source,
  status: st.status, hasAccess: st.hasAccess, currentPeriodStart: s.current_period_start, currentPeriodEnd: s.current_period_end,
  graceEndsAt: st.graceEndsAt, cancelAtPeriodEnd: st.cancelAtPeriodEnd, paymentFailed: st.paymentFailed,
  daysLeft: st.status === 'active' ? Math.max(0, Math.ceil((s.current_period_end.getTime() - now.getTime()) / 86_400_000)) : 0,
});
