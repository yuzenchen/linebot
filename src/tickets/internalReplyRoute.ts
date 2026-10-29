import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Repos } from '../db/repos.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { INTERNAL_TOKEN_HEADER } from '../notify/adminNotifier.js';

export interface InternalReplyDeps {
  /** `INTERNAL_NOTIFY_TOKEN`; without it the route answers 503. */
  token?: string;
  repos: Pick<Repos, 'tickets'>;
  replier: Pick<Replier, 'push'>;
  log?: Logger;
}

export const internalReplySchema = z.object({
  ticketId: z.number().int().positive(),
  text: z.string().min(1).max(1000),
  by: z.string().min(1),
});

/** `push_log` reason for a human reply delivered through a ticket. */
export const TICKET_REPLY_REASON = 'ticket_reply';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function shortError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err);
  const e = err as { name?: string; message?: string; status?: number };
  const status = e.status !== undefined ? `http_${e.status}` : (e.name ?? 'error');
  return e.message ? `${status}: ${e.message.slice(0, 120)}` : status;
}

/**
 * Sub-app with `POST /`; mount at `/internal/reply` on the enduser bot (SPEC-ADMIN §12.3). The
 * admin bot POSTs `{ ticketId, text, by }`; the text is pushed to the ticket's customer (the
 * Replier records it as an outbound message) and the ticket becomes `answered`. A failed push
 * answers 502 and leaves the ticket as it was.
 */
export function createInternalReplyRoute(deps: InternalReplyDeps): Hono {
  const log = deps.log ?? logger;
  const app = new Hono();

  app.post('/', async (c) => {
    if (!deps.token) return c.json({ error: 'internal reply not configured' }, 503);
    const presented = c.req.header(INTERNAL_TOKEN_HEADER);
    if (!presented || !safeEqual(presented, deps.token)) {
      log.warn({ hasToken: Boolean(presented) }, 'internal reply bad token');
      return c.json({ error: 'unauthorized' }, 401);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const parsed = internalReplySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    const { ticketId, text, by } = parsed.data;

    const ticket = deps.repos.tickets.get(ticketId);
    if (!ticket) return c.json({ error: 'unknown ticket' }, 404);
    if (ticket.status === 'closed') return c.json({ error: 'ticket closed' }, 409);

    try {
      await deps.replier.push(ticket.user_id, [text], TICKET_REPLY_REASON);
    } catch (err) {
      const error = shortError(err);
      log.error({ ticketId, userId: ticket.user_id, by, error }, 'ticket reply push failed');
      return c.json({ ok: false, error }, 502);
    }
    deps.repos.tickets.markAnswered(ticketId, { by, answer: text });
    log.info({ ticketId, userId: ticket.user_id, by }, 'ticket answered');
    return c.json({ ok: true, pushed: true, ticketId, userId: ticket.user_id });
  });

  return app;
}
