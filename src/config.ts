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
  /** Our externally reachable origin (no trailing slash); builds the Grok callback URL. */
  PUBLIC_BASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .url()
      .transform((u) => u.replace(/\/+$/, ''))
      .optional(),
  ),
  /** Shared token the Cursor agent sends back in `x-linebot-token` on `/grok/callback`. */
  GROK_CALLBACK_TOKEN: optionalString,
  /** How long a dispatched Grok task may wait for its `done` callback before it expires. */
  GROK_TASK_TIMEOUT_MS: intWithDefault(900000),
  TZ: stringWithDefault('Asia/Taipei'),

  // --- Bot profile (T10). `enduser` is the customer-facing bot; `admin` the internal one. ---
  BOT_PROFILE: z.preprocess(emptyToUndefined, z.enum(['enduser', 'admin']).default('enduser')),
  /** Comma-separated LINE userIds allowed to talk to the admin bot. */
  ADMIN_USER_IDS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((s) =>
        (s ?? '')
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      ),
  ),
  ESHOP_API_BASE: z.preprocess(
    emptyToUndefined,
    z
      .url()
      .transform((u) => u.replace(/\/+$/, ''))
      .default('https://petsnack-backend.onrender.com/api/v1'),
  ),
  ESHOP_BOT_USERNAME: optionalString,
  ESHOP_BOT_PASSWORD: optionalString,
  ADMIN_MODEL: stringWithDefault('claude-opus-5-5'),
  ADMIN_MAX_TOOL_ROUNDS: intWithDefault(4),
  /** Shared secret between the two containers for `POST /internal/notify` (T13). */
  INTERNAL_NOTIFY_TOKEN: optionalString,
  /** Where the enduser bot sends admin notifications (T13); e.g. `http://linebot-admin:8090/internal/notify`. */
  ADMIN_NOTIFY_URL: z.preprocess(emptyToUndefined, z.url().optional()),
});

/**
 * Cross-field rules:
 * - a configured Grok webhook needs a callback URL and token;
 * - the admin profile needs an allowlist, eshop bot credentials and an Anthropic key.
 */
const validatedConfigSchema = configSchema.superRefine((c, ctx) => {
  if (c.GROK_WEBHOOK_URL) {
    for (const field of ['PUBLIC_BASE_URL', 'GROK_CALLBACK_TOKEN'] as const) {
      if (!c[field]) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'is required when GROK_WEBHOOK_URL is set',
        });
      }
    }
  }
  if (c.BOT_PROFILE === 'admin') {
    if (c.ADMIN_USER_IDS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_USER_IDS'],
        message: 'must list at least one LINE userId when BOT_PROFILE=admin',
      });
    }
    for (const field of [
      'ESHOP_BOT_USERNAME',
      'ESHOP_BOT_PASSWORD',
      'ANTHROPIC_API_KEY',
    ] as const) {
      if (!c[field]) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'is required when BOT_PROFILE=admin',
        });
      }
    }
  }
});

export type Config = z.infer<typeof configSchema>;

/** Parse and validate env. Throws a readable error listing every invalid field. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = validatedConfigSchema.safeParse(env);
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
