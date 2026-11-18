import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { Db } from '../src/db/index.js';

describe('migration 003: premium role -> subscription', () => {
  it('converts existing "premium" role accounts into free accounts holding a one-year complimentary subscription', async () => {
    const mem = newDb();
    mem.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, implementation: () => randomUUID(), impure: true });
    const db = new (mem.adapters.createPg().Pool)() as unknown as Db;

    // a database as it was BEFORE billing: only migrations 001 and 002
    const dir = mkdtempSync(join(tmpdir(), '4hub-mig-'));
    const all = join(__dirname, '..', 'migrations');
    for (const f of readdirSync(all).filter((n) => n < '003')) copyFileSync(join(all, f), join(dir, f));
    expect(await migrate(db, dir)).toEqual(['001_init.sql', '002_profiles_and_signals.sql']);

    const ids = { prem: '11111111-1111-4111-8111-111111111111', free: '22222222-2222-4222-8222-222222222222', admin: '33333333-3333-4333-8333-333333333333' };
    for (const [email, id, role] of [['p@x.co', ids.prem, 'premium'], ['f@x.co', ids.free, 'free'], ['a@x.co', ids.admin, 'admin']] as const) {
      await db.query(`insert into users (id, email, password_hash, display_name, role) values ($1,$2,'x','U',$3)`, [id, email, role]);
    }

    expect(await migrate(db)).toEqual(['003_billing.sql', '004_community_rooms.sql']); // now apply billing on top of existing data

    const users = Object.fromEntries((await db.query('select id, role from users')).rows.map((r) => [r.id, r.role]));
    expect(users).toEqual({ [ids.prem]: 'free', [ids.free]: 'free', [ids.admin]: 'admin' });

    const subs = (await db.query('select user_id, tier, source, current_period_start, current_period_end from subscriptions')).rows;
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ user_id: ids.prem, tier: 'premium', source: 'admin_grant' });
    const days = (new Date(subs[0].current_period_end).getTime() - new Date(subs[0].current_period_start).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(365);

    const plans = (await db.query('select code, tier, price_minor, duration_days from plans order by sort_order')).rows;
    expect(plans.map((p) => p.code)).toEqual(['free', 'premium_monthly', 'premium_quarterly', 'premium_yearly']);
    expect(plans.map((p) => p.duration_days)).toEqual([null, 30, 90, 365]);
  });
});
