import Anthropic from '@anthropic-ai/sdk';
import type { webhook } from '@line/bot-sdk';
import { describe, expect, it, vi } from 'vitest';
import { GROUP_PROMPT } from '../../src/admin/prompt.js';
import { GROUP_TOOL_DEFS } from '../../src/admin/tools.js';
import { createAdminTextHandler } from '../../src/handlers/admin.js';
import type { GroupTextContext } from '../../src/handlers/dispatcher.js';
import {
  createGroupHandler,
  parseBugCommand,
  stripSelfMentions,
} from '../../src/handlers/group.js';
import { texts } from '../../src/texts.js';
import {
  deferred,
  endTurn,
  fakeEnduser,
  fakeEshop,
  fakeModel,
  LIST_ORDERS_INPUT,
  message,
  toolTurn,
  toolUse,
  type ScriptItem,
} from '../admin/fakes.js';
import {
  fakeHealth,
  harness,
  healthResult,
  inbound,
  jobRows,
  pushReasons,
  sentTexts,
  silent,
} from './helpers.js';

const OWNER = 'Uowner000001';
const OTHER = 'Uother000002';
const GROUP = 'Cgroup0001';
const GROUP2 = 'Cgroup0002';
const MODEL = 'claude-opus-5-5';
const T0 = new Date('2026-11-02T08:00:00.000Z');

const self = (index: number, length: number): webhook.UserMentionee => ({
  type: 'user',
  index,
  length,
  isSelf: true,
  userId: 'Ubot',
});
const other = (index: number, length: number): webhook.UserMentionee => ({
  type: 'user',
  index,
  length,
  userId: 'Usomeone',
});

const CONFIG = {
  ADMIN_MODEL: MODEL,
  ADMIN_MAX_TOOL_ROUNDS: 4,
  REPLY_DEADLINE_MS: 5000,
  CONTEXT_MESSAGES: 6,
  CONFIRMATION_TTL_MS: 600_000,
};

function setup(
  opts: {
    allow?: string[];
    clock?: { t: Date };
    script?: ScriptItem[];
    deadlineMs?: number;
  } = {},
) {
  const h = harness();
  const clock = opts.clock ?? { t: T0 };
  const health = fakeHealth(healthResult({ status: 'healthy' }));
  const model = fakeModel(opts.script ?? []);
  const eshop = fakeEshop();
  const enduser = fakeEnduser();
  const config = {
    ...CONFIG,
    GROUP_COMMAND_USER_IDS: opts.allow ?? [OWNER],
    REPLY_DEADLINE_MS: opts.deadlineMs ?? CONFIG.REPLY_DEADLINE_MS,
  };
  const handle = createGroupHandler({
    repos: h.repos,
    replier: h.replier,
    health,
    jobs: h.jobs,
    grok: { configured: true },
    eshop,
    enduser,
    model: model.client,
    config,
    now: () => clock.t,
    log: silent,
  });
  let n = 0;
  const ctx = (
    text: string,
    mentionees: webhook.Mentionee[],
    userId: string | null = OWNER,
    groupId = GROUP,
  ): GroupTextContext => {
    n += 1;
    return {
      groupId,
      sourceType: 'group',
      userId: userId ?? undefined,
      text,
      mentionees,
      replyToken: `tok-${n}`,
      event: {} as webhook.MessageEvent,
    };
  };
  /** `@bot <text>` with the self mention at 0..4. */
  const tag = (text: string, groupId = GROUP) => ctx(`@bot ${text}`, [self(0, 4)], OWNER, groupId);
  const bugRows = () =>
    h.db.prepare('SELECT * FROM bug_reports ORDER BY id').all() as {
      id: number;
      reporter_user_id: string;
      group_id: string;
      description: string;
      health_raw: string;
      status: string;
      created_at: string;
    }[];
  const queries = () =>
    h.db.prepare('SELECT * FROM admin_queries ORDER BY id').all() as {
      user_id: string;
      text: string;
      tools: string;
      reply: string;
      pii_revealed: number;
    }[];
  const groupContext = (groupId = GROUP) =>
    h.repos.groupContext.recent(groupId, 100).map((r) => [r.direction, r.text]);
  return {
    ...h,
    health,
    model,
    eshop,
    enduser,
    config,
    handle,
    ctx,
    tag,
    bugRows,
    queries,
    groupContext,
    clock,
  };
}

describe('stripSelfMentions', () => {
  it('removes only isSelf spans by index / length and trims', () => {
    const text = '@小幫手 @Amy 結帳頁 @小幫手 壞了';
    // '@小幫手' = 4 code units at 0 and 14; '@Amy' at 5.
    expect(stripSelfMentions(text, [self(0, 4), other(5, 4), self(14, 4)])).toBe(
      '@Amy 結帳頁  壞了',
    );
    expect(stripSelfMentions('@bot', [self(0, 4)])).toBe('');
    expect(stripSelfMentions('壞了 @bot', [self(3, 4)])).toBe('壞了');
  });

  it('clamps out-of-range spans', () => {
    expect(stripSelfMentions('abc @bot', [self(4, 99)])).toBe('abc');
  });
});

describe('parseBugCommand', () => {
  it('accepts half / full-width slash, any case, with or without a space', () => {
    expect(parseBugCommand('/bug 結帳頁壞了')).toBe('結帳頁壞了');
    expect(parseBugCommand('／bug 結帳頁壞了')).toBe('結帳頁壞了');
    expect(parseBugCommand('/BUG結帳頁壞了')).toBe('結帳頁壞了');
    expect(parseBugCommand('／Bug\n  首頁破圖  ')).toBe('首頁破圖');
    expect(parseBugCommand('/bug')).toBe('');
    expect(parseBugCommand('/bug   ')).toBe('');
  });

  it('is not a command unless /bug is at the start', () => {
    expect(parseBugCommand('這是 /bug')).toBeNull();
    expect(parseBugCommand('/bugfix 結帳')).toBeNull();
    expect(parseBugCommand('今天的訂單')).toBeNull();
    expect(parseBugCommand('bug 結帳頁')).toBeNull();
  });
});

describe('group gate (unchanged from §13)', () => {
  it('a tag from a non-allowlisted sender (or without userId) sends nothing', async () => {
    const s = setup();
    await s.handle(s.ctx('@bot /bug 網站壞了', [self(0, 4)], OTHER));
    await s.handle(s.ctx('@bot 今天的訂單', [self(0, 4)], OTHER));
    await s.handle(s.ctx('@bot 今天的訂單', [self(0, 4)], null));
    expect(sentTexts(s.api)).toEqual([]);
    expect(s.bugRows()).toHaveLength(0);
    expect(s.model.calls).toHaveLength(0);
    expect(s.queries()).toHaveLength(0);
    expect(s.health.check).not.toHaveBeenCalled();
  });

  it('an allowlisted sender without tagging the bot (or tagging someone else) sends nothing', async () => {
    const s = setup();
    await s.handle(s.ctx('今天的訂單', []));
    await s.handle(s.ctx('@Amy /bug 網站壞了', [other(0, 4)]));
    expect(sentTexts(s.api)).toEqual([]);
    expect(s.bugRows()).toHaveLength(0);
    expect(s.model.calls).toHaveLength(0);
  });

  it('is off when GROUP_COMMAND_USER_IDS is empty', async () => {
    const s = setup({ allow: [] });
    await s.handle(s.tag('/bug 網站壞了'));
    await s.handle(s.tag('今天的訂單'));
    expect(sentTexts(s.api)).toEqual([]);
    expect(s.bugRows()).toHaveLength(0);
    expect(s.model.calls).toHaveLength(0);
  });

  it('an empty tag replies groupHelp without calling the model, and is audited', async () => {
    const s = setup();
    await s.handle(s.ctx('  @bot  ', [self(2, 4)]));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.groupHelp }]);
    expect(texts.groupHelp).toBe(
      '請在 tag 後輸入要查的資料，例如：@bot 今天的訂單；回報網站問題請用 /bug，例如：@bot /bug 結帳頁按 LINE Pay 沒反應',
    );
    expect(s.model.calls).toHaveLength(0);
    expect(s.bugRows()).toHaveLength(0);
    expect(s.groupContext()).toEqual([]);
    expect(s.queries()).toHaveLength(1);
    expect(s.queries()[0]).toMatchObject({ user_id: OWNER, reply: texts.groupHelp });
  });
});

describe('/bug command', () => {
  it('bug row, bug_report job, accepted reply in the group, audit row, no model call', async () => {
    const s = setup();
    await s.handle(s.tag('/bug 結帳頁按 LINE Pay 沒反應'));

    const rows = s.bugRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      reporter_user_id: OWNER,
      group_id: GROUP,
      description: '結帳頁按 LINE Pay 沒反應',
      status: 'queued',
      created_at: T0.toISOString(),
    });
    expect(JSON.parse(rows[0]!.health_raw)).toMatchObject({ status: 'healthy' });
    expect(s.health.check).toHaveBeenCalledTimes(1);

    expect(jobRows(s.db)).toEqual([
      {
        type: 'bug_report',
        status: 'pending',
        payload: {
          bugId: 1,
          reporterUserId: OWNER,
          description: '結帳頁按 LINE Pay 沒反應',
          health: expect.objectContaining({ status: 'healthy' }),
        },
      },
    ]);
    expect(s.api.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok-1',
      messages: [{ type: 'text', text: texts.groupBugAccepted('B001') }],
    });
    expect(texts.groupBugAccepted('B001')).toBe('已轉給 Grok 處理，異常單號 B001');
    expect(s.api.pushMessage).not.toHaveBeenCalled();
    expect(s.model.calls).toHaveLength(0);
    expect(s.groupContext()).toEqual([]);

    const audit = s.queries();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: OWNER, pii_revealed: 0 });
    expect(JSON.parse(audit[0]!.tools)).toEqual([
      { name: 'bug_report', bugId: 1, result: 'queued' },
    ]);
  });

  it('full-width slash, upper case and no space all store the text after /bug', async () => {
    const s = setup();
    await s.handle(s.tag('／bug 首頁破圖'));
    await s.handle(s.tag('/BUG結帳頁…'));
    await s.handle(s.tag('/Bug   會員頁 500  '));
    expect(s.bugRows().map((r) => r.description)).toEqual(['首頁破圖', '結帳頁…', '會員頁 500']);
    expect(s.model.calls).toHaveLength(0);
  });

  it('/bug without a description replies groupBugHelp and opens nothing', async () => {
    const s = setup();
    await s.handle(s.tag('/bug'));
    await s.handle(s.tag('／BUG   '));
    expect(sentTexts(s.api)).toEqual([
      { via: 'reply', text: texts.groupBugHelp },
      { via: 'reply', text: texts.groupBugHelp },
    ]);
    expect(texts.groupBugHelp).toBe(
      '請在 /bug 後描述網站問題，例如：@bot /bug 結帳頁按 LINE Pay 沒反應',
    );
    expect(s.bugRows()).toHaveLength(0);
    expect(jobRows(s.db)).toHaveLength(0);
    expect(s.model.calls).toHaveLength(0);
  });

  it('strips multiple self mentions but keeps other mentionees', async () => {
    const s = setup();
    await s.handle(
      s.ctx('@bot /bug @Amy 首頁 @bot 圖片破圖', [self(0, 4), other(10, 4), self(18, 4)]),
    );
    expect(s.bugRows()[0]!.description).toBe('@Amy 首頁  圖片破圖');
  });

  it('dedupes the same reporter + description within 60 s', async () => {
    const s = setup();
    await s.handle(s.tag('/bug 購物車清空'));
    s.clock.t = new Date(T0.getTime() + 59_000);
    await s.handle(s.tag('/bug   購物車清空'));
    expect(s.bugRows()).toHaveLength(1);
    expect(jobRows(s.db)).toHaveLength(1);
    expect(sentTexts(s.api)).toEqual([
      { via: 'reply', text: texts.groupBugAccepted('B001') },
      { via: 'reply', text: texts.groupBugDuplicate('B001') },
    ]);

    await s.handle(s.tag('/bug 會員頁 500'));
    s.clock.t = new Date(T0.getTime() + 61_000);
    await s.handle(s.tag('/bug 購物車清空'));
    expect(s.bugRows().map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('falls back to a push to the group when there is no reply token', async () => {
    const s = setup();
    await s.handle({ ...s.tag('/bug 網站壞了'), replyToken: undefined });
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([GROUP]);
    expect(pushReasons(s.db)).toEqual(['group_bug_accepted']);
  });

  it('never rejects when LINE fails; the report stays queued', async () => {
    const s = setup();
    s.api.replyMessage.mockRejectedValue(new Error('boom'));
    s.api.pushMessage.mockRejectedValue(new Error('boom'));
    await expect(s.handle(s.tag('/bug 網站壞了'))).resolves.toBeUndefined();
    expect(s.bugRows()).toHaveLength(1);
  });

  it('a handler failure replies the internal-group error text', async () => {
    const s = setup();
    s.health.check.mockRejectedValueOnce(new Error('boom'));
    await s.handle(s.ctx('@小幫手 /bug 結帳頁壞了', [self(0, 4)]));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.groupBugError }]);
    expect(texts.groupBugError).toBe('處理失敗，請稍後再 tag 一次。');
    expect(s.bugRows()).toHaveLength(0);
  });

  it('/bug not at the start is a query for the model', async () => {
    const s = setup({ script: [endTurn('要回報網站問題請用 /bug')] });
    await s.handle(s.tag('這是 /bug 嗎，結帳頁壞了'));
    expect(s.bugRows()).toHaveLength(0);
    expect(s.model.calls).toHaveLength(1);
    expect(s.model.calls[0]!.params.messages).toEqual([
      { role: 'user', content: '這是 /bug 嗎，結帳頁壞了' },
    ]);
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: '要回報網站問題請用 /bug' }]);
  });
});

describe('group query', () => {
  it('runs the read-only loop with the group prompt and replies into the group', async () => {
    const s = setup({
      script: [toolTurn(toolUse('tu1', 'list_orders', LIST_ORDERS_INPUT)), endTurn('今天 3 筆')],
    });
    await s.handle(s.tag('今天的訂單'));

    expect(s.model.calls).toHaveLength(2);
    const first = s.model.calls[0]!.params;
    expect(first.model).toBe(MODEL);
    expect(first.output_config?.effort).toBe('medium');
    expect(first.fallbacks).toBe('default');
    expect(first.tools).toEqual(GROUP_TOOL_DEFS);
    expect((first.tools ?? []).map((t) => (t as { name: string }).name).sort()).toEqual(
      [
        'get_order',
        'get_ticket',
        'health',
        'list_orders',
        'list_products',
        'list_tickets',
        'low_stock',
        'revenue',
        'stats',
      ].sort(),
    );
    const system = first.system as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(3);
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]).toEqual({ type: 'text', text: GROUP_PROMPT });
    expect(system[2]!.text).toContain('日期錨點');
    expect(first.messages).toEqual([{ role: 'user', content: '今天的訂單' }]);

    expect(s.api.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok-1',
      messages: [{ type: 'text', text: '今天 3 筆' }],
    });
    expect(s.api.pushMessage).not.toHaveBeenCalled();
    expect(s.api.showLoadingAnimation).not.toHaveBeenCalled();

    const rows = s.queries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: OWNER,
      text: '@bot 今天的訂單',
      reply: '今天 3 筆',
      pii_revealed: 0,
    });
    expect(JSON.parse(rows[0]!.tools)[0]).toMatchObject({ name: 'list_orders', ok: true });
    expect(s.groupContext()).toEqual([
      ['in', '今天的訂單'],
      ['out', '今天 3 筆'],
    ]);
  });

  it('refuses reply_customer and report_issue even if the model calls them', async () => {
    const s = setup({
      script: [
        toolTurn(
          toolUse('a', 'reply_customer', { ticket_id: 1, text: '已出貨' }),
          toolUse('b', 'report_issue', { description: '結帳壞了', relatedOrderIds: [] }),
        ),
        endTurn('這項操作請私訊管理端 bot 處理'),
      ],
    });
    await s.handle(s.tag('跟 T001 的客戶說已出貨'));

    const last = s.model.calls[1]!.params.messages.at(-1) as {
      content: { tool_use_id: string; is_error?: boolean; content: string }[];
    };
    expect(last.content.map((c) => [c.tool_use_id, c.is_error])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(last.content[0]!.content).toContain('群組內不提供');
    expect(s.enduser.getTicket).not.toHaveBeenCalled();
    expect(s.repos.pendingConfirmations.get(OWNER, T0)).toBeNull();
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()).toEqual({ n: 0 });
    expect(jobRows(s.db)).toHaveLength(0);
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: '這項操作請私訊管理端 bot 處理' }]);
  });

  it('DM shortcut texts go to the model, never to the shortcut handlers', async () => {
    const inputs = ['待回覆', '工單 T001', '關閉 T001', '回覆 T001 已出貨', 'Y'];
    const s = setup({ script: inputs.map((i) => endTurn(`模型回答：${i}`)) });
    for (const i of inputs) await s.handle(s.tag(i));
    expect(s.model.calls).toHaveLength(inputs.length);
    expect(s.model.calls.map((c) => c.params.messages.at(-1))).toEqual(
      inputs.map((i) => ({ role: 'user', content: i })),
    );
    expect(s.enduser.listOpenTickets).not.toHaveBeenCalled();
    expect(s.enduser.getTicket).not.toHaveBeenCalled();
    expect(s.enduser.closeTicket).not.toHaveBeenCalled();
    expect(s.enduser.replyTicket).not.toHaveBeenCalled();
    expect(s.repos.pendingConfirmations.get(OWNER, T0)).toBeNull();
    expect(sentTexts(s.api).map((t) => t.text)).toEqual(inputs.map((i) => `模型回答：${i}`));
  });

  it('follow-ups see this group’s previous queries only (no /bug, no DM, no other group)', async () => {
    const s = setup({
      script: [endTurn('今天 2 筆'), endTurn('DM 回答'), endTurn('第二筆是 #2'), endTurn('別群')],
    });
    // DM history of the same sender.
    const dm = createAdminTextHandler({
      repos: s.repos,
      replier: s.replier,
      health: s.health,
      jobs: s.jobs,
      grok: { configured: true },
      eshop: s.eshop,
      enduser: s.enduser,
      model: s.model.client,
      config: { ...CONFIG, ADMIN_USER_IDS: [OWNER] },
      log: silent,
    });

    await s.handle(s.tag('今天的訂單'));
    await s.handle(s.tag('/bug 首頁破圖'));
    await dm(inbound(s.repos, '私訊問題', { userId: OWNER }));
    await s.handle(s.tag('那第二筆呢'));
    await s.handle(s.tag('別群的問題', GROUP2));

    const [, dmCall, followUp, otherGroup] = s.model.calls;
    expect(dmCall!.params.messages).toEqual([{ role: 'user', content: '私訊問題' }]);
    expect(followUp!.params.messages).toEqual([
      { role: 'user', content: '今天的訂單' },
      { role: 'assistant', content: '今天 2 筆' },
      { role: 'user', content: '那第二筆呢' },
    ]);
    expect(otherGroup!.params.messages).toEqual([{ role: 'user', content: '別群的問題' }]);
    expect(s.groupContext()).toEqual([
      ['in', '今天的訂單'],
      ['out', '今天 2 筆'],
      ['in', '那第二筆呢'],
      ['out', '第二筆是 #2'],
    ]);
  });

  it('keeps only the last CONTEXT_MESSAGES rows', async () => {
    const s = setup({ script: [1, 2, 3, 4, 5].map((i) => endTurn(`答${i}`)) });
    for (const i of [1, 2, 3, 4, 5]) await s.handle(s.tag(`問${i}`));
    // CONTEXT_MESSAGES = 6: 問5 sees 問2..答4, the first exchange has dropped out.
    expect(s.model.calls[4]!.params.messages).toEqual([
      { role: 'user', content: '問2' },
      { role: 'assistant', content: '答2' },
      { role: 'user', content: '問3' },
      { role: 'assistant', content: '答3' },
      { role: 'user', content: '問4' },
      { role: 'assistant', content: '答4' },
      { role: 'user', content: '問5' },
    ]);
    expect(s.groupContext()).toHaveLength(10);
  });

  it('deadline: acks in the group, then pushes the answer to the group', async () => {
    const gate = deferred<ReturnType<typeof message>>();
    const s = setup({ script: [() => gate.promise], deadlineMs: 20 });
    const done = s.handle(s.tag('慢查詢'));
    await vi.waitFor(() => expect(s.api.replyMessage).toHaveBeenCalledTimes(1));
    expect(s.api.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok-1',
      messages: [{ type: 'text', text: texts.adminAckPending }],
    });
    gate.resolve(message(endTurn('答案來了')));
    await done;
    expect(sentTexts(s.api)).toEqual([
      { via: 'reply', text: texts.adminAckPending },
      { via: 'push', text: '答案來了' },
    ]);
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([GROUP]);
    expect(pushReasons(s.db)).toEqual(['group_late_reply']);
    expect(s.queries()[0]!.reply).toBe('答案來了');
    expect(s.groupContext()).toEqual([
      ['in', '慢查詢'],
      ['out', '答案來了'],
    ]);
  });

  it('explicit PII ask: full data reaches the group, only placeholders are stored', async () => {
    const id = '#20261029-ABCDEF12';
    const s = setup({
      script: [
        toolTurn(toolUse('a', 'get_order', { orderId: id, reveal_pii: true })),
        endTurn('（含完整個資）電話 0912345678'),
      ],
    });
    await s.handle(s.tag(`給我 ${id} 的完整電話`));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: '（含完整個資）電話 0912345678' }]);
    const row = s.queries()[0]!;
    expect(row.pii_revealed).toBe(1);
    expect(row.reply).toBe(texts.adminPiiRecordPlaceholder);
    expect(s.groupContext().at(-1)).toEqual(['out', texts.adminPiiRecordPlaceholder]);
    const outs = (
      s.db.prepare("SELECT text FROM messages WHERE direction = 'out'").all() as { text: string }[]
    ).map((r) => r.text);
    expect(outs).toEqual([texts.adminPiiRecordPlaceholder]);
  });

  it('without an explicit ask reveal_pii stays masked', async () => {
    const id = '#20261029-ABCDEF12';
    const s = setup({
      script: [
        toolTurn(toolUse('a', 'get_order', { orderId: id, reveal_pii: true })),
        endTurn('電話 0912****78'),
      ],
    });
    await s.handle(s.tag(`${id} 狀態`));
    const result = (s.model.calls[1]!.params.messages.at(-1) as { content: { content: string }[] })
      .content[0]!.content;
    expect(result).not.toContain('0912345678');
    expect(s.queries()[0]!.pii_revealed).toBe(0);
  });

  it('model failure replies the loop’s own error text', async () => {
    const s = setup({ script: [new Anthropic.APIConnectionError({ message: 'x' })] });
    await s.handle(s.tag('今天的訂單'));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.adminModelUnavailable }]);
    expect(s.queries()).toHaveLength(1);
    expect(s.queries()[0]!.reply).toBe(texts.adminModelUnavailable);
  });

  it('a LINE failure on the answer never rejects and falls back to groupBugError via push', async () => {
    const s = setup({ script: [endTurn('答案')] });
    s.api.replyMessage.mockRejectedValue(new Error('boom'));
    await expect(s.handle(s.tag('今天的訂單'))).resolves.toBeUndefined();
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([GROUP]);
    expect(sentTexts(s.api).at(-1)).toEqual({ via: 'push', text: texts.groupBugError });
  });
});
