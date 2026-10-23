import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';
import { migrate } from '../src/db/migrate.js';

describe('migrations', () => {
  it('are idempotent and create the core tables', async () => {
    const { db } = await makeApp(); // makeApp already migrated once
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query('select name from schema_migrations');
    expect(rows).toHaveLength(1);
    await expect(db.query('select 1 from users')).resolves.toBeDefined();
  });
});
