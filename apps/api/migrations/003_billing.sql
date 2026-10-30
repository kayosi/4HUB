-- Subscription plans. Prices are integer minor units (cents). A plan's `tier` maps to capabilities in code
-- (src/billing/tiers.ts), so new tiers (VIP, copy trading) are new plans + a registry entry, not a new system.
create table plans (
  id uuid primary key,
  code text not null unique,
  name text not null,
  description text not null default '',
  tier text not null,
  price_minor integer not null check (price_minor >= 0),
  currency text not null,
  duration_days integer check (duration_days is null or duration_days > 0),
  features jsonb not null default '[]',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every payment attempt. Amount/currency/plan are SNAPSHOTS taken server-side at checkout, so later plan edits
-- never change what a customer owes or what a webhook is verified against. No card data is ever stored.
create table payments (
  id uuid primary key,
  user_id uuid not null references users(id),
  plan_id uuid not null references plans(id),
  plan_snapshot jsonb not null,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null,
  provider text not null,
  provider_reference text,
  provider_transaction_id text,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  failure_reason text,
  payer_hint text,
  idempotency_key text,
  refunded_minor integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz
);
create unique index payments_provider_ref_idx on payments(provider, provider_reference);
create unique index payments_idempotency_idx on payments(user_id, idempotency_key);
create index payments_user_idx on payments(user_id);
create index payments_status_idx on payments(status);

-- Webhook inbox: (provider, event_id) is unique, which is what makes redelivery harmless.
create table payment_events (
  id uuid primary key,
  provider text not null,
  event_id text not null,
  event_type text not null,
  provider_reference text,
  payment_id uuid references payments(id),
  outcome text not null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);

-- One subscription per member per tier. Access is DERIVED from these dates (see subscriptions.ts), never stored.
create table subscriptions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  plan_id uuid not null references plans(id),
  tier text not null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  revoked_at timestamptz,
  source text not null check (source in ('payment', 'admin_grant')),
  last_failed_payment_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tier)
);

-- Ledger of granted time. payment_id is unique: a payment can grant access at most once, no matter how many
-- events or retries reference it. Admin grants have no payment.
create table subscription_periods (
  id uuid primary key,
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  payment_id uuid unique references payments(id),
  plan_id uuid not null references plans(id),
  kind text not null check (kind in ('initial', 'renewal', 'upgrade', 'reactivation', 'grant')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  created_at timestamptz not null default now()
);
create index subscription_periods_sub_idx on subscription_periods(subscription_id);

create table invoices (
  id uuid primary key,
  seq serial unique,
  user_id uuid not null references users(id),
  payment_id uuid not null unique references payments(id),
  description text not null,
  amount_minor integer not null,
  currency text not null,
  status text not null default 'paid' check (status in ('paid', 'refunded', 'partially_refunded')),
  period_start timestamptz,
  period_end timestamptz,
  issued_at timestamptz not null
);
create index invoices_user_idx on invoices(user_id);

-- Append-only audit trail for money and access changes.
create table audit_log (
  id uuid primary key,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_entity_idx on audit_log(entity_type, entity_id);

-- Seed plans (placeholder KES prices: editable by admins at /admin/plans).
insert into plans (id, code, name, description, tier, price_minor, currency, duration_days, features, sort_order) values
  ('a0000000-0000-4000-8000-000000000001', 'free', 'Free', 'Get started with free signals.', 'free', 0, 'KES', null,
   '["Free signals","Comments and reactions","Save signals"]', 0),
  ('a0000000-0000-4000-8000-000000000002', 'premium_monthly', 'Premium Monthly', 'Full access, billed every 30 days.', 'premium', 150000, 'KES', 30,
   '["Everything in Free","Premium signals: entry, stop loss and targets","Chart screenshots and full analysis","Signal update history"]', 1),
  ('a0000000-0000-4000-8000-000000000003', 'premium_quarterly', 'Premium Quarterly', 'Full access for 90 days.', 'premium', 390000, 'KES', 90,
   '["Everything in Premium Monthly","Lower price per month"]', 2),
  ('a0000000-0000-4000-8000-000000000004', 'premium_yearly', 'Premium Yearly', 'Full access for 365 days.', 'premium', 1400000, 'KES', 365,
   '["Everything in Premium Monthly","Best price per month"]', 3);

-- Premium used to be a manually assigned role. It is now derived from subscriptions, so existing premium
-- members are converted to free accounts holding a one-year complimentary grant (no one silently loses access).
insert into subscriptions (id, user_id, plan_id, tier, current_period_start, current_period_end, source)
  select gen_random_uuid(), u.id, 'a0000000-0000-4000-8000-000000000002', 'premium', now(), now() + interval '365 days', 'admin_grant'
  from users u where u.role = 'premium';
update users set role = 'free' where role = 'premium';
