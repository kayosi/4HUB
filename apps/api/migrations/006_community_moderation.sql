-- Community moderation: message reports, reversible hiding of messages, and account restrictions.
-- Nothing here is ever deleted: reports and restrictions are closed/lifted, never removed, so the history stays reviewable.

-- A moderator can HIDE a message (reversible, content kept for review) or REMOVE it (content wiped, existing tombstone).
alter table room_messages add column hidden_at timestamptz;
alter table room_messages add column hidden_by uuid references users(id);
-- Why the message was hidden/removed. Shown to the author and to staff only.
alter table room_messages add column moderation_reason text;

create table message_reports (
  id uuid primary key,
  message_id uuid not null references room_messages(id),
  room_id uuid not null references community_rooms(id),
  reporter_id uuid not null references users(id),
  -- The author at the time of the report.
  reported_user_id uuid not null references users(id),
  reason text not null check (reason in ('spam', 'harassment', 'hate_speech', 'scam', 'inappropriate', 'other')),
  details text not null default '',
  -- The message text exactly as it was when reported. Edits, hiding or removal never change it: it is the evidence.
  reported_body text not null,
  created_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  -- What was done when resolved. Null while open and for dismissed reports.
  resolution text check (resolution is null or resolution in ('hidden', 'removed', 'handled')),
  resolution_note text,
  -- One report per person per message.
  unique (message_id, reporter_id)
);
create index message_reports_queue_idx on message_reports(status, created_at);
create index message_reports_reporter_idx on message_reports(reporter_id, created_at);

create table user_restrictions (
  id uuid primary key,
  user_id uuid not null references users(id),
  -- muted: may read but not post or edit messages. suspended: account blocked (only logout still works).
  type text not null check (type in ('muted', 'suspended')),
  reason text not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  -- Null = until an administrator lifts it.
  expires_at timestamptz,
  lifted_at timestamptz,
  lifted_by uuid references users(id),
  lift_note text
);
create index user_restrictions_user_idx on user_restrictions(user_id, type);
