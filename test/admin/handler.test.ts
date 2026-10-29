import Anthropic from '@anthropic-ai/sdk';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN_TOOL_DEFS } from '../../src/admin/tools.js';
import { CAP_INSTRUCTION } from '../../src/admin/prompt.js';
import { EshopAuthError, EshopHttpError, EshopRateLimited } from '../../src/eshop/errors.js';
import {
  createAdminTextHandler,
  splitReply,
  type AdminHandlerDeps,
} from '../../src/handlers/admin.js';
import { texts } from '../../src/texts.js';
import {
  fakeHealth,
  harness,
  healthResult,
  inbound,
  pushReasons,
  sentTexts,
} from '../handlers/helpers.js';
import {
  deferred,
  endTurn,
  fakeEnduser,
  fakeEshop,
  fakeModel,
  LIST_ORDERS_INPUT,
  message,
  text,
  toolTurn,
  toolUse,
  type ScriptItem,
} from './fakes.js';

const ADMIN = 'Uadmin';
const MODEL = 'claude-opus-5-5';

function setup(
  script: ScriptItem[],
  over: Partial<AdminHandlerDeps> & { config?: Partial<AdminHandlerDeps['config']> } = {},
) {
  const h = harness();
  const model = fakeModel(script);
  const eshop = fakeEshop();
  const info = vi.fn();
  const log = pino({ level: 'silent' });
  log.info = info as never;
  const { config: configOver, ...rest } = over;
  const handle = createAdminTextHandler({
    repos: h.repos,
    replier: h.replier,
    health: fakeHealth(healthResult({ status: 'healthy' })),
    jobs: h.jobs,
    grok: { configured: true },
    eshop,
    enduser: fakeEnduser(),
    model: model.client,
    config: {
      ADMIN_USER_IDS: [ADMIN],
      ADMIN_MODEL: MODEL,
      ADMIN_MAX_TOOL_ROUNDS: 4,
      REPLY_DEADLINE_MS: 5000,
      CONTEXT_MESSAGES: 6,
      CONFIRMATION_TTL_MS: 600_000,
      ...configOver,
    },
    log,
    ...rest,
  });
  const queries = () =>
    h.db.prepare('SELECT * FROM admin_queries ORDER BY id').all() as {
      user_id: string;
      text: string;
      tools: string;
      reply: string;
      pii_revealed: number;
      latency_ms: number;
    }[];
  const outMessages = () =>
    (
      h.db.prepare("SELECT text FROM messages WHERE direction = 'out' ORDER BY id").all() as {
        text: string;
      }[]
    ).map((r) => r.text);
  return { ...h, model, eshop, handle, info, queries, outMessages };
}

describe('allowlist', () => {
  it('rejects non-allowlisted users without calling the model or writing admin_queries', async () => {
    const s = setup([endTurn('never')]);
    await s.handle(inbound(s.repos, '今天幾筆', { userId: 'Uother' }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminOnly }]);
    expect(s.model.calls).toHaveLength(0);
    expect(s.queries()).toHaveLength(0);
    expect(s.info).toHaveBeenCalledWith(
      { userId: 'Uother' },
      'admin bot: rejected non-allowlisted user',
    );
  });
});

describe('normal flow', () => {
  it('runs one tool round and replies once with the correct request shape', async () => {
    const s = setup([
      toolTurn(toolUse('tu1', 'list_orders', LIST_ORDERS_INPUT)),
      endTurn('今天未付款 3 筆'),
    ]);
    s.eshop.listOrders.mockResolvedValue({
      orders: [],
      pagination: { page: 1, limit: 1, total: 3, pages: 3 },
    });
    s.repos.messages.insert({ userId: ADMIN, direction: 'in', type: 'text', text: '哈囉' });
    s.repos.messages.insert({
      userId: ADMIN,
      direction: 'out',
      type: 'text',
      text: '請問要查什麼',
    });
    await s.handle(inbound(s.repos, '今天有幾筆未付款', { userId: ADMIN }));

    expect(s.model.calls).toHaveLength(2);
    const first = s.model.calls[0];
    expect(first.params.model).toBe(MODEL);
    expect(first.params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(first.params.fallbacks).toBe('default');
    expect(first.params.output_config?.effort).toBe('medium');
    expect(first.params.tool_choice).toEqual({ type: 'auto' });
    expect(first.params.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.params).not.toHaveProperty('thinking');
    expect(first.params.max_tokens).toBe(16000);
    expect(first.params.tools).toEqual(ADMIN_TOOL_DEFS);
    expect(first.params.system).toHaveLength(2);
    expect(first.params.messages).toEqual([
      { role: 'user', content: '哈囉' },
      { role: 'assistant', content: '請問要查什麼' },
      { role: 'user', content: '今天有幾筆未付款' },
    ]);
    expect(first.options).toMatchObject({ timeout: 60_000, maxRetries: 1 });
    expect(first.options?.signal).toBeInstanceOf(AbortSignal);

    const second = s.model.calls[1].params.messages;
    expect(second).toHaveLength(5);
    expect(second[3]).toEqual({
      role: 'assistant',
      content: [toolUse('tu1', 'list_orders', LIST_ORDERS_INPUT)],
    });
    const last = second[4] as {
      role: string;
      content: { type: string; tool_use_id: string; content: string }[];
    };
    expect(last.role).toBe('user');
    expect(last.content).toHaveLength(1);
    expect(last.content[0].type).toBe('tool_result');
    expect(last.content[0].tool_use_id).toBe('tu1');
    expect(JSON.parse(last.content[0].content)).toMatchObject({ total: 3, returned: 0 });

    expect(s.api.replyMessage).toHaveBeenCalledTimes(1);
    expect(s.api.pushMessage).not.toHaveBeenCalled();
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: '今天未付款 3 筆' }]);
    expect(s.api.showLoadingAnimation).toHaveBeenCalledWith({ chatId: ADMIN, loadingSeconds: 60 });

    const rows = s.queries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: ADMIN,
      text: '今天有幾筆未付款',
      reply: '今天未付款 3 筆',
      pii_revealed: 0,
    });
    expect(rows[0].latency_ms).toBeGreaterThanOrEqual(0);
    const tools = JSON.parse(rows[0].tools) as { name: string; ok: boolean; input: unknown }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'list_orders', ok: true, input: LIST_ORDERS_INPUT });
    expect(s.outMessages()).toEqual(['請問要查什麼', '今天未付款 3 筆']);
  });

  it('empty end_turn text → adminEmptyAnswer', async () => {
    const s = setup([{ stop_reason: 'end_turn', content: [] }]);
    await s.handle(inbound(s.repos, 'hi', { userId: ADMIN }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminEmptyAnswer }]);
  });

  it('a leading slash is plain text for the model', async () => {
    const s = setup([endTurn('ok')]);
    await s.handle(inbound(s.repos, '/status', { userId: ADMIN }));
    expect(s.model.calls[0].params.messages).toEqual([{ role: 'user', content: '/status' }]);
  });
});

describe('parallel tool_use', () => {
  it('puts every tool_result in ONE user message in order, and runs them concurrently', async () => {
    const s = setup([
      toolTurn(toolUse('a', 'stats', {}), toolUse('b', 'low_stock', {})),
      endTurn('系統正常'),
    ]);
    const statsGate = deferred<void>();
    s.eshop.stats.mockImplementation(async () => {
      await statsGate.promise;
      return { today: { orders: 1, revenue: 1 }, month: { revenue: 1 } };
    });
    s.eshop.lowStock.mockImplementation(async () => {
      statsGate.resolve(); // only reachable if both run at the same time
      return { products: [], addons: [], total: 0 };
    });
    await s.handle(inbound(s.repos, '系統正常嗎', { userId: ADMIN }));
    const msgs = s.model.calls[1].params.messages;
    const last = msgs.at(-1) as { role: string; content: { type: string; tool_use_id: string }[] };
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(last.role).toBe('user');
    expect(last.content.map((c) => [c.type, c.tool_use_id])).toEqual([
      ['tool_result', 'a'],
      ['tool_result', 'b'],
    ]);
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: '系統正常' }]);
  });

  it('a tool executor validation error becomes an is_error result and the loop continues', async () => {
    const s = setup([
      toolTurn(toolUse('a', 'list_orders', { ...LIST_ORDERS_INPUT, dateFrom: 'bad' })),
      endTurn('日期格式不對'),
    ]);
    await s.handle(inbound(s.repos, 'x', { userId: ADMIN }));
    const last = s.model.calls[1].params.messages.at(-1) as {
      content: { is_error?: boolean; content: string }[];
    };
    expect(last.content[0].is_error).toBe(true);
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: '日期格式不對' }]);
    expect(s.queries()[0].reply).toBe('日期格式不對');
  });
});

describe('PII', () => {
  const id = '#20261029-ABCDEF12';

  it('reveal_pii without explicit ask stays masked, pii 0', async () => {
    const s = setup([
      toolTurn(toolUse('a', 'get_order', { orderId: id, reveal_pii: true })),
      endTurn('已付款，電話 0912****78'),
    ]);
    await s.handle(inbound(s.repos, `${id} 狀態`, { userId: ADMIN }));
    const result = (s.model.calls[1].params.messages.at(-1) as { content: { content: string }[] })
      .content[0].content;
    expect(result).toContain('0912****78');
    expect(result).not.toContain('0912345678');
    expect(s.queries()[0].pii_revealed).toBe(0);
    expect(s.queries()[0].reply).toBe('已付款，電話 0912****78');
  });

  it('explicit ask: full phone reaches LINE but only the placeholder is stored', async () => {
    const s = setup([
      toolTurn(toolUse('a', 'get_order', { orderId: id, reveal_pii: true })),
      endTurn('（含完整個資）電話 0912345678'),
    ]);
    await s.handle(inbound(s.repos, `給我 ${id} 的完整電話`, { userId: ADMIN }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: '（含完整個資）電話 0912345678' }]);
    expect(s.outMessages()).toEqual([texts.adminPiiRecordPlaceholder]);
    const row = s.queries()[0];
    expect(row.pii_revealed).toBe(1);
    expect(row.reply).toBe(texts.adminPiiRecordPlaceholder);
    expect(JSON.parse(row.tools)[0]).toMatchObject({
      name: 'get_order',
      piiRevealed: true,
      revealHonoured: true,
    });
  });
});

describe('tool round cap', () => {
  it('forces an answer on round N+1 with tool_choice none + system cap message', async () => {
    const s = setup(
      [
        toolTurn(toolUse('a', 'stats', {})),
        toolTurn(toolUse('b', 'stats', {})),
        endTurn('目前查到今日 3 筆'),
      ],
      { config: { ADMIN_MAX_TOOL_ROUNDS: 2 } },
    );
    await s.handle(inbound(s.repos, '查很多東西', { userId: ADMIN }));
    expect(s.model.calls).toHaveLength(3);
    expect(s.model.calls[0].params.tool_choice).toEqual({ type: 'auto' });
    expect(s.model.calls[1].params.tool_choice).toEqual({ type: 'auto' });
    const third = s.model.calls[2].params;
    expect(third.tool_choice).toEqual({ type: 'none' });
    expect(third.messages.at(-1)).toEqual({ role: 'system', content: CAP_INSTRUCTION });
    expect(third.messages.at(-2)?.role).toBe('user');
    expect(sentTexts(s.api)).toEqual([
      { via: 'reply', text: `目前查到今日 3 筆\n${texts.adminToolCapNote}` },
    ]);
    expect(s.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'capped', rounds: 2, tools: ['stats', 'stats'] }),
      'admin query done',
    );
  });

  it('tool_use after the cap is a model error', async () => {
    const s = setup([toolTurn(toolUse('a', 'stats', {})), toolTurn(toolUse('b', 'stats', {}))], {
      config: { ADMIN_MAX_TOOL_ROUNDS: 1 },
    });
    await s.handle(inbound(s.repos, 'x', { userId: ADMIN }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminModelUnavailable }]);
    expect(s.eshop.stats).toHaveBeenCalledTimes(1);
  });
});

describe('deadline', () => {
  it('acks with the reply token, then pushes the answer as admin_late_reply', async () => {
    const gate = deferred<ReturnType<typeof message>>();
    const s = setup([() => gate.promise], { config: { REPLY_DEADLINE_MS: 20 } });
    const done = s.handle(inbound(s.repos, '慢查詢', { userId: ADMIN }));
    await vi.waitFor(() => expect(s.api.replyMessage).toHaveBeenCalledTimes(1));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminAckPending }]);
    gate.resolve(message(endTurn('答案來了')));
    await done;
    expect(sentTexts(s.api)).toEqual([
      { via: 'reply', text: texts.adminAckPending },
      { via: 'push', text: '答案來了' },
    ]);
    expect(pushReasons(s.db)).toEqual(['admin_late_reply']);
    expect(s.queries()[0].reply).toBe('答案來了');
  });
});

describe('error mapping', () => {
  const eshopCases: [string, Error][] = [
    ['EshopAuthError', new EshopAuthError('login_locked_out')],
    ['EshopRateLimited', new EshopRateLimited()],
    ['EshopHttpError', new EshopHttpError(500, '')],
  ];
  for (const [name, err] of eshopCases) {
    it(`${name} → its userMessage, model not called again, admin_queries written`, async () => {
      const s = setup([toolTurn(toolUse('a', 'stats', {})), endTurn('should not happen')]);
      s.eshop.stats.mockRejectedValue(err);
      await s.handle(inbound(s.repos, 'x', { userId: ADMIN }));
      const expected = (err as { userMessage: string }).userMessage;
      expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: expected }]);
      expect(s.model.calls).toHaveLength(1);
      expect(s.queries()).toHaveLength(1);
      expect(s.queries()[0].reply).toBe(expected);
      expect(s.info).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'eshop_error' }),
        'admin query done',
      );
    });
  }

  it('APIConnectionError → adminModelUnavailable', async () => {
    const s = setup([new Anthropic.APIConnectionError({ message: 'x' })]);
    await s.handle(inbound(s.repos, 'x', { userId: ADMIN }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminModelUnavailable }]);
    expect(s.queries()).toHaveLength(1);
    expect(s.queries()[0].reply).toBe(texts.adminModelUnavailable);
  });

  it('APIError 401 → adminModelUnavailable', async () => {
    const s = setup([
      new Anthropic.AuthenticationError(401, { type: 'error' }, 'bad key', new Headers()),
    ]);
    await s.handle(inbound(s.repos, 'x', { userId: ADMIN }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminModelUnavailable }]);
  });

  it('refusal → adminModelRefused and no tool executed', async () => {
    const s = setup([
      {
        stop_reason: 'refusal',
        content: [toolUse('a', 'stats', {})],
        stop_details: { type: 'refusal', reason: 'x' } as never,
      },
    ]);
    await s.handle(inbound(s.repos, 'x', { userId: ADMIN }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminModelRefused }]);
    expect(s.eshop.stats).not.toHaveBeenCalled();
    expect(s.model.calls).toHaveLength(1);
    expect(s.queries()[0].reply).toBe(texts.adminModelRefused);
  });

  it('max_tokens → adminModelUnavailable', async () => {
    const s = setup([{ stop_reason: 'max_tokens', content: [text('partial')] }]);
    await s.handle(inbound(s.repos, 'x', { userId: ADMIN }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminModelUnavailable }]);
    expect(s.queries()).toHaveLength(1);
  });

  it('unexpected tool exception → fallbackError', async () => {
    const s = setup([toolTurn(toolUse('a', 'stats', {}))]);
    s.eshop.stats.mockRejectedValue(new TypeError('boom'));
    await s.handle(inbound(s.repos, 'x', { userId: ADMIN }));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.fallbackError }]);
    expect(s.queries()[0].reply).toBe(texts.fallbackError);
  });

  it('LINE failure on the final reply never rejects and tries the fallback via push', async () => {
    const s = setup([endTurn('ok')]);
    s.api.replyMessage.mockRejectedValue(new Error('line down'));
    s.api.pushMessage.mockRejectedValue(new Error('line down'));
    await expect(s.handle(inbound(s.repos, 'x', { userId: ADMIN }))).resolves.toBeUndefined();
    expect(s.queries()).toHaveLength(1);
  });

  it('without a reply token the answer is pushed', async () => {
    const s = setup([endTurn('ok')]);
    await s.handle(inbound(s.repos, 'x', { userId: ADMIN, replyToken: undefined }));
    expect(pushReasons(s.db)).toEqual(['admin_late_reply']);
  });
});

describe('splitReply', () => {
  it('short text is one message', () => {
    expect(splitReply('hi')).toEqual(['hi']);
  });

  it('12,000 chars → 3 messages each ≤5000', () => {
    const line = 'x'.repeat(99);
    const textIn = Array.from({ length: 120 }, () => line).join('\n'); // 120*100-1 = 11,999
    const out = splitReply(textIn);
    expect(out).toHaveLength(3);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(5000);
    expect(out.join('\n')).toBe(textIn);
  });

  it('30,000 chars → 5 messages, last ends with adminTruncated', () => {
    const out = splitReply('y'.repeat(30_000));
    expect(out).toHaveLength(5);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(5000);
    expect(out[4].endsWith(texts.adminTruncated)).toBe(true);
  });
});
