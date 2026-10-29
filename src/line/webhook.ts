import { validateSignature, type webhook } from '@line/bot-sdk';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import { logger } from '../logger.js';

export interface WebhookDeps {
  channelSecret: string;
  repos: Pick<Repos, 'events'>;
  dispatch: (event: webhook.Event) => Promise<void>;
  log?: Logger;
}

/** Sub-app with `POST /`; mount at `/webhook`. Verifies, dedupes, responds 200, dispatches async. */
export function createWebhookRoute(deps: WebhookDeps): Hono {
  const { channelSecret, repos, dispatch } = deps;
  const log = deps.log ?? logger;
  const app = new Hono();

  app.post('/', async (c) => {
    const started = performance.now();
    const body = await c.req.text();
    const sig = c.req.header('x-line-signature');
    if (!sig || !validateSignature(body, channelSecret, sig)) {
      log.warn({ hasSignature: Boolean(sig), bodyLength: body.length }, 'webhook bad signature');
      return c.json({ error: 'bad signature' }, 401);
    }

    let parsed: webhook.CallbackRequest;
    try {
      parsed = JSON.parse(body) as webhook.CallbackRequest;
    } catch {
      log.warn('webhook body is not valid JSON');
      return c.json({ error: 'bad json' }, 400);
    }
    const events = Array.isArray(parsed.events) ? parsed.events : [];

    let scheduled = 0;
    for (const ev of events) {
      const eventId = ev.webhookEventId;
      const userId = ev.source?.type === 'user' ? ev.source.userId : undefined;
      const isNew = repos.events.insertIfNew({
        webhookEventId: eventId,
        type: ev.type,
        userId,
        raw: JSON.stringify(ev),
      });
      if (!isNew) {
        log.info(
          { eventId, type: ev.type, redelivery: ev.deliveryContext?.isRedelivery === true },
          'duplicate webhook event skipped',
        );
        continue;
      }
      scheduled++;
      setImmediate(() => {
        dispatch(ev).catch((err: unknown) => log.error({ err, eventId }, 'dispatch failed'));
      });
    }

    log.debug(
      { events: events.length, scheduled, ms: Math.round(performance.now() - started) },
      'webhook handled',
    );
    return c.json({ ok: true });
  });

  return app;
}
