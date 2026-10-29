import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import type { TicketRow } from '../db/tickets.js';
import { logger } from '../logger.js';
import { INTERNAL_TOKEN_HEADER } from '../notify/adminNotifier.js';
import { displayId, parseTicketId } from './ids.js';

/** PII-free ticket summary served to the admin bot (T16). */
export interface TicketSummary {
  id: number;
  display: string;
  /** `U6037873…` (first 8 chars). */
  userIdShort: string;
  question: string;
  orderIds: string[];
  status: TicketRow['status'];
  createdAt: string;
  updatedAt: string;
}

export interface TicketDetail extends TicketSummary {
  /** Masked recent customer texts. */
  context: string[];
  answeredBy: string | null;
  answer: string | null;
  answeredAt: string | null;
}

export interface InternalTicketsDeps {
  /** `INTERNAL_NOTIFY_TOKEN`; without it the routes answer 503. */
  token?: string;
  repos: Pick<Repos, 'tickets'>;
  log?: Logger;
}

const MAX_LIST = 50;

export function shortUserId(userId: string): string {
  return userId.length > 8 ? `${userId.slice(0, 8)}…` : userId;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function parseContext(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toSummary(t: TicketRow, repos: Pick<Repos, 'tickets'>): TicketSummary {
  return {
    id: t.id,
    display: displayId(t.id),
    userIdShort: shortUserId(t.user_id),
    question: t.question,
    orderIds: repos.tickets.orderIdsOf(t),
    status: t.status,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

export function toDetail(t: TicketRow, repos: Pick<Repos, 'tickets'>): TicketDetail {
  return {
    ...toSummary(t, repos),
    context: parseContext(t.context),
    answeredBy: t.answered_by,
    answer: t.answer,
    answeredAt: t.answered_at,
  };
}

/**
 * Sub-app mounted at `/internal/tickets` on the enduser bot (SPEC-ADMIN §12.3, T16): the admin
 * bot lives in another container and reads tickets only through these routes.
 * `GET /?status=open&limit=10`, `GET /:id`, `POST /:id/close`. Responses carry no customer PII.
 */
export function createInternalTicketsRoute(deps: InternalTicketsDeps): Hono {
  const log = deps.log ?? logger;
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!deps.token) return c.json({ error: 'internal tickets not configured' }, 503);
    const presented = c.req.header(INTERNAL_TOKEN_HEADER);
    if (!presented || !safeEqual(presented, deps.token)) {
      log.warn({ hasToken: Boolean(presented), path: c.req.path }, 'internal tickets bad token');
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.get('/', (c) => {
    const status = c.req.query('status') ?? 'open';
    if (status !== 'open') return c.json({ error: 'only status=open is supported' }, 400);
    const rawLimit = Number(c.req.query('limit') ?? '10');
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIST) : 10;
    const tickets = deps.repos.tickets.listOpen(limit).map((t) => toSummary(t, deps.repos));
    return c.json({ ok: true, tickets });
  });

  app.get('/:id', (c) => {
    const id = parseTicketId(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid ticket id' }, 400);
    const t = deps.repos.tickets.get(id);
    if (!t) return c.json({ error: 'unknown ticket' }, 404);
    return c.json({ ok: true, ticket: toDetail(t, deps.repos) });
  });

  app.post('/:id/close', (c) => {
    const id = parseTicketId(c.req.param('id'));
    if (id === null) return c.json({ error: 'invalid ticket id' }, 400);
    const t = deps.repos.tickets.get(id);
    if (!t) return c.json({ error: 'unknown ticket' }, 404);
    if (t.status !== 'closed') {
      deps.repos.tickets.close(id);
      log.info({ ticketId: id, previous: t.status }, 'ticket closed via internal route');
    }
    return c.json({ ok: true, ticketId: id, status: 'closed' });
  });

  return app;
}
