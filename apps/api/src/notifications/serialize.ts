import type { AnnouncementRow, NotificationRow } from './model.js';

/** Whitelist: no dedupe key and no internal columns leave the server. */
export const serializeNotification = (n: NotificationRow) => ({
  id: n.id,
  seq: n.seq,
  category: n.category,
  type: n.type,
  title: n.title,
  body: n.body,
  data: n.data,
  createdAt: n.created_at,
  readAt: n.read_at,
});

export const serializeAnnouncement = (a: AnnouncementRow) => ({
  id: a.id, title: a.title, body: a.body, important: a.important, recipients: a.recipient_count, createdAt: a.created_at,
});
