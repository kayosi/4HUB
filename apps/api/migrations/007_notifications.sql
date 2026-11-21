-- In-app notifications. Delivery channels (email, SMS, push) are deliberately not part of this migration.
-- A notification belongs to exactly one user and is only ever read through that user's session.

-- Administrator announcements. Kept as their own record so an announcement has a stable id (used for de-duplication)
-- and a history, even though each recipient gets their own notification row.
create table announcements (
  id uuid primary key,
  title text not null,
  body text not null,
  -- Important announcements reach everyone; others respect each member's "announcements" preference.
  important boolean not null default false,
  created_by uuid not null references users(id),
  -- Optional idempotency key from the admin's client, so a double submit cannot announce twice.
  client_id uuid,
  recipient_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (created_by, client_id)
);

create table notifications (
  id uuid primary key,
  -- Strictly increasing cursor for pagination (not a count).
  seq bigserial not null unique,
  user_id uuid not null references users(id),
  category text not null check (category in ('signal', 'subscription', 'payment', 'community', 'announcement')),
  -- Machine-readable kind, e.g. 'signal.published'. The category groups kinds for filtering and counts.
  type text not null,
  title text not null,
  body text not null default '',
  -- Ids for deep links only (signalId, paymentId, roomSlug, ...). Never secrets or restricted content.
  data jsonb not null default '{}',
  -- The same real-world event always produces the same key, so processing it twice cannot notify twice.
  -- Rows without a key (not used by the built-in handlers) are never de-duplicated.
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_user_seq_idx on notifications(user_id, seq);
create index notifications_user_unread_idx on notifications(user_id, read_at);
