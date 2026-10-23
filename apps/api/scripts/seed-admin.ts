import './env.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/index.js';
import { hashPassword } from '../src/auth/password.js';
import { createUser, findUserByEmail } from '../src/db/repos.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 10) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (min 10 chars) in .env first.');
  process.exit(1);
}
const db = createPool(loadConfig().DATABASE_URL);
if (await findUserByEmail(db, email)) console.log('Admin already exists; nothing to do.');
else {
  await createUser(db, { email, passwordHash: await hashPassword(password), displayName: 'Admin', role: 'admin' });
  console.log(`Created admin ${email}`);
}
await db.end();
