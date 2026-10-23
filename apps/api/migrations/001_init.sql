create table users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  display_name text not null,
  role text not null default 'free' check (role in ('free', 'premium', 'moderator', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_id_idx on sessions(user_id);

create table password_reset_tokens (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index password_reset_user_id_idx on password_reset_tokens(user_id);
