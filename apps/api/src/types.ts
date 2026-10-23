import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { UserRow } from './db/repos.js';
import type { Mailer } from './lib/mailer.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    sessionTokenHash: string | null;
  }
  interface FastifyInstance {
    config: Config;
    db: Db;
    mailer: Mailer;
  }
}
