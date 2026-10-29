import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import type { webhook } from '@line/bot-sdk';
import { Hono } from 'hono';
import { config } from './config.js';
import { closeDb, getDb } from './db/index.js';
import { createRepos, type Repos } from './db/repos.js';
import { createClassifierFromConfig } from './classifier/index.js';
import { createDispatcher, defaultWelcomeText } from './handlers/dispatcher.js';
import { createTextMessageHandler } from './handlers/message.js';
import { createGrokCallbackRoute, type GrokCallbackDeps } from './grok/callback.js';
import { createGrokGateway } from './grok/gateway.js';
import { createHealthChecker } from './health/check.js';
import { createJobHandlers } from './jobs/handlers.js';
import { JobQueue } from './jobs/queue.js';
import { createLineClient } from './line/client.js';
import { Replier } from './line/replier.js';
import { createWebhookRoute } from './line/webhook.js';
import { logger } from './logger.js';

// Resolves to the project root from both src/ (tsx) and dist/ (node).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export interface AppDeps {
  channelSecret: string;
  repos: Pick<Repos, 'events'>;
  dispatch: (event: webhook.Event) => Promise<void>;
  /** `/grok/callback` HMAC secret; the route answers 501 until callback mode is defined. */
  grokCallback?: GrokCallbackDeps;
}

/** Without `deps` the webhook and grok callback routes exist but answer 503 (tests, misconfiguration). */
export function createApp(deps?: AppDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({ status: 'ok', uptime: Math.round(process.uptime()), version: pkg.version }),
  );

  if (deps) {
    app.route('/webhook', createWebhookRoute(deps));
    app.route('/grok/callback', createGrokCallbackRoute(deps.grokCallback));
  } else {
    app.post('/webhook', (c) => c.json({ error: 'not configured' }, 503));
    app.post('/grok/callback', (c) => c.json({ error: 'not configured' }, 503));
  }

  return app;
}

const JOB_MAX_ATTEMPTS = 5;

function main(): void {
  const db = getDb();
  const repos = createRepos(db);
  const replier = new Replier(createLineClient(), repos);
  const classifier = createClassifierFromConfig();
  const health = createHealthChecker({
    url: config.HEALTH_CHECK_URL,
    timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
    cacheMs: config.HEALTH_CACHE_MS,
  });
  const jobs = new JobQueue(repos.jobs, { maxAttempts: JOB_MAX_ATTEMPTS });
  const grok = createGrokGateway(config, logger);
  const handlers = createJobHandlers({
    repos,
    replier,
    grok,
    config,
    maxAttempts: JOB_MAX_ATTEMPTS,
  });
  const handleText = createTextMessageHandler({ repos, replier, classifier, health, jobs, config });
  const dispatch = createDispatcher({
    repos,
    replier,
    handleText,
    welcomeText: defaultWelcomeText,
  });
  const app = createApp({
    channelSecret: config.LINE_CHANNEL_SECRET,
    repos,
    dispatch,
    grokCallback: { secret: config.GROK_WEBHOOK_SECRET },
  });
  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
    logger.info({ port: info.port, grokConfigured: grok.configured }, 'linebot listening');
    jobs.start(handlers);
    logger.info('job queue started');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
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
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
