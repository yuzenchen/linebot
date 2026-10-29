import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { INTERNAL_TOKEN_HEADER } from './adminNotifier.js';

export interface InternalNotifyDeps {
  /** `INTERNAL_NOTIFY_TOKEN`; without it the route answers 503. */
  token?: string;
  adminUserIds: string[];
  replier: Pick<Replier, 'push'>;
  log?: Logger;
}

export const internalNoticeSchema = z.object({
  kind: z.string().min(1),
  text: z.string().min(1).max(5000),
  meta: z.record(z.string(), z.unknown()).optional(),
  sentAt: z.string().optional(),
});

export const SOURCE_TAG = '[客服 bot] ';

/** Tags relayed text with its source unless the sender already tagged it. */
export function tagNotice(text: string): string {
  return text.startsWith('[') ? text : SOURCE_TAG + text;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Sub-app with `POST /`; mount at `/internal/notify` on the admin bot. Fans a notice from the
 * enduser bot out to every `ADMIN_USER_IDS` member (push_log reason `relay_<kind>`).
 */
export function createInternalNotifyRoute(deps: InternalNotifyDeps): Hono {
  const log = deps.log ?? logger;
  const app = new Hono();

  app.post('/', async (c) => {
    if (!deps.token) return c.json({ error: 'internal notify not configured' }, 503);
    const presented = c.req.header(INTERNAL_TOKEN_HEADER);
    if (!presented || !safeEqual(presented, deps.token)) {
      log.warn({ hasToken: Boolean(presented) }, 'internal notify bad token');
      return c.json({ error: 'unauthorized' }, 401);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const parsed = internalNoticeSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    const { kind, text, meta } = parsed.data;
    const reason = `relay_${kind}`;
    const tagged = tagNotice(text);

    let delivered = 0;
    let failed = 0;
    for (const id of deps.adminUserIds) {
      try {
        await deps.replier.push(id, [tagged], reason);
        delivered++;
      } catch (err) {
        failed++;
        log.error({ ...meta, kind, userId: id, err }, 'internal notify push failed');
      }
    }
    log.info({ ...meta, kind, delivered, failed }, 'internal notice relayed to admins');
    return c.json({ ok: true, delivered, failed });
  });

  return app;
}
