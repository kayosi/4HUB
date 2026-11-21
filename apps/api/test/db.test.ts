import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';
import { migrate } from '../src/db/migrate.js';

describe('migrations', () => {
  it('are idempotent and create the core tables', async () => {
    const { db } = await makeApp(); // makeApp already migrated once
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query('select name from schema_migrations');
    expect(rows.map((r: { name: string }) => r.name)).toEqual(["001_init.sql", "002_profiles_and_signals.sql", "003_billing.sql", "004_community_rooms.sql", "005_room_messages.sql", "006_community_moderation.sql", "007_notifications.sql"]);
    await expect(db.query('select 1 from users')).resolves.toBeDefined();
  });
});
