-- Community chat messages. Access to a room's messages is decided by the room's access rules (see rooms/serialize.ts), never here.
-- seq is a global, strictly increasing cursor used for pagination; it is not a count.
-- Deleting is soft: the content is wiped but the row stays as a tombstone so pagination and ordering remain stable.
create table room_messages (
  id uuid primary key,
  seq bigserial not null unique,
  room_id uuid not null references community_rooms(id),
  author_id uuid not null references users(id),
  -- Optional idempotency key supplied by the author's client so a retry after a dropped connection cannot double-post.
  client_id uuid,
  body text not null default '',
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references users(id),
  unique (author_id, client_id),
  -- A live message always has content; only tombstones are empty.
  constraint room_messages_body_present check (deleted_at is not null or body <> '')
);
create index room_messages_room_seq_idx on room_messages(room_id, seq);
