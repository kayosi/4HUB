import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(14),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  UPLOAD_DIR: z.string().default('.data/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(20).default(5),
  PAYMENT_PROVIDERS: z.string().default('').transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean)),
  /** Max checkout/verify attempts per minute per IP. */
  BILLING_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  SUBSCRIPTION_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(3),
  /** Public URL of the web app (checkout return pages) and of this API (provider callbacks). */
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  MOCK_PROVIDER_SECRET: z.string().min(8).default('dev-only-sandbox-secret'),
  MPESA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  MPESA_CALLBACK_TOKEN: z.string().min(16).optional(),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Community chat: sends, edits and deletes per user per minute. */
  CHAT_WRITES_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Concurrent live-update streams (browser tabs) per user. */
  CHAT_MAX_STREAMS_PER_USER: z.coerce.number().int().positive().default(5),
  /** How often an open stream re-checks the viewer's session and room access, and sends a keep-alive. */
  CHAT_STREAM_RECHECK_MS: z.coerce.number().int().min(50).default(20_000),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.PAYMENT_PROVIDERS.includes('mock'))
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDERS'], message: 'the sandbox provider "mock" is not allowed in production' });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
