import type { Config } from '../../config.js';
import { MockProvider } from './mock.js';
import { MpesaProvider } from './mpesa.js';
import { PaystackCardProvider } from './paystack.js';
import type { FetchLike, PaymentProvider } from './types.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();
  constructor(providers: PaymentProvider[] = []) { providers.forEach((p) => this.providers.set(p.id, p)); }
  register(p: PaymentProvider): void { this.providers.set(p.id, p); }
  get(id: string): PaymentProvider | undefined { return this.providers.get(id); }
  list(): PaymentProvider[] { return [...this.providers.values()]; }
}

/** Builds the enabled providers from configuration. Real providers need credentials; the sandbox is dev/test only. */
export function createRegistry(config: Config, http: FetchLike, now: () => Date): ProviderRegistry {
  const out: PaymentProvider[] = [];
  for (const id of config.PAYMENT_PROVIDERS) {
    if (id === 'mock') {
      if (config.NODE_ENV === 'production') throw new Error('The sandbox payment provider cannot be enabled in production');
      out.push(new MockProvider(config.MOCK_PROVIDER_SECRET));
    } else if (id === 'mpesa') {
      const { MPESA_CONSUMER_KEY: k, MPESA_CONSUMER_SECRET: s, MPESA_SHORTCODE: sc, MPESA_PASSKEY: pk, MPESA_CALLBACK_TOKEN: tok } = config;
      if (!k || !s || !sc || !pk || !tok) throw new Error('M-Pesa is enabled but MPESA_* credentials are incomplete');
      out.push(new MpesaProvider({ env: config.MPESA_ENV, consumerKey: k, consumerSecret: s, shortcode: sc, passkey: pk, callbackToken: tok }, http, now));
    } else if (id === 'card') {
      if (!config.PAYSTACK_SECRET_KEY) throw new Error('Card payments are enabled but PAYSTACK_SECRET_KEY is missing');
      out.push(new PaystackCardProvider(config.PAYSTACK_SECRET_KEY, http));
    } else throw new Error(`Unknown payment provider: ${id}`);
  }
  return new ProviderRegistry(out);
}
