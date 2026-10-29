import { z } from 'zod';

/** Treat empty strings (e.g. `FOO=` in .env) as unset so defaults / optional apply. */
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const requiredString = z.preprocess(emptyToUndefined, z.string({ error: 'is required' }));
const stringWithDefault = (def: string) => z.preprocess(emptyToUndefined, z.string().default(def));
const intWithDefault = (def: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(def));

export const configSchema = z.object({
  PORT: intWithDefault(8090),
  DATA_DIR: stringWithDefault('./data'),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  LINE_CHANNEL_SECRET: requiredString,
  LINE_CHANNEL_ACCESS_TOKEN: requiredString,
  ANTHROPIC_API_KEY: optionalString,
  CLASSIFIER_MODEL: stringWithDefault('claude-opus-5-5'),
  HEALTH_CHECK_URL: z.preprocess(
    emptyToUndefined,
    z.url().default('https://petsnack-backend.onrender.com/health'),
  ),
  HEALTH_CHECK_TIMEOUT_MS: intWithDefault(8000),
  HEALTH_CACHE_MS: intWithDefault(30000),
  REPLY_DEADLINE_MS: intWithDefault(10000),
  CONTEXT_MESSAGES: intWithDefault(6),
  ADMIN_LINE_USER_ID: optionalString,
  GROK_WEBHOOK_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  GROK_WEBHOOK_SECRET: optionalString,
  TZ: stringWithDefault('Asia/Taipei'),
});

export type Config = z.infer<typeof configSchema>;

/** Parse and validate env. Throws a readable error listing every invalid field. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: Config | undefined;

/** Lazily loads config from process.env on first use. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Lazily-created singleton; env is read on first property access, not at import time. */
export const config: Config = new Proxy({} as Config, {
  get: (_t, prop) => Reflect.get(getConfig(), prop),
  has: (_t, prop) => Reflect.has(getConfig(), prop),
  ownKeys: () => Reflect.ownKeys(getConfig()),
  getOwnPropertyDescriptor: (_t, prop) => Reflect.getOwnPropertyDescriptor(getConfig(), prop),
});
