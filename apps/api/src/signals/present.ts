import type { Db } from '../db/index.js';
import type { UserRow } from '../db/repos.js';
import type { SignalRow } from './model.js';
import { listImages, listImagesForSignals, listUpdates, loadStats, loadViewer, recordView } from './repo.js';
import { canViewFull, serializeSignal, serializeUpdate } from './serialize.js';

/** Serializes a page of signals using batched lookups. Locked signals never trigger premium lookups. */
export async function presentList(db: Db, rows: SignalRow[], user: UserRow | null) {
  const openIds = rows.filter((r) => canViewFull(r, user)).map((r) => r.id);
  const [images, stats, viewer] = await Promise.all([
    listImagesForSignals(db, openIds),
    loadStats(db, openIds),
    user ? loadViewer(db, user.id, openIds) : Promise.resolve(undefined),
  ]);
  return rows.map((r) =>
    serializeSignal(r, { user, images: images.get(r.id), stats: stats.get(r.id), viewer: viewer?.get(r.id) }),
  );
}

/** Detail view: adds the update history (authorized only) and counts one view per signed-in member. */
export async function presentDetail(db: Db, row: SignalRow, user: UserRow | null, opts: { countView: boolean }) {
  if (!canViewFull(row, user)) return { signal: serializeSignal(row, { user }), updates: null };
  if (opts.countView && user) await recordView(db, row.id, user.id);
  const [images, stats, viewer, updates] = await Promise.all([
    listImages(db, row.id),
    loadStats(db, [row.id]),
    user ? loadViewer(db, user.id, [row.id]) : Promise.resolve(undefined),
    listUpdates(db, row.id),
  ]);
  return {
    signal: serializeSignal(row, { user, images, stats: stats.get(row.id), viewer: viewer?.get(row.id) }),
    updates: updates.map(serializeUpdate),
  };
}
