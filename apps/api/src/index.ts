import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { createPool } from './db/index.js';
import { buildApp } from './app.js';
import { startSweeper } from './notifications/sweeper.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const config = loadConfig();
if (!isAbsolute(config.UPLOAD_DIR)) config.UPLOAD_DIR = resolve(root, config.UPLOAD_DIR);
const db = createPool(config.DATABASE_URL);
const app = await buildApp({ config, db });

const stopSweeper = startSweeper(app.notifications, config.NOTIFICATION_SWEEP_MS, app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  stopSweeper();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
