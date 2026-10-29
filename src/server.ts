import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import type { webhook } from '@line/bot-sdk';
import { Hono } from 'hono';
import { config } from './config.js';
import { closeDb, getDb } from './db/index.js';
import { createRepos, type Repos } from './db/repos.js';
import { createDispatcher } from './handlers/dispatcher.js';
import type { GrokCallbackDeps } from './grok/callback.js';
import { callbackUrlFor, createGrokGateway } from './grok/gateway.js';
import { createHealthChecker } from './health/check.js';
import { JobQueue } from './jobs/queue.js';
import { createLineClient } from './line/client.js';
import { Replier } from './line/replier.js';
import { createWebhookRoute } from './line/webhook.js';
import { logger } from './logger.js';
import { JOB_MAX_ATTEMPTS, mountGrokCallback } from './profiles/enduser.js';
import { createProfile, type Shared } from './profiles/index.js';

// Resolves to the project root from both src/ (tsx) and dist/ (node).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export interface AppDeps {
  channelSecret: string;
  repos: Pick<Repos, 'events'>;
  dispatch: (event: webhook.Event) => Promise<void>;
  /** `/grok/callback` deps; without them (or without a token) the route answers 503. */
  grokCallback?: GrokCallbackDeps;
  /** Profile-specific routes (e.g. `/grok/callback` via the profile); mounted before the 503 fallbacks. */
  extraRoutes?: (app: Hono) => void;
  /** Reported by `/health`; `main()` passes `config.BOT_PROFILE`. */
  profile?: string;
}

/**
 * Without `deps` the webhook and grok callback routes exist but answer 503 (tests, misconfiguration)
 * and `/health` reports the default profile without touching config (env may be absent in tests).
 */
export function createApp(deps?: AppDeps): Hono {
  const app = new Hono();
  const profile = deps?.profile ?? 'enduser';

  app.get('/health', (c) =>
    c.json({ status: 'ok', uptime: Math.round(process.uptime()), version: pkg.version, profile }),
  );

  if (deps) {
    app.route('/webhook', createWebhookRoute(deps));
    deps.extraRoutes?.(app);
    if (deps.grokCallback) mountGrokCallback(app, deps.grokCallback);
    app.post('/grok/callback', (c) => c.json({ error: 'callback not configured' }, 503));
  } else {
    app.post('/webhook', (c) => c.json({ error: 'not configured' }, 503));
    app.post('/grok/callback', (c) => c.json({ error: 'not configured' }, 503));
  }

  return app;
}

function main(): void {
  const db = getDb();
  const repos = createRepos(db);
  const replier = new Replier(createLineClient(), repos);
  const health = createHealthChecker({
    url: config.HEALTH_CHECK_URL,
    timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
    cacheMs: config.HEALTH_CACHE_MS,
  });
  const jobs = new JobQueue(repos.jobs, { maxAttempts: JOB_MAX_ATTEMPTS });
  const grok = createGrokGateway(config, logger);
  const shared: Shared = { config, repos, replier, jobs, grok, health, logger };
  const profile = createProfile(config.BOT_PROFILE, shared);
  const dispatch = createDispatcher({
    repos,
    replier,
    handleText: profile.handleText,
    welcomeText: profile.welcomeText,
  });
  const app = createApp({
    channelSecret: config.LINE_CHANNEL_SECRET,
    repos,
    dispatch,
    extraRoutes: profile.extraRoutes,
    profile: profile.name,
  });
  const callbackUrl = config.PUBLIC_BASE_URL ? callbackUrlFor(config.PUBLIC_BASE_URL) : undefined;
  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
    logger.info(
      { port: info.port, profile: profile.name, grokConfigured: grok.configured, callbackUrl },
      'linebot listening',
    );
    void Promise.resolve(profile.start?.()).catch((err) =>
      logger.error({ err }, 'error starting profile'),
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    void Promise.resolve(profile.stop?.())
      .catch((err) => logger.error({ err }, 'error stopping profile'))
      .finally(() => {
        server.close((err) => {
          if (err) logger.error({ err }, 'error during shutdown');
          void jobs
            .stop()
            .catch((jobErr) => logger.error({ err: jobErr }, 'error stopping job queue'))
            .finally(() => {
              try {
                closeDb();
              } catch (dbErr) {
                logger.error({ err: dbErr }, 'error closing database');
              }
              process.exit(err ? 1 : 0);
            });
        });
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
