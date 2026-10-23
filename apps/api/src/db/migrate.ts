import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction, type Db } from './index.js';

// Same relative depth from both src/db and dist/db.
const defaultDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Applies pending *.sql files in filename order, each inside a transaction. Returns applied names. */
export async function migrate(db: Db, dir: string = defaultDir): Promise<string[]> {
  const exists = await db.query("select 1 from information_schema.tables where table_name = 'schema_migrations'");
  if (exists.rows.length === 0) {
    await db.query(
      'create table schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
  }
  const { rows } = await db.query<{ name: string }>('select name from schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const pending = readdirSync(dir).filter((f) => f.endsWith('.sql') && !done.has(f)).sort();

  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await withTransaction(db, async (client) => {
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
    });
  }
  return pending;
}
