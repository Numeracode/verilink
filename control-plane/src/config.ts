// control-plane/src/config.ts
// Centralized configuration. No process.env outside this file.

function optional(name: string, fallback: string = ''): string {
  return process.env[name] || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function booleanFlag(name: string, fallback: boolean = false): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return v === 'true' || v === '1';
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = Object.freeze({
  database: Object.freeze({
    url: optional('DATABASE_URL'),
    poolMax: optionalInt('DB_POOL_MAX', 20),
    poolIdleTimeoutMillis: optionalInt('DB_POOL_IDLE_TIMEOUT_MS', 30000),
    poolConnectionTimeoutMillis: optionalInt('DB_POOL_CONNECT_TIMEOUT_MS', 5000),
  }),
  auth: Object.freeze({
    clerkIssuerUrl: optional('CLERK_ISSUER_URL'),
    clerkClientId: optional('CLERK_CLIENT_ID'),
    clerkClientSecret: optional('CLERK_CLIENT_SECRET'),
  }),
  trustEngine: Object.freeze({
    addr: optional('TRUST_ENGINE_ADDR', 'localhost:9091'),
  }),
  scoreRecompute: Object.freeze({
    debounceMs: optionalInt('SCORE_RECOMPUTE_DEBOUNCE_MS', 60_000),
    intervalMs: optionalInt('SCORE_RECOMPUTE_INTERVAL_MS', 3_600_000),
  }),
  server: Object.freeze({
    port: optionalInt('PORT', 3000),
    nodeEnv: optional('NODE_ENV', 'development'),
    logLevel: optional('LOG_LEVEL', 'info'),
  }),
  stripe: Object.freeze({
    secretKey: optional('STRIPE_SECRET_KEY'),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET'),
  }),
  apiKey: Object.freeze({
    hmacSecret: optional('API_KEY_HMAC_SECRET'),
  }),
});

export function assertDatabaseConfigured(): void {
  if (!config.database.url) {
    throw new Error('DATABASE_URL is required');
  }
}

export function assertSecretsConfigured(): void {
  if (!config.apiKey.hmacSecret) {
    throw new Error('API_KEY_HMAC_SECRET is required');
  }
}
