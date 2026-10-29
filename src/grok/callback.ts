import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { logger } from '../logger.js';
import { SIGNATURE_HEADER, signBody } from './gateway.js';

export interface GrokCallbackDeps {
  secret?: string;
  log?: Logger;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Sub-app with `POST /`; mount at `/grok/callback`. Skeleton until Grok's async mode is defined. */
export function createGrokCallbackRoute(deps: GrokCallbackDeps = {}): Hono {
  const log = deps.log ?? logger;
  const app = new Hono();

  app.post('/', async (c) => {
    const body = await c.req.text();
    if (deps.secret) {
      const sig = c.req.header(SIGNATURE_HEADER);
      if (!sig || !safeEqual(sig.toLowerCase(), signBody(body, deps.secret))) {
        log.warn(
          { hasSignature: Boolean(sig), bodyLength: body.length },
          'grok callback bad signature',
        );
        return c.json({ error: 'bad signature' }, 401);
      }
    }
    // TODO(grok): parse the async result, find the job by task id and apply the same effects as
    // the sync path in jobs/handlers.ts, once the user's Grok webhook contract is known.
    log.info({ bodyLength: body.length }, 'grok callback received (not implemented)');
    return c.json({ error: 'callback mode not implemented' }, 501);
  });

  return app;
}
