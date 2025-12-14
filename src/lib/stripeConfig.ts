export type StripeMode = 'test' | 'live';

export const getStripeMode = (): StripeMode => {
  const env = (import.meta as any).env || {};
  const raw = String(env.VITE_STRIPE_MODE || env.STRIPE_MODE || '')
    .toLowerCase()
    .trim();
  if (raw === 'live' || raw === 'test') {
    return raw;
  }
  const liveKey = String(env.VITE_STRIPE_PUBLISHABLE_KEY || '').trim();
  const testKey = String(env.VITE_STRIPE_PUBLISHABLE_TEST_KEY || '').trim();
  const inferred = (liveKey || testKey).toLowerCase();
  if (inferred.startsWith('pk_live')) {
    return 'live';
  }
  if (inferred.startsWith('pk_test')) {
    return 'test';
  }
  return 'test';
};

export const getStripePublishableKey = (): string => {
  const mode = getStripeMode();
  const live = String((import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY || '').trim();
  const test = String((import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_TEST_KEY || '').trim();
  if (mode === 'live') {
    return live;
  }
  return test || live;
};
