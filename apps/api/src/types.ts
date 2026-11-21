import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { AuthUser } from './auth/access.js';
import type { BillingService } from './billing/service.js';
import type { Mailer } from './lib/mailer.js';
import type { FileStorage } from './storage/index.js';
import type { ChatHub } from './chat/hub.js';
import type { EventBus } from './events.js';
import type { NotificationService } from './notifications/service.js';
import type { WriteLimiter } from './chat/limiter.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionTokenHash: string | null;
  }
  interface FastifyInstance {
    config: Config;
    db: Db;
    mailer: Mailer;
    storage: FileStorage;
    billing: BillingService;
    chatHub: ChatHub;
    events: EventBus;
    notifications: NotificationService;
    chatLimiter: WriteLimiter;
    /** Current time. Injectable so subscription expiry/grace can be tested deterministically. */
    now: () => Date;
  }
}
