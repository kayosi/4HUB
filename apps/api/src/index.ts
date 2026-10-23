import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { createPool } from './db/index.js';
import { buildApp } from './app.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const app = await buildApp({ config, db });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
