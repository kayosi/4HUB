import type { FastifyBaseLogger } from 'fastify';

/** Outbound notification seam. Later modules (email, notifications) plug in here. */
export interface Mailer {
  sendPasswordReset(to: string, token: string): Promise<void>;
}

/** Foundation default: logs only. In production the token is never logged. */
export function createLogMailer(log: FastifyBaseLogger, isProduction: boolean): Mailer {
  return {
    async sendPasswordReset(to, token) {
      if (isProduction) log.warn('Password reset requested but no mailer is configured');
      else log.info({ to, token }, 'DEV ONLY: password reset token (no mailer configured)');
    },
  };
}
