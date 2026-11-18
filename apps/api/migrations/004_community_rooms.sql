-- Community rooms: categorised discussion spaces. Messaging is not part of this migration.
-- Premium rooms are gated by the 'premium_community' capability (see billing/tiers.ts, auth/access.ts), never by role.
create table community_rooms (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  description text not null,
  guidelines text not null default '',
  category text not null check (category in ('general_discussion', 'trading_discussion', 'market_analysis', 'premium_community')),
  access text not null default 'public' check (access in ('public', 'premium')),
  sort_order integer not null default 0 check (sort_order between 0 and 1000),
  created_by uuid not null references users(id),
  updated_by uuid references users(id),
  archived_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  -- A "Premium community" room can never be public, even if the API is bypassed.
  constraint community_rooms_premium_category check (category <> 'premium_community' or access = 'premium')
);
create index community_rooms_listing_idx on community_rooms(archived_at, category, sort_order);
