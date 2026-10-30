import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { EnduserClientError } from '../../src/admin/enduserClient.js';
import { createAdminTextHandler, type AdminHandlerDeps } from '../../src/handlers/admin.js';
import {
  adminReplyConfirm,
  adminReplyFailed,
  adminReplySent,
  adminTicketClosedDone,
  adminTicketDetail,
  adminTicketList,
  texts,
} from '../../src/texts.js';
import { fakeHealth, harness, healthResult, inbound, sentTexts } from '../handlers/helpers.js';
import {
  endTurn,
  fakeEnduser,
  fakeEshop,
  fakeModel,
  ticketDetail,
  ticketSummary,
  toolTurn,
  toolUse,
  type ScriptItem,
} from './fakes.js';

const ADMIN = 'Uadmin';
const ADMIN2 = 'Uboss';
const T0 = new Date('2026-10-30T06:00:00.000Z');

function setup(script: ScriptItem[] = [], over: Partial<AdminHandlerDeps> = {}) {
  const h = harness();
  const model = fakeModel(script);
  const enduser = fakeEnduser();
  let clock = T0;
  const handle = createAdminTextHandler({
    repos: h.repos,
    replier: h.replier,
    health: fakeHealth(healthResult({ status: 'healthy' })),
    jobs: h.jobs,
    grok: { configured: true },
    eshop: fakeEshop(),
    enduser,
    model: model.client,
    config: {
      ADMIN_USER_IDS: [ADMIN, ADMIN2],
      ADMIN_MODEL: 'claude-opus-5-5',
      ADMIN_MAX_TOOL_ROUNDS: 4,
      REPLY_DEADLINE_MS: 5000,
      CONTEXT_MESSAGES: 6,
      CONFIRMATION_TTL_MS: 600_000,
    },
    now: () => clock,
    log: pino({ level: 'silent' }),
    ...over,
  });
  const pending = (admin = ADMIN) =>
    h.db
      .prepare(
        'SELECT admin_user_id, ticket_id, text, expires_at FROM pending_confirmations WHERE admin_user_id = ?',
      )
      .get(admin) as
      { admin_user_id: string; ticket_id: number; text: string; expires_at: string } | undefined;
  const queries = () =>
    h.db
      .prepare('SELECT user_id, text, tools, reply, latency_ms FROM admin_queries ORDER BY id')
      .all() as {
      user_id: string;
      text: string;
      tools: string;
      reply: string;
      latency_ms: number;
    }[];
  const send = (text: string, userId = ADMIN) => handle(inbound(h.repos, text, { userId }));
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const last = () => sentTexts(h.api).at(-1);
  return { ...h, model, enduser, handle, pending, queries, send, advance, last };
}

const CONFIRM = adminReplyConfirm('T001', '已出貨');

describe('回覆 T<id> <text> → staged confirmation', () => {
  it('stages the reply, replies with the confirm text and writes the pending row + audit', async () => {
    const s = setup();
    await s.send('回覆 T001 已出貨');
    expect(s.enduser.getTicket).toHaveBeenCalledWith(1);
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: CONFIRM }]);
    expect(s.pending()).toEqual({
      admin_user_id: ADMIN,
      ticket_id: 1,
      text: '已出貨',
      expires_at: '2026-10-30T06:10:00.000Z',
    });
    expect(s.model.calls).toHaveLength(0);
    const [q] = s.queries();
    expect(q).toMatchObject({ user_id: ADMIN, text: '回覆 T001 已出貨', reply: CONFIRM });
    expect(JSON.parse(q.tools)).toEqual([
      { name: 'reply_customer', ticketId: 1, result: 'staged' },
    ]);
    expect(q.latency_ms).toBe(0);
  });

  it.each(['回覆T1：已出貨', '回覆 1: 已出貨', '回覆 t001  已出貨 '])(
    'accepts the form %s',
    async (text) => {
      const s = setup();
      await s.send(text);
      expect(s.last()).toEqual({ via: 'reply', text: CONFIRM });
      expect(s.pending()?.text).toBe('已出貨');
    },
  );

  it('unknown ticket → adminTicketNotFound, nothing pending', async () => {
    const s = setup();
    await s.send('回覆 T042 已出貨');
    expect(s.last()).toEqual({ via: 'reply', text: texts.adminTicketNotFound });
    expect(s.pending()).toBeUndefined();
    expect(JSON.parse(s.queries()[0].tools)).toEqual([
      { name: 'reply_customer', ticketId: 42, result: 'not_found' },
    ]);
  });

  it('closed ticket → adminTicketClosed, nothing pending', async () => {
    const s = setup();
    s.enduser.getTicket.mockResolvedValueOnce(ticketDetail({ status: 'closed' }));
    await s.send('回覆 T001 已出貨');
    expect(s.last()).toEqual({ via: 'reply', text: texts.adminTicketClosed });
    expect(s.pending()).toBeUndefined();
  });

  it('over 1000 chars → adminReplyTooLong without contacting the enduser bot', async () => {
    const s = setup();
    await s.send(`回覆 T001 ${'x'.repeat(1001)}`);
    expect(s.last()).toEqual({ via: 'reply', text: texts.adminReplyTooLong });
    expect(s.enduser.getTicket).not.toHaveBeenCalled();
    expect(s.pending()).toBeUndefined();
  });

  it('enduser bot unreachable → its userMessage', async () => {
    const s = setup();
    s.enduser.getTicket.mockRejectedValueOnce(
      new EnduserClientError('network', '客服端服務無法連線'),
    );
    await s.send('回覆 T001 已出貨');
    expect(s.last()).toEqual({ via: 'reply', text: '客服端服務無法連線' });
    expect(JSON.parse(s.queries()[0].tools)).toEqual([
      { name: 'reply_customer', ticketId: 1, result: 'failed:network' },
    ]);
  });
});

describe('pending confirmation', () => {
  it('Y sends via replyTicket(by = admin), clears the row and replies adminReplySent', async () => {
    const s = setup();
    await s.send('回覆 T001 已出貨');
    await s.send('Y');
    expect(s.enduser.replyTicket).toHaveBeenCalledWith(1, '已出貨', ADMIN);
    expect(s.last()).toEqual({ via: 'reply', text: adminReplySent('T001', 'U6037873…') });
    expect(s.pending()).toBeUndefined();
    expect(s.model.calls).toHaveLength(0);
    const q = s.queries()[1];
    expect(q.text).toBe('Y');
    expect(JSON.parse(q.tools)).toEqual([{ name: 'reply_customer', ticketId: 1, result: 'sent' }]);
  });

  it.each(['y', 'yes', '是', '確認', ' Y '])('%s also confirms', async (text) => {
    const s = setup();
    await s.send('回覆 T001 已出貨');
    await s.send(text);
    expect(s.enduser.replyTicket).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not_found', 404, '找不到這張工單'],
    ['closed', 409, '這張工單已關閉'],
    ['push_failed', 502, '客戶端推播失敗（客戶可能已封鎖）'],
  ] as const)(
    'send failure %s → adminReplyFailed and nothing pending',
    async (kind, status, msg) => {
      const s = setup();
      await s.send('回覆 T001 已出貨');
      s.enduser.replyTicket.mockRejectedValueOnce(new EnduserClientError(kind, msg, status));
      await s.send('Y');
      expect(s.last()).toEqual({ via: 'reply', text: adminReplyFailed(msg) });
      expect(s.pending()).toBeUndefined();
      expect(JSON.parse(s.queries()[1].tools)).toEqual([
        { name: 'reply_customer', ticketId: 1, result: `failed:${kind}` },
      ]);
      // A second Y is now an ordinary message for the model.
      s.model.calls.length = 0;
    },
  );

  it('a non-Y message cancels the draft, says so, and still goes to the model', async () => {
    const s = setup([endTurn('今天 3 筆')]);
    await s.send('回覆 T001 已出貨');
    await s.send('今天幾筆訂單');
    expect(s.pending()).toBeUndefined();
    expect(s.enduser.replyTicket).not.toHaveBeenCalled();
    expect(s.model.calls).toHaveLength(1);
    expect(s.model.calls[0].params.messages.at(-1)).toEqual({
      role: 'user',
      content: '今天幾筆訂單',
    });
    expect(s.last()).toEqual({ via: 'reply', text: `${texts.adminReplyCancelled}\n今天 3 筆` });
    const q = s.queries()[1];
    expect(JSON.parse(q.tools)).toEqual([
      { name: 'reply_customer', ticketId: 1, result: 'cancelled' },
    ]);
    expect(q.reply).toBe(`${texts.adminReplyCancelled}\n今天 3 筆`);
  });

  it('a non-Y ticket command cancels the draft and runs the command', async () => {
    const s = setup();
    await s.send('回覆 T001 已出貨');
    await s.send('待回覆');
    expect(s.model.calls).toHaveLength(0);
    expect(s.last()).toEqual({
      via: 'reply',
      text: `${texts.adminReplyCancelled}\n${adminTicketList([ticketSummary()])}`,
    });
    expect(s.pending()).toBeUndefined();
    expect(JSON.parse(s.queries()[1].tools)).toEqual([
      { name: 'reply_customer', ticketId: 1, result: 'cancelled' },
      { name: 'list_tickets', result: 'ok', count: 1 },
    ]);
  });

  it('a new 回覆 replaces the old draft (one per admin)', async () => {
    const s = setup();
    await s.send('回覆 T001 已出貨');
    await s.send('回覆 T001 明天到');
    expect(s.pending()?.text).toBe('明天到');
    expect(s.last()?.text).toBe(
      `${texts.adminReplyCancelled}\n${adminReplyConfirm('T001', '明天到')}`,
    );
  });

  it('an expired draft is ignored: Y goes to the model', async () => {
    const s = setup([endTurn('請問要確認什麼？')]);
    await s.send('回覆 T001 已出貨');
    s.advance(600_000);
    await s.send('Y');
    expect(s.enduser.replyTicket).not.toHaveBeenCalled();
    expect(s.model.calls).toHaveLength(1);
    expect(s.last()).toEqual({ via: 'reply', text: '請問要確認什麼？' });
    expect(s.pending()).toBeUndefined();
  });

  it('two admins have independent drafts', async () => {
    const s = setup();
    await s.send('回覆 T001 已出貨', ADMIN);
    await s.send('回覆 T001 老闆回覆', ADMIN2);
    expect(s.pending(ADMIN)?.text).toBe('已出貨');
    expect(s.pending(ADMIN2)?.text).toBe('老闆回覆');
    await s.send('Y', ADMIN2);
    expect(s.enduser.replyTicket).toHaveBeenCalledWith(1, '老闆回覆', ADMIN2);
    expect(s.pending(ADMIN)?.text).toBe('已出貨');
    expect(s.pending(ADMIN2)).toBeUndefined();
  });

  it('non-allowlisted users never touch pending items', async () => {
    const s = setup();
    await s.send('Y', 'Ustranger');
    expect(s.last()).toEqual({ via: 'reply', text: texts.adminOnly });
    expect(s.enduser.replyTicket).not.toHaveBeenCalled();
  });
});

describe('待回覆 / 工單 / 關閉', () => {
  it('待回覆 and 工單列表 list open tickets; empty → adminTicketListEmpty', async () => {
    const s = setup();
    await s.send('待回覆');
    expect(s.enduser.listOpenTickets).toHaveBeenCalledWith(10);
    expect(s.last()).toEqual({
      via: 'reply',
      text: 'T001｜10-30 01:12｜U6037873…｜我的訂單什麼時候出貨',
    });
    s.enduser.listOpenTickets.mockResolvedValueOnce([]);
    await s.send('工單列表');
    expect(s.last()).toEqual({ via: 'reply', text: texts.adminTicketListEmpty });
    expect(s.model.calls).toHaveLength(0);
    expect(JSON.parse(s.queries()[0].tools)).toEqual([
      { name: 'list_tickets', result: 'ok', count: 1 },
    ]);
  });

  it('待回覆 when the enduser bot is down → its userMessage', async () => {
    const s = setup();
    s.enduser.listOpenTickets.mockRejectedValueOnce(
      new EnduserClientError('timeout', '客服端服務逾時'),
    );
    await s.send('待回覆');
    expect(s.last()).toEqual({ via: 'reply', text: '客服端服務逾時' });
  });

  it('工單 T001 shows the detail; unknown → adminTicketNotFound', async () => {
    const s = setup();
    await s.send('工單 T001');
    expect(s.last()).toEqual({ via: 'reply', text: adminTicketDetail(ticketDetail()) });
    expect(s.last()?.text).toContain('T001｜待回覆｜客戶 U6037873…｜10-30 01:12');
    expect(s.last()?.text).toContain('- 昨天訂的');
    await s.send('工單 9');
    expect(s.last()).toEqual({ via: 'reply', text: texts.adminTicketNotFound });
    expect(JSON.parse(s.queries()[1].tools)).toEqual([
      { name: 'get_ticket', ticketId: 9, result: 'failed:not_found' },
    ]);
  });

  it('關閉 T001 closes via the enduser bot', async () => {
    const s = setup();
    await s.send('關閉 T001');
    expect(s.enduser.closeTicket).toHaveBeenCalledWith(1);
    expect(s.last()).toEqual({ via: 'reply', text: adminTicketClosedDone('T001') });
    s.enduser.closeTicket.mockRejectedValueOnce(
      new EnduserClientError('not_found', '找不到這張工單', 404),
    );
    await s.send('關閉 T009');
    expect(s.last()).toEqual({ via: 'reply', text: texts.adminTicketNotFound });
    expect(JSON.parse(s.queries()[0].tools)).toEqual([
      { name: 'close_ticket', ticketId: 1, result: 'closed' },
    ]);
  });

  it('look-alike messages still go to the model', async () => {
    const s = setup([endTurn('a'), endTurn('b')]);
    await s.send('工單 T001 的客人是誰');
    await s.send('回覆率怎麼樣');
    expect(s.model.calls).toHaveLength(2);
    expect(s.enduser.getTicket).not.toHaveBeenCalled();
  });
});

describe('reply_customer tool', () => {
  it('stages the draft and the final reply carries the confirm text', async () => {
    const s = setup([
      toolTurn(toolUse('tu1', 'reply_customer', { ticket_id: 1, text: ' 已出貨 ' })),
      endTurn('已準備好回覆，回 Y 送出。'),
    ]);
    await s.send('跟 T001 的客戶說已出貨');
    const result = s.model.calls[1].params.messages.at(-1);
    expect(result).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: JSON.stringify({ staged: true, display: 'T001', text: '已出貨' }),
        },
      ],
    });
    expect(s.pending()).toMatchObject({ ticket_id: 1, text: '已出貨' });
    expect(s.last()).toEqual({ via: 'reply', text: `已準備好回覆，回 Y 送出。\n${CONFIRM}` });
    expect(s.enduser.replyTicket).not.toHaveBeenCalled();
    const q = s.queries()[0];
    expect(JSON.parse(q.tools)).toEqual([
      expect.objectContaining({ name: 'reply_customer', ticketId: 1, ok: true }),
    ]);
    expect(q.reply).toBe(`已準備好回覆，回 Y 送出。\n${CONFIRM}`);

    await s.send('Y');
    expect(s.enduser.replyTicket).toHaveBeenCalledWith(1, '已出貨', ADMIN);
  });

  it('unknown / closed ticket or over-long text is an is_error result, nothing staged', async () => {
    const s = setup([
      toolTurn(
        toolUse('tu1', 'reply_customer', { ticket_id: 42, text: 'x' }),
        toolUse('tu2', 'reply_customer', { ticket_id: 1, text: 'x'.repeat(1001) }),
      ),
      endTurn('找不到工單'),
    ]);
    await s.send('跟 T042 說 x');
    const results = s.model.calls[1].params.messages.at(-1)?.content as { is_error?: boolean }[];
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(s.pending()).toBeUndefined();
    expect(s.last()).toEqual({ via: 'reply', text: '找不到工單' });
  });

  it('the tool is advertised to the model', async () => {
    const s = setup([endTurn('ok')]);
    await s.send('hi');
    const names = s.model.calls[0].params.tools?.map((t) => (t as { name: string }).name);
    expect(names).toContain('reply_customer');
    expect(s.model.calls[0].params.system).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('reply_customer') }),
      ]),
    );
  });
});

describe('texts', () => {
  it('adminTicketList caps at 10 lines and 40-char previews', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      ticketSummary({
        id: i + 1,
        display: `T${String(i + 1).padStart(3, '0')}`,
        question: '問'.repeat(50),
      }),
    );
    const out = adminTicketList(rows).split('\n');
    expect(out).toHaveLength(11);
    expect(out[0]).toBe(`T001｜10-30 01:12｜U6037873…｜${'問'.repeat(40)}…`);
    expect(out[10]).toBe('還有 2 張');
  });

  it('adminTicketDetail includes orders, answer and truncates a 1500+ question', () => {
    const out = adminTicketDetail(
      ticketDetail({
        status: 'answered',
        question: 'q'.repeat(1600),
        answer: '已出貨',
        answeredBy: 'Uadmin',
      }),
    );
    expect(out).toContain('T001｜已回覆｜客戶 U6037873…');
    expect(out).toContain('訂單：#20261029-VXJG7AZY');
    expect(out).toContain(`問：${'q'.repeat(1500)}${texts.adminTruncated}`);
    expect(out).toContain('已回覆（Uadmin）：已出貨');
    expect(out).toContain('回覆方式：回覆 T001 <內容>');
  });
});

describe('vi sanity', () => {
  it('fakes are fresh per setup', () => {
    const a = setup();
    const b = setup();
    expect(a.enduser.getTicket).not.toBe(b.enduser.getTicket);
    expect(vi.isMockFunction(a.enduser.getTicket)).toBe(true);
  });
});

describe('loose 待回覆 quick command (≤16 chars)', () => {
  it.each([
    '目前有客戶待回覆訊息嗎？',
    '待回覆工單',
    '有待回覆的工單嗎',
    '工單清單',
    '現在有工單嗎',
  ])('%s hits the intercept without the model', async (msg) => {
    const s = setup();
    await s.send(msg);
    expect(s.model.calls).toHaveLength(0);
    expect(s.enduser.listOpenTickets).toHaveBeenCalledWith(10);
    expect(s.last()).toEqual({ via: 'reply', text: adminTicketList([ticketSummary()]) });
  });

  it('a longer sentence with 待回覆 goes to the model, which uses list_tickets', async () => {
    const msg = '麻煩幫我看一下今天下午到現在為止還有哪些客戶的待回覆訊息沒處理好';
    expect(msg.length).toBeGreaterThan(16);
    const s = setup([
      toolTurn(toolUse('tu1', 'list_tickets', { limit: null })),
      endTurn('目前 1 張待回覆：T001｜10-30 01:12｜我的訂單什麼時候出貨'),
    ]);
    await s.send(msg);
    expect(s.model.calls).toHaveLength(2);
    const result = s.model.calls[1].params.messages.at(-1)?.content as { content: string }[];
    expect(JSON.parse(result[0].content)).toMatchObject({
      count: 1,
      tickets: [expect.objectContaining({ display: 'T001' })],
    });
    expect(s.last()?.text).toContain('T001');
    expect(JSON.parse(s.queries()[0].tools)).toEqual([
      expect.objectContaining({ name: 'list_tickets', ok: true }),
    ]);
  });
});
