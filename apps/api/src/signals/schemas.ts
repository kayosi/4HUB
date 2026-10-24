import { z } from 'zod';
import { DIRECTIONS, REACTIONS, RESULTS, RISK_LEVELS, STATUSES, TIMEFRAMES, VISIBILITIES } from './model.js';

export const assetSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9._/-]{2,20}$/, 'Use 2-20 letters/numbers, e.g. XAUUSD or BTC/USD');

const price = z.number().positive().max(1e9);
const optionalPrice = price.nullable().optional();

const fields = {
  asset: assetSchema,
  direction: z.enum(DIRECTIONS),
  timeframe: z.enum(TIMEFRAMES),
  entry: price,
  stopLoss: price,
  takeProfit1: price,
  takeProfit2: optionalPrice,
  takeProfit3: optionalPrice,
  riskLevel: z.enum(RISK_LEVELS),
  analysis: z.string().trim().max(5000),
  teaser: z.string().trim().max(280),
  visibility: z.enum(VISIBILITIES),
};

export const createSignalSchema = z.object({
  ...fields,
  analysis: fields.analysis.default(''),
  teaser: fields.teaser.default(''),
});

export const updateSignalSchema = z
  .object({ ...fields, takeProfit1: price, note: z.string().trim().max(300) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const noteSchema = z.object({ message: z.string().trim().min(1).max(500) });

export const closeSchema = z
  .object({
    result: z.enum(RESULTS),
    tpLevel: z.number().int().min(1).max(3).optional(),
    pips: z.number().min(-1e6).max(1e6).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.result === 'tp_hit' && v.tpLevel === undefined)
      ctx.addIssue({ code: 'custom', path: ['tpLevel'], message: 'Choose which take profit was hit' });
    if (v.result !== 'tp_hit' && v.tpLevel !== undefined)
      ctx.addIssue({ code: 'custom', path: ['tpLevel'], message: 'Only applies when a take profit was hit' });
    if (v.result === 'cancelled' && v.pips !== undefined)
      ctx.addIssue({ code: 'custom', path: ['pips'], message: 'A cancelled signal has no pips' });
  });

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform((s) => new Date(`${s}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), 'Invalid date');

export const feedQuerySchema = z.object({
  asset: assetSchema.optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  status: z.enum(STATUSES).optional(),
  from: date.optional(),
  to: date.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const reactionSchema = z.object({ type: z.enum(REACTIONS) });
export const commentSchema = z.object({ body: z.string().trim().min(1, 'Write something first').max(1000) });
export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const idSchema = z.string().uuid();
