import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { logger } from './logger.js';

// Resolves to the project root from both src/ (tsx) and dist/ (node).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export function createApp(): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({ status: 'ok', uptime: Math.round(process.uptime()), version: pkg.version }),
  );

  // Placeholder: signature check, dedupe and dispatch arrive in T3.
  app.post('/webhook', async (c) => {
    await c.req.text();
    return c.json({ ok: true });
  });

  return app;
}

function main(): void {
  const app = createApp();
  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
    logger.info({ port: info.port }, 'linebot listening');
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
      process.exit(err ? 1 : 0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
