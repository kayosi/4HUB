-- Member profile + notification preferences
alter table users add column country text;
alter table users add column trading_experience text check (trading_experience is null or trading_experience in ('beginner', 'intermediate', 'advanced', 'professional'));
alter table users add column preferred_assets jsonb not null default '[]';
alter table users add column notification_prefs jsonb not null default '{"newSignals":true,"signalUpdates":true,"announcements":false}';

-- Signals
create table signals (
  id uuid primary key,
  asset text not null,
  direction text not null check (direction in ('buy', 'sell')),
  timeframe text not null,
  entry numeric not null,
  stop_loss numeric not null,
  take_profit_1 numeric,
  take_profit_2 numeric,
  take_profit_3 numeric,
  risk_level text not null check (risk_level in ('low', 'medium', 'high')),
  analysis text not null default '',
  teaser text not null default '',
  visibility text not null check (visibility in ('free', 'premium')),
  status text not null default 'active' check (status in ('active', 'closed')),
  result text check (result is null or result in ('tp_hit', 'sl_hit', 'breakeven', 'cancelled')),
  tp_level integer check (tp_level is null or tp_level in (1, 2, 3)),
  pips numeric,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index signals_created_at_idx on signals(created_at);
create index signals_asset_idx on signals(asset);

-- Chart screenshots. Files live in private storage under a random key; they are only
-- ever served through an authorized API route, never from a public/static path.
create table signal_images (
  id uuid primary key,
  signal_id uuid not null references signals(id) on delete cascade,
  storage_key text not null unique,
  content_type text not null,
  size_bytes integer not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index signal_images_signal_idx on signal_images(signal_id);

-- Append-only audit/history of everything that happens to a signal
create table signal_updates (
  id uuid primary key,
  signal_id uuid not null references signals(id) on delete cascade,
  author_id uuid not null references users(id),
  kind text not null check (kind in ('created', 'edited', 'sl_moved', 'tp_updated', 'note', 'closed')),
  message text not null,
  changes jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index signal_updates_signal_idx on signal_updates(signal_id);

create table signal_reactions (
  signal_id uuid not null references signals(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  type text not null check (type in ('like', 'fire', 'target')),
  created_at timestamptz not null default now(),
  primary key (signal_id, user_id)
);

create table signal_comments (
  id uuid primary key,
  signal_id uuid not null references signals(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references users(id)
);
create index signal_comments_signal_idx on signal_comments(signal_id);

create table signal_bookmarks (
  user_id uuid not null references users(id) on delete cascade,
  signal_id uuid not null references signals(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, signal_id)
);

-- One row per (signal, member): drives the de-duplicated view counter
create table signal_views (
  signal_id uuid not null references signals(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (signal_id, user_id)
);
