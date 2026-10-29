import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildDateBlock, buildSystem, CAP_INSTRUCTION } from '../../src/admin/prompt.js';
import {
  ADMIN_TOOL_DEFS,
  createToolExecutor,
  MAX_CALLS_PER_ROUND,
  type ToolExecutorDeps,
} from '../../src/admin/tools.js';
import { HIDDEN } from '../../src/eshop/mask.js';
import { EshopRateLimited } from '../../src/eshop/errors.js';
import type { GrokTask } from '../../src/grok/gateway.js';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { fakeHealth, harness, healthResult, jobRows, silent } from '../handlers/helpers.js';
import {
  fakeEnduser,
  fakeEshop,
  LIST_ORDERS_INPUT,
  order,
  toolUse,
  type FakeEshop,
} from './fakes.js';

const FORBIDDEN = [
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  '$ref',
  '$defs',
  '$schema',
];

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

describe('ADMIN_TOOL_DEFS', () => {
  it('has the fixed names and order, all strict', () => {
    expect(ADMIN_TOOL_DEFS.map((t) => t.name)).toEqual([
      'list_orders',
      'get_order',
      'list_products',
      'low_stock',
      'stats',
      'health',
      'report_issue',
      'reply_customer',
    ]);
    for (const t of ADMIN_TOOL_DEFS) expect(t.strict).toBe(true);
  });

  it('every object is closed with required = all properties, no unsupported keywords', () => {
    for (const t of ADMIN_TOOL_DEFS) {
      walk(t.input_schema, (o) => {
        if (o.type === 'object') {
          expect(o.additionalProperties).toBe(false);
          const props = Object.keys((o.properties as object | undefined) ?? {});
          expect([...(o.required as string[])].sort()).toEqual([...props].sort());
        }
        for (const k of FORBIDDEN) expect(o).not.toHaveProperty(k);
      });
    }
  });
});

describe('buildSystem / buildDateBlock', () => {
  it('rules block is identical across runs and carries the cache breakpoint', () => {
    const a = buildSystem(new Date('2026-10-30T06:05:00Z'));
    const b = buildSystem(new Date('2027-03-01T00:00:00Z'));
    expect(a).toHaveLength(2);
    expect(a[0]).toEqual(b[0]);
    expect(a[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(a[1].cache_control).toBeUndefined();
    expect(a[1].text).not.toBe(b[1].text);
  });

  it('produces the documented anchors for 2026-10-30T06:05Z', () => {
    expect(buildDateBlock(new Date('2026-10-30T06:05:00Z'))).toBe(
      [
        '現在時間：2026-10-30 14:05（星期五，台北時間 UTC+08:00）',
        '日期錨點（dateTo 包含）：',
        '- 今天：2026-10-30T00:00:00+08:00 ~ 2026-10-30T23:59:59+08:00',
        '- 昨天：2026-10-29T00:00:00+08:00 ~ 2026-10-29T23:59:59+08:00',
        '- 這週：2026-10-26T00:00:00+08:00 ~ 2026-10-30T23:59:59+08:00',
        '- 本月：2026-10-01T00:00:00+08:00 ~ 2026-10-30T23:59:59+08:00',
        '- 上個月：2026-09-01T00:00:00+08:00 ~ 2026-09-30T23:59:59+08:00',
      ].join('\n'),
    );
  });

  it('last month crosses the year boundary', () => {
    const block = buildDateBlock(new Date('2027-01-01T02:00:00Z'));
    expect(block).toContain('- 上個月：2026-12-01T00:00:00+08:00 ~ 2026-12-31T23:59:59+08:00');
    expect(block).toContain('- 本月：2027-01-01T00:00:00+08:00 ~ 2027-01-01T23:59:59+08:00');
  });

  it('this week starts today on a Taipei Monday 00:30 (UTC Sunday 16:30)', () => {
    const block = buildDateBlock(new Date('2026-10-25T16:30:00Z'));
    expect(block).toContain('現在時間：2026-10-26 00:30（星期一');
    expect(block).toContain('- 這週：2026-10-26T00:00:00+08:00 ~ 2026-10-26T23:59:59+08:00');
    expect(block).toContain('- 昨天：2026-10-25T00:00:00+08:00 ~ 2026-10-25T23:59:59+08:00');
  });

  it('CAP_INSTRUCTION is the fixed text', () => {
    expect(CAP_INSTRUCTION).toContain('工具呼叫次數已達上限');
  });
});

function setup(over: Partial<ToolExecutorDeps> = {}) {
  const h = harness();
  const eshop = (over.eshop as FakeEshop | undefined) ?? fakeEshop();
  const warn = vi.fn();
  const log = pino({ level: 'silent' });
  log.warn = warn as never;
  const executor = createToolExecutor({
    eshop,
    health: fakeHealth(healthResult({ status: 'healthy' })),
    repos: h.repos,
    jobs: h.jobs,
    grok: { configured: true },
    enduser: fakeEnduser(),
    confirmationTtlMs: 600_000,
    userId: 'Uadmin',
    userText: '今天有幾筆未付款',
    messageId: 1,
    context: [],
    log,
    ...over,
  });
  return { ...h, eshop, executor, warn };
}

const parse = (r: { content?: unknown }) =>
  JSON.parse(r.content as string) as Record<string, unknown>;

describe('list_orders executor', () => {
  it('maps params, clamps limit / page and drops null fields', async () => {
    const s = setup();
    const cases: [unknown, number][] = [
      [50, 20],
      [null, 10],
      [0, 1],
      [2.7, 2],
    ];
    for (const [limit, expected] of cases) {
      s.eshop.listOrders.mockClear();
      await s.executor.runRound([
        toolUse('t1', 'list_orders', { ...LIST_ORDERS_INPUT, limit, page: null }),
      ]);
      expect(s.eshop.listOrders).toHaveBeenCalledWith({
        page: 1,
        limit: expected,
        paymentStatus: 'pending',
        dateFrom: '2026-10-30T00:00:00+08:00',
        dateTo: '2026-10-30T23:59:59+08:00',
      });
    }
  });

  it('rejects dateFrom without timezone or non-ISO as is_error without calling eshop', async () => {
    const s = setup();
    for (const bad of ['2026-10-30T00:00:00', 'yesterday']) {
      const [r] = await s.executor.runRound([
        toolUse('t1', 'list_orders', { ...LIST_ORDERS_INPUT, dateFrom: bad }),
      ]);
      expect(r.is_error).toBe(true);
      expect(parse(r).error).toContain('dateFrom');
    }
    expect(s.eshop.listOrders).not.toHaveBeenCalled();
    expect(s.executor.records.every((r) => r.ok === false)).toBe(true);
  });

  it('returns ≤20 rows, total from pagination and masked customer bits', async () => {
    const s = setup();
    s.eshop.listOrders.mockResolvedValue({
      orders: Array.from({ length: 25 }, (_, i) => order({ orderId: `#2026-${i}` })),
      pagination: { page: 1, limit: 20, total: 123, pages: 7 },
    });
    const [r] = await s.executor.runRound([
      toolUse('t1', 'list_orders', { ...LIST_ORDERS_INPUT, limit: 20 }),
    ]);
    const body = parse(r);
    expect(body.total).toBe(123);
    expect(body.pages).toBe(7);
    expect(body.returned).toBe(20);
    expect(body.piiRevealed).toBe(false);
    const rows = body.rows as string[];
    expect(rows).toHaveLength(20);
    expect(rows[0]).toContain('#2026-0｜');
    expect(rows[0]).toContain('王小明 IG ming_ig 0912****78 經銷 好狗店');
    expect(rows[0]).not.toContain('ming@example.com');
    expect(s.executor.piiRevealed).toBe(false);
  });

  it('schema failure (unknown field / wrong type) is is_error', async () => {
    const s = setup();
    const [r] = await s.executor.runRound([
      toolUse('t1', 'list_orders', { ...LIST_ORDERS_INPUT, extra: 1 }),
    ]);
    expect(r.is_error).toBe(true);
    expect(s.eshop.listOrders).not.toHaveBeenCalled();
  });

  it('unknown tool name is is_error', async () => {
    const s = setup();
    const [r] = await s.executor.runRound([toolUse('t1', 'delete_order', {})]);
    expect(r.is_error).toBe(true);
    expect(parse(r).error).toContain('delete_order');
  });

  it('calls beyond MAX_CALLS_PER_ROUND are not executed', async () => {
    const s = setup();
    const calls = Array.from({ length: MAX_CALLS_PER_ROUND + 2 }, (_, i) =>
      toolUse(`t${i}`, 'stats', {}),
    );
    const results = await s.executor.runRound(calls);
    expect(results).toHaveLength(MAX_CALLS_PER_ROUND + 2);
    expect(results.slice(0, MAX_CALLS_PER_ROUND).every((r) => !r.is_error)).toBe(true);
    expect(results.slice(MAX_CALLS_PER_ROUND).every((r) => r.is_error)).toBe(true);
    expect(s.eshop.stats).toHaveBeenCalledTimes(MAX_CALLS_PER_ROUND);
  });

  it('eshop errors are thrown after the round settles (first by tool order)', async () => {
    const s = setup();
    s.eshop.stats.mockRejectedValue(new EshopRateLimited(5));
    s.eshop.lowStock.mockRejectedValue(new Error('other'));
    await expect(
      s.executor.runRound([toolUse('a', 'low_stock', {}), toolUse('b', 'stats', {})]),
    ).rejects.toBeInstanceOf(EshopRateLimited);
    expect(s.executor.records.map((r) => r.ok)).toEqual([false, false]);
  });
});

describe('get_order / list_products / low_stock / stats / health', () => {
  it('get_order null → found:false', async () => {
    const s = setup();
    s.eshop.getOrder.mockResolvedValue(null);
    const [r] = await s.executor.runRound([
      toolUse('t', 'get_order', { orderId: '20261029-ABCDEF12', reveal_pii: false }),
    ]);
    expect(parse(r)).toEqual({ found: false });
    expect(s.eshop.getOrder).toHaveBeenCalledWith('20261029-ABCDEF12');
  });

  it('get_order masks by default', async () => {
    const s = setup();
    const [r] = await s.executor.runRound([
      toolUse('t', 'get_order', { orderId: '#20261029-ABCDEF12', reveal_pii: false }),
    ]);
    const body = parse(r);
    expect(body.found).toBe(true);
    expect(body.piiRevealed).toBe(false);
    const detail = body.detail as string;
    expect(detail).toContain('0912****78');
    expect(detail).not.toContain('0912345678');
    expect(detail).toContain(HIDDEN);
    expect(detail).not.toContain('台北市中正區');
  });

  it('list_products filters by query (name or sub) and activeOnly defaults to true, 50 rows max', async () => {
    const s = setup();
    s.eshop.listProducts.mockResolvedValue([
      { productId: 1, name: '雞肉條', sub: '狗', active: true, stock: 5, lowStockThreshold: 3 },
      {
        productId: 2,
        name: '鴨肉乾',
        sub: '貓零食',
        active: false,
        stock: 0,
        lowStockThreshold: 3,
      },
      {
        productId: 3,
        name: '鮭魚',
        active: true,
        stock: null,
        trackStock: false,
        variants: [
          { label: '大', stock: 7 },
          { label: '小', stock: 2 },
        ],
      },
      ...Array.from({ length: 60 }, (_, i) => ({
        productId: 100 + i,
        name: `其他${i}`,
        active: true,
      })),
    ]);
    const [all, byName, inactive, cat] = await s.executor.runRound([
      toolUse('a', 'list_products', { query: null, activeOnly: null }),
      toolUse('b', 'list_products', { query: '鮭', activeOnly: null }),
      toolUse('c', 'list_products', { query: '鴨', activeOnly: false }),
      toolUse('d', 'list_products', { query: '貓', activeOnly: null }),
    ]);
    expect(parse(all).total).toBe(62);
    expect(parse(all).returned).toBe(50);
    expect(parse(byName).rows).toEqual(['鮭魚｜庫存 -｜警戒 -｜不追蹤庫存｜規格 大 7、小 2']);
    expect(parse(inactive).rows).toEqual(['鴨肉乾｜庫存 0｜警戒 3｜未上架']);
    expect(parse(cat).total).toBe(0);
  });

  it('low_stock lists products and addons', async () => {
    const s = setup();
    s.eshop.lowStock.mockResolvedValue({
      products: [{ productId: 1, name: '雞肉條', stock: 1, lowStockThreshold: 3 }],
      addons: [{ name: '小魚乾', stock: 0, lowStockThreshold: 2 }],
    });
    const [r] = await s.executor.runRound([toolUse('a', 'low_stock', {})]);
    expect(parse(r)).toEqual({
      total: 2,
      products: ['雞肉條｜庫存 1｜警戒 3'],
      addons: ['加價購 小魚乾｜庫存 0｜警戒 2'],
    });
  });

  it('stats passes through and health returns status + latency', async () => {
    const s = setup();
    const [st, he] = await s.executor.runRound([
      toolUse('a', 'stats', {}),
      toolUse('b', 'health', {}),
    ]);
    expect(parse(st).today).toEqual({ orders: 3, revenue: 1280 });
    expect(parse(he)).toEqual({ status: 'healthy', latencyMs: 12 });
  });
});

describe('PII gate', () => {
  it('reveal_pii without an explicit ask is forced false and logged', async () => {
    const s = setup({ userText: '#20261029-ABCDEF12 狀態' });
    const [r] = await s.executor.runRound([
      toolUse('t', 'get_order', { orderId: '#20261029-ABCDEF12', reveal_pii: true }),
    ]);
    expect(parse(r).piiRevealed).toBe(false);
    expect(parse(r).detail as string).toContain('0912****78');
    expect(s.executor.piiRevealed).toBe(false);
    expect(s.executor.records[0].revealHonoured).toBe(false);
    expect(s.warn).toHaveBeenCalledWith(
      { tool: 'get_order', userId: 'Uadmin' },
      'reveal_pii requested without explicit ask; forced false',
    );
  });

  it('explicit ask + reveal_pii reveals and flips piiRevealed', async () => {
    const s = setup({ userText: '給我 #20261029-ABCDEF12 的完整電話' });
    const [r] = await s.executor.runRound([
      toolUse('t', 'get_order', { orderId: '#20261029-ABCDEF12', reveal_pii: true }),
    ]);
    expect(parse(r).piiRevealed).toBe(true);
    expect(parse(r).detail as string).toContain('0912345678');
    expect(s.executor.piiRevealed).toBe(true);
    expect(s.warn).not.toHaveBeenCalled();
  });

  it('explicit ask but no rows: run stays masked', async () => {
    const s = setup({ userText: '昨天訂單的電話' });
    s.eshop.listOrders.mockResolvedValue({
      orders: [],
      pagination: { page: 1, limit: 10, total: 0, pages: 0 },
    });
    await s.executor.runRound([
      toolUse('t', 'list_orders', { ...LIST_ORDERS_INPUT, reveal_pii: true }),
    ]);
    expect(s.executor.piiRevealed).toBe(false);
  });
});

describe('report_issue', () => {
  const input = {
    description: '客人說 LINE Pay 付完款訂單沒更新',
    relatedOrderIds: ['#20261029-ABCDEF12', '#missing'],
  };

  it('writes an incident, enqueues incident_triage that the job handler dispatches masked', async () => {
    const s = setup({ userText: '客人說 LINE Pay 付完款訂單沒更新，電話 0912345678' });
    s.eshop.getOrder.mockImplementation(async (id) => (id === '#missing' ? null : order()));
    const [r] = await s.executor.runRound([toolUse('t', 'report_issue', input)]);
    const body = parse(r);
    expect(body.queued).toBe(true);
    const incident = s.db.prepare('SELECT * FROM incidents').all() as Record<string, unknown>[];
    expect(incident).toHaveLength(1);
    expect(incident[0].id).toBe(body.taskId);
    expect(incident[0].text).toBe(input.description);
    expect(incident[0].health_status).toBe('healthy');
    expect(s.executor.records[0].taskId).toBe(body.taskId);

    const jobs = jobRows(s.db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe('incident_triage');
    expect(jobs[0].payload).toMatchObject({
      userId: 'Uadmin',
      incidentId: body.taskId,
      messageId: 1,
      source: 'admin',
    });

    const dispatched: GrokTask[] = [];
    const queue = new JobQueue(s.repos.jobs, { logger: silent, maxAttempts: 1 });
    queue.setHandlers(
      createJobHandlers({
        repos: s.repos,
        replier: s.replier,
        grok: {
          configured: true,
          run: async (t) => {
            dispatched.push(t);
            return { ok: true, accepted: true };
          },
        },
        config: { ADMIN_LINE_USER_ID: undefined, GROK_TASK_TIMEOUT_MS: 60_000 },
        log: silent,
      }),
    );
    await queue.tick();
    expect(s.repos.jobs.get(jobs.length)!.status).toBe('done');
    expect(dispatched).toHaveLength(1);
    const task = dispatched[0];
    expect(task.type).toBe('incident_triage');
    expect(task.userMessage).toContain('[管理端回報] 客人說 LINE Pay 付完款訂單沒更新');
    expect(task.userMessage).toContain('今日 3 筆 / NT$1,280，本月 NT$56,000，待出貨 2，低庫存 1');
    expect(task.userMessage).toContain('#20261029-ABCDEF12');
    expect(task.userMessage).toContain('#missing：查無此訂單');
    expect(task.userMessage).toContain('0912****78');
    expect(task.userMessage.split('管理員原文')[1]).not.toContain('0912345678\n相關');
    expect(task.userMessage.split('相關訂單（已遮罩）')[1]).not.toContain('0912345678');
    expect(task.health?.status).toBe('healthy');
  });

  it('second call in the same run is is_error', async () => {
    const s = setup();
    const [a, b] = await s.executor.runRound([
      toolUse('a', 'report_issue', input),
      toolUse('b', 'report_issue', input),
    ]);
    expect(a.is_error).toBeUndefined();
    expect(b.is_error).toBe(true);
    expect(parse(b).error).toBe('本次對話已送出一次回報');
    expect(jobRows(s.db)).toHaveLength(1);
  });

  it('grok not configured → queued:false and no job', async () => {
    const s = setup({ grok: { configured: false } });
    const [r] = await s.executor.runRound([toolUse('a', 'report_issue', input)]);
    expect(parse(r)).toMatchObject({ queued: false, reason: '分析系統未設定' });
    expect(typeof parse(r).taskId).toBe('number');
    expect(jobRows(s.db)).toHaveLength(0);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()).toEqual({ n: 1 });
  });

  it('stats or order lookup failures do not abort the report', async () => {
    const s = setup();
    s.eshop.stats.mockRejectedValue(new EshopRateLimited());
    s.eshop.getOrder.mockRejectedValue(new EshopRateLimited());
    const [r] = await s.executor.runRound([toolUse('a', 'report_issue', input)]);
    expect(r.is_error).toBeUndefined();
    expect(parse(r).queued).toBe(true);
    const payload = jobRows(s.db)[0].payload as { text: string };
    expect(payload.text).toContain('統計：查詢失敗：後台目前請求過多');
    expect(payload.text).toContain('#20261029-ABCDEF12：查詢失敗：');
  });
});
