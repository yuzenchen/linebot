import type { webhook } from '@line/bot-sdk';
import { pino } from 'pino';
import { vi } from 'vitest';
import type { ClassifyResult } from '../../src/classifier/index.js';
import { createRepos, type Repos } from '../../src/db/repos.js';
import type { TextMessageContext } from '../../src/handlers/dispatcher.js';
import type { HealthChecker, HealthResult } from '../../src/health/check.js';
import type { LineApi } from '../../src/line/client.js';
import { Replier } from '../../src/line/replier.js';
import { memoryDb } from '../db/helpers.js';

export const silent = pino({ level: 'silent' });

export type FakeApi = { [K in keyof LineApi]: ReturnType<typeof vi.fn<LineApi[K]>> };

export function fakeApi(): FakeApi {
  return {
    replyMessage: vi.fn(async () => ({})),
    pushMessage: vi.fn(async () => ({})),
    showLoadingAnimation: vi.fn(async () => ({})),
  };
}

export interface Harness {
  db: ReturnType<typeof memoryDb>;
  repos: Repos;
  api: FakeApi;
  replier: Replier;
  enqueue: ReturnType<typeof vi.fn<(type: string, payload: unknown) => number>>;
  jobs: { enqueue: (type: string, payload: unknown) => number };
}

export function harness(): Harness {
  const db = memoryDb();
  const repos = createRepos(db);
  const api = fakeApi();
  const replier = new Replier(api, repos, silent);
  const enqueue = vi.fn((type: string, payload: unknown) => repos.jobs.enqueue({ type, payload }));
  return { db, repos, api, replier, enqueue, jobs: { enqueue } };
}

export function fakeHealth(
  result: HealthResult,
): HealthChecker & { check: ReturnType<typeof vi.fn> } {
  return { check: vi.fn(async () => result), reset: () => {} };
}

export function healthResult(
  partial: Partial<HealthResult> & Pick<HealthResult, 'status'>,
): HealthResult {
  return { latencyMs: 12, checkedAt: '2026-10-29T00:00:00.000Z', ...partial };
}

export function classification(partial: Partial<ClassifyResult>): ClassifyResult {
  return {
    category: 'kb_answer',
    confidence: 0.9,
    answer: null,
    reason: 'test',
    classifier: 'rule',
    latencyMs: 5,
    ...partial,
  };
}

/** Inserts the inbound row like the dispatcher does and returns the handler context. */
export function inbound(
  repos: Repos,
  text: string,
  opts: { userId?: string; replyToken?: string | undefined } = {},
): TextMessageContext {
  const userId = opts.userId ?? 'U1';
  const replyToken = 'replyToken' in opts ? opts.replyToken : `tok-${Math.random()}`;
  repos.users.upsert({ userId });
  const messageId = repos.messages.insert({
    userId,
    direction: 'in',
    type: 'text',
    text,
    replyToken,
  });
  const event = {
    type: 'message',
    timestamp: 1700000000000,
    mode: 'active',
    deliveryContext: { isRedelivery: false },
    webhookEventId: `e-${messageId}`,
    replyToken,
    source: { type: 'user', userId },
    message: { type: 'text', id: `m${messageId}`, text, quoteToken: 'q' },
  } as unknown as webhook.MessageEvent;
  return { userId, text, replyToken, messageId, event };
}

export function pushReasons(db: ReturnType<typeof memoryDb>): string[] {
  return (db.prepare('SELECT reason FROM push_log ORDER BY id').all() as { reason: string }[]).map(
    (r) => r.reason,
  );
}

export function classificationRows(db: ReturnType<typeof memoryDb>) {
  return db.prepare('SELECT * FROM classifications ORDER BY id').all() as {
    message_id: number;
    category: string;
    confidence: number;
    classifier: string;
  }[];
}

export function incidentRows(db: ReturnType<typeof memoryDb>) {
  return db.prepare('SELECT * FROM incidents ORDER BY id').all() as {
    id: number;
    user_id: string;
    health_status: string;
    health_raw: string | null;
    admin_notified: number;
  }[];
}

export function jobRows(db: ReturnType<typeof memoryDb>) {
  return (
    db.prepare('SELECT type, payload, status FROM jobs ORDER BY id').all() as {
      type: string;
      payload: string;
      status: string;
    }[]
  ).map((j) => ({ ...j, payload: JSON.parse(j.payload) as Record<string, unknown> }));
}

export function sentTexts(api: FakeApi): { via: 'reply' | 'push'; text: string }[] {
  const out: { via: 'reply' | 'push'; text: string }[] = [];
  for (const [req] of api.replyMessage.mock.calls)
    for (const m of req.messages) out.push({ via: 'reply', text: m.text });
  for (const [req] of api.pushMessage.mock.calls)
    for (const m of req.messages) out.push({ via: 'push', text: m.text });
  return out;
}
