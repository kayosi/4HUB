import './env.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

const db = createPool(loadConfig().DATABASE_URL);
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await db.end();
