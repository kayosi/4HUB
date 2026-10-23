import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('applies defaults and coerces numbers', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', PORT: '5000' });
    expect(c.PORT).toBe(5000);
    expect(c.NODE_ENV).toBe('development');
  });
  it('fails fast when required variables are missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
