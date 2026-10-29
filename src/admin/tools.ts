import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ContextMessage } from '../classifier/types.js';
import type { Repos } from '../db/repos.js';
import {
  describeOrder,
  EshopError,
  formatNtd,
  maskOrder,
  orderStatuses,
  orderTypes,
  paymentMethods,
  paymentStatuses,
  summariseOrder,
  type EshopClient,
  type ListOrdersParams,
  type MaskedOrder,
  type Product,
} from '../eshop/index.js';
import type { GrokGateway } from '../grok/gateway.js';
import { healthRaw } from '../handlers/incident.js';
import type { HealthChecker } from '../health/check.js';
import type { JobQueue } from '../jobs/queue.js';
import { logger } from '../logger.js';
import { EnduserClientError, type EnduserClient } from './enduserClient.js';

/** ADMIN-HANDLER-DESIGN §3–§4: strict tool definitions and their read-only executors. */

export const MAX_CALLS_PER_ROUND = 6;
export const MAX_RESULT_CHARS = 8000;
const MAX_ROWS = 20;
const MAX_PRODUCT_ROWS = 50;
const MAX_RELATED_ORDERS = 5;
const MAX_GROK_TEXT = 4000;
const MAX_ORDER_DETAIL = 800;

/** Only an explicit ask in *this* message unlocks unmasked data (never the context). */
export const PII_REQUEST = /電話|手機|地址|住址|e-?mail|信箱|聯絡方式|聯絡資料|完整/i;

// ---- schemas (strict compatible: strictObject, every field required, nullable for optional) ---

const nstr = (d: string) => z.string().nullable().describe(d);
const reveal = z
  .boolean()
  .describe('只有使用者這則訊息明確要求完整電話、地址、email 或聯絡方式時才為 true，否則 false');

export const listOrdersInput = z.strictObject({
  status: z.enum(orderStatuses).nullable().describe('訂單狀態；不限定為 null'),
  paymentStatus: z.enum(paymentStatuses).nullable().describe('付款狀態；「未付款」為 pending'),
  paymentMethod: z.enum(paymentMethods).nullable().describe('付款方式；不限定為 null'),
  orderType: z.enum(orderTypes).nullable().describe('訂單類型；不限定為 null'),
  dateFrom: nstr('成立時間下限（含），ISO 8601 含 +08:00，例 2026-10-30T00:00:00+08:00'),
  dateTo: nstr('成立時間上限（含），例 2026-10-30T23:59:59+08:00'),
  q: nstr('關鍵字：訂單編號、客人姓名、IG、email、經銷店名；不限定為 null'),
  page: z.number().nullable().describe('頁碼，從 1 開始；null 為 1'),
  limit: z.number().nullable().describe('每頁筆數 1 到 20；只要數量時用 1；null 為 10'),
  reveal_pii: reveal,
});
export const getOrderInput = z.strictObject({
  orderId: z.string().describe('訂單編號，可含或不含 #'),
  reveal_pii: reveal,
});
export const listProductsInput = z.strictObject({
  query: nstr('商品名稱關鍵字（子字串、不分大小寫）；全部商品為 null'),
  activeOnly: z.boolean().nullable().describe('只看上架商品；null 視為 true'),
});
export const emptyInput = z.strictObject({});
export const reportIssueInput = z.strictObject({
  description: z.string().describe('問題摘要：現象、影響範圍、發生時間，繁中 1 到 3 句'),
  relatedOrderIds: z.array(z.string()).describe('相關訂單編號，最多 5 筆；沒有為空陣列'),
});
export const replyCustomerInput = z.strictObject({
  ticket_id: z
    .number()
    .describe('工單編號的數字部分，T042 就是 42；只能用管理員提供或工單通知裡出現的編號'),
  text: z.string().describe('要送給客戶的純文字內容，繁中，最多 1000 字'),
});

/** Max customer reply length (mirrors `/internal/reply`). */
export const MAX_REPLY_TEXT = 1000;

function toolDef(name: string, description: string, schema: z.ZodObject): Anthropic.Beta.BetaTool {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  void _drop;
  return {
    name,
    description,
    strict: true,
    input_schema: {
      ...json,
      type: 'object',
      required: (json.required as string[] | undefined) ?? [],
    },
  };
}

export const ADMIN_TOOL_DEFS: readonly Anthropic.Beta.BetaTool[] = [
  toolDef(
    'list_orders',
    '查詢訂單列表或計數。使用者問幾筆、哪些訂單、未付款或已付款、某段時間或某位客人的訂單時呼叫。回傳 total（符合條件總筆數）、page、pages 與最多 20 行摘要：編號｜台北時間｜狀態｜付款方式/付款狀態｜金額｜客人。只要數量時 limit 設 1 並讀 total。',
    listOrdersInput,
  ),
  toolDef(
    'get_order',
    '查單筆訂單明細（品項、金額、付款、配送、客人）。使用者給了訂單編號，或要確認某筆訂單細節時呼叫。查無此單時 found 為 false。',
    getOrderInput,
  ),
  toolDef(
    'list_products',
    '查商品與規格庫存。使用者問特定商品還有多少、有沒有上架、全部商品庫存時呼叫。回傳最多 50 行：名稱｜庫存｜警戒值｜上架狀態｜各規格庫存。',
    listProductsInput,
  ),
  toolDef(
    'low_stock',
    '查低庫存清單（含加價購）。使用者問哪些快沒貨、低庫存、要補貨時呼叫。',
    emptyInput,
  ),
  toolDef(
    'stats',
    '查後台統計：今日訂單數與營收、本月營收、待出貨（status=paid 的訂單數）、低庫存數、會員與經銷商數、進行中團購與優惠券、各訂單狀態數。今日與本月以台北時區計算，營收只算已付款且未取消的訂單。問今天或本月營收、整體概況、系統是否正常時呼叫。沒有任意區間。',
    emptyInput,
  ),
  toolDef(
    'health',
    '網站健康檢查。問網站或系統是否正常、是不是掛了時呼叫。status：healthy 正常、degraded 異常、down 無法連線。',
    emptyInput,
  ),
  toolDef(
    'report_issue',
    '把功能異常轉給技術分析（非同步，結果稍後推播給管理員）。只有在使用者描述具體功能異常或客人回報的問題時呼叫，且先用其他工具查過相關訂單；單純問系統是否正常時不要呼叫。每次對話最多一次。',
    reportIssueInput,
  ),
  toolDef(
    'reply_customer',
    '替管理員準備一則要送給工單客戶的回覆；不會直接送出，會先請管理員確認（回 Y 才送出）。管理員說「跟 T042 的客戶說…」「回覆 T042 …」時呼叫；工單編號必須來自管理員或工單通知，不要自己猜。',
    replyCustomerInput,
  ),
];

// ---- executor ------------------------------------------------------------------------------

export interface ToolCallRecord {
  name: string;
  /** The model's raw input. */
  input: unknown;
  ok: boolean;
  ms: number;
  error?: string;
  piiRevealed?: boolean;
  /** `reveal_pii` after the PII gate (only for tools that have it). */
  revealHonoured?: boolean;
  taskId?: number;
  ticketId?: number;
}

/** A customer reply staged by `reply_customer`, awaiting the admin's `Y`. */
export interface StagedReply {
  ticketId: number;
  display: string;
  text: string;
}

export interface ToolExecutorDeps {
  eshop: EshopClient;
  health: HealthChecker;
  repos: Pick<Repos, 'incidents' | 'pendingConfirmations'>;
  jobs: Pick<JobQueue, 'enqueue'>;
  grok: Pick<GrokGateway, 'configured'>;
  /** T16: ticket reads go to the enduser bot. */
  enduser: Pick<EnduserClient, 'getTicket'>;
  /** `CONFIRMATION_TTL_MS`. */
  confirmationTtlMs: number;
  userId: string;
  /** This message only; drives the PII gate. */
  userText: string;
  messageId: number;
  /** Masked context, forwarded to `incident_triage`. */
  context: ContextMessage[];
  now?: () => Date;
  log?: Logger;
}

export interface ToolExecutor {
  /**
   * Runs every tool_use of one response in parallel and returns the results in the same order.
   * Throws the first `EshopError` (by tool_use order) or the first unexpected error *after*
   * all calls settled; validation failures and known tool errors come back as `is_error` results.
   */
  runRound(
    calls: Anthropic.Beta.BetaToolUseBlock[],
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam[]>;
  readonly records: ToolCallRecord[];
  /** True once unmasked data was actually returned to the model. */
  readonly piiRevealed: boolean;
  /** The last reply staged by `reply_customer` during this run, if any. */
  readonly staged: StagedReply | null;
}

const isoWithOffset = z.iso.datetime({ offset: true });

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function customerBits(m: MaskedOrder): string {
  const bits: string[] = [];
  const c = m.customer;
  if (c?.name) bits.push(c.name);
  if (c?.instagram) bits.push(`IG ${c.instagram}`);
  if (c?.phone) bits.push(c.phone);
  if (!m.piiMasked) {
    if (c?.email) bits.push(c.email);
    if (m.shippingInfo?.address) bits.push(m.shippingInfo.address);
  }
  if (m.dealer?.shopName) bits.push(`經銷 ${m.dealer.shopName}`);
  return bits.join(' ');
}

export function productRow(p: Product): string {
  let row = `${p.name}｜庫存 ${p.stock ?? '-'}｜警戒 ${p.lowStockThreshold ?? '-'}`;
  if (p.active === false) row += '｜未上架';
  if (p.trackStock === false) row += '｜不追蹤庫存';
  if (p.variants && p.variants.length > 0) {
    row += `｜規格 ${p.variants.map((v) => `${v.label ?? '-'} ${v.stock ?? '-'}`).join('、')}`;
  }
  return row;
}

function errorMessage(err: unknown): string {
  if (err instanceof EshopError) return err.userMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const { eshop, health, repos, jobs, grok, userId, userText, messageId, context } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => new Date());
  const records: ToolCallRecord[] = [];
  let piiRevealed = false;
  let reported = false;
  let staged: StagedReply | null = null;

  /** Applies the PII gate: the model's flag counts only when this message explicitly asks. */
  function honourReveal(tool: string, requested: boolean): boolean {
    if (!requested) return false;
    if (PII_REQUEST.test(userText)) return true;
    log.warn({ tool, userId }, 'reveal_pii requested without explicit ask; forced false');
    return false;
  }

  async function listOrders(input: z.infer<typeof listOrdersInput>, rec: ToolCallRecord) {
    for (const key of ['dateFrom', 'dateTo'] as const) {
      const v = input[key];
      if (v !== null && !isoWithOffset.safeParse(v).success) {
        throw new ToolInputError(`${key} 必須是 ISO 8601 且含時區，例如 2026-10-30T00:00:00+08:00`);
      }
    }
    const revealPii = honourReveal('list_orders', input.reveal_pii);
    rec.revealHonoured = revealPii;
    const params: ListOrdersParams = {
      page: Math.max(1, Math.trunc(input.page ?? 1)),
      limit: clamp(Math.trunc(input.limit ?? 10), 1, MAX_ROWS),
    };
    if (input.status !== null) params.status = input.status;
    if (input.paymentStatus !== null) params.paymentStatus = input.paymentStatus;
    if (input.paymentMethod !== null) params.paymentMethod = input.paymentMethod;
    if (input.orderType !== null) params.orderType = input.orderType;
    if (input.dateFrom !== null) params.dateFrom = input.dateFrom;
    if (input.dateTo !== null) params.dateTo = input.dateTo;
    if (input.q !== null) params.q = input.q;
    const res = await eshop.listOrders(params);
    const rows = res.orders.slice(0, MAX_ROWS).map((o) => {
      const m = maskOrder(o, { revealPii });
      const bits = customerBits(m);
      return bits ? `${summariseOrder(m)}｜${bits}` : summariseOrder(m);
    });
    const revealed = revealPii && rows.length > 0;
    if (revealed) piiRevealed = true;
    rec.piiRevealed = revealed;
    return {
      total: res.pagination.total,
      page: res.pagination.page,
      pages: res.pagination.pages,
      returned: rows.length,
      piiRevealed: revealed,
      rows,
    };
  }

  async function getOrder(input: z.infer<typeof getOrderInput>, rec: ToolCallRecord) {
    const revealPii = honourReveal('get_order', input.reveal_pii);
    rec.revealHonoured = revealPii;
    const o = await eshop.getOrder(input.orderId);
    if (!o) {
      rec.piiRevealed = false;
      return { found: false };
    }
    if (revealPii) piiRevealed = true;
    rec.piiRevealed = revealPii;
    return {
      found: true,
      piiRevealed: revealPii,
      detail: describeOrder(maskOrder(o, { revealPii })),
    };
  }

  async function listProducts(input: z.infer<typeof listProductsInput>) {
    const activeOnly = input.activeOnly ?? true;
    const q = input.query?.trim().toLowerCase() || null;
    const all = await eshop.listProducts();
    const matched = all.filter((p) => {
      if (activeOnly && p.active === false) return false;
      if (q === null) return true;
      return p.name.toLowerCase().includes(q) || (p.sub ?? '').toLowerCase().includes(q);
    });
    const rows = matched.slice(0, MAX_PRODUCT_ROWS).map(productRow);
    return { total: matched.length, returned: rows.length, rows };
  }

  async function lowStock() {
    const res = await eshop.lowStock();
    const products = res.products.slice(0, MAX_PRODUCT_ROWS).map(productRow);
    const addons = res.addons
      .slice(0, MAX_PRODUCT_ROWS)
      .map(
        (a) =>
          `加價購 ${a.name ?? '-'}｜庫存 ${a.stock ?? '-'}｜警戒 ${a.lowStockThreshold ?? '-'}`,
      );
    return { total: res.total ?? res.products.length + res.addons.length, products, addons };
  }

  async function healthTool() {
    const h = await health.check();
    return { status: h.status, latencyMs: h.latencyMs };
  }

  async function reportIssue(input: z.infer<typeof reportIssueInput>, rec: ToolCallRecord) {
    if (reported) throw new ToolInputError('本次對話已送出一次回報');
    reported = true;
    const description = input.description.trim();
    const ids = input.relatedOrderIds.slice(0, MAX_RELATED_ORDERS);
    const [h, statsRes, ...orderRes] = await Promise.all([
      health.check(),
      eshop.stats().then(
        (s) => ({ ok: true as const, s }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
      ...ids.map((id) =>
        eshop.getOrder(id).then(
          (o) => ({ ok: true as const, id, o }),
          (err: unknown) => ({ ok: false as const, id, err }),
        ),
      ),
    ]);
    const statsLine = statsRes.ok
      ? `今日 ${statsRes.s.today?.orders ?? '-'} 筆 / ${formatNtd(statsRes.s.today?.revenue)}，本月 ${formatNtd(statsRes.s.month?.revenue)}，待出貨 ${statsRes.s.pendingShipping ?? '-'}，低庫存 ${statsRes.s.lowStockCount ?? '-'}`
      : `查詢失敗：${errorMessage(statsRes.err)}`;
    const orderLines = orderRes.map((r) => {
      if (!r.ok) return `${r.id}：查詢失敗：${errorMessage(r.err)}`;
      if (!r.o) return `${r.id}：查無此訂單`;
      return truncate(describeOrder(maskOrder(r.o)), MAX_ORDER_DETAIL);
    });
    const grokText = truncate(
      `[管理端回報] ${description}\n管理員原文：${userText}\n統計：${statsLine}\n相關訂單（已遮罩）：\n${orderLines.join('\n')}`,
      MAX_GROK_TEXT,
    );
    const taskId = repos.incidents.insert({
      userId,
      text: description,
      healthStatus: h.status,
      healthRaw: healthRaw(h),
    });
    rec.taskId = taskId;
    if (!grok.configured) {
      log.warn({ userId, incidentId: taskId }, 'report_issue: grok not configured; not queued');
      return { taskId, queued: false, reason: '分析系統未設定' };
    }
    jobs.enqueue('incident_triage', {
      userId,
      incidentId: taskId,
      messageId,
      text: grokText,
      health: h,
      context,
      source: 'admin',
    });
    log.info({ userId, incidentId: taskId }, 'report_issue queued for triage');
    return { taskId, queued: true };
  }

  /** SPEC-ADMIN §12.3: stages the reply for the admin's `Y`; never sends. */
  async function replyCustomer(input: z.infer<typeof replyCustomerInput>, rec: ToolCallRecord) {
    const ticketId = Math.trunc(input.ticket_id);
    if (!Number.isFinite(ticketId) || ticketId <= 0)
      throw new ToolInputError('工單編號必須是正整數');
    rec.ticketId = ticketId;
    const text = input.text.trim();
    if (text.length === 0) throw new ToolInputError('回覆內容不可空白');
    if (text.length > MAX_REPLY_TEXT) throw new ToolInputError(`回覆內容最多 ${MAX_REPLY_TEXT} 字`);
    let ticket;
    try {
      ticket = await deps.enduser.getTicket(ticketId);
    } catch (err) {
      if (err instanceof EnduserClientError) throw new ToolInputError(err.userMessage);
      throw err;
    }
    if (ticket.status === 'closed') throw new ToolInputError(`${ticket.display} 已關閉，無法回覆`);
    repos.pendingConfirmations.set({
      adminUserId: userId,
      ticketId,
      text,
      now: now(),
      ttlMs: deps.confirmationTtlMs,
    });
    staged = { ticketId, display: ticket.display, text };
    log.info({ userId, ticketId }, 'reply_customer staged');
    return { staged: true, display: ticket.display, text };
  }

  async function execute(call: Anthropic.Beta.BetaToolUseBlock, rec: ToolCallRecord) {
    switch (call.name) {
      case 'list_orders':
        return listOrders(parse(listOrdersInput, call.input), rec);
      case 'get_order':
        return getOrder(parse(getOrderInput, call.input), rec);
      case 'list_products':
        return listProducts(parse(listProductsInput, call.input));
      case 'low_stock':
        parse(emptyInput, call.input);
        return lowStock();
      case 'stats':
        parse(emptyInput, call.input);
        return eshop.stats();
      case 'health':
        parse(emptyInput, call.input);
        return healthTool();
      case 'report_issue':
        return reportIssue(parse(reportIssueInput, call.input), rec);
      case 'reply_customer':
        return replyCustomer(parse(replyCustomerInput, call.input), rec);
      default:
        throw new ToolInputError(`未知工具 ${call.name}`);
    }
  }

  function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const r = schema.safeParse(input);
    if (!r.success)
      throw new ToolInputError(
        `參數錯誤：${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    return r.data;
  }

  function result(
    id: string,
    body: unknown,
    isError: boolean,
  ): Anthropic.Beta.BetaToolResultBlockParam {
    const content = truncate(JSON.stringify(body), MAX_RESULT_CHARS);
    return isError
      ? { type: 'tool_result', tool_use_id: id, is_error: true, content }
      : { type: 'tool_result', tool_use_id: id, content };
  }

  async function runOne(
    call: Anthropic.Beta.BetaToolUseBlock,
    index: number,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    if (index >= MAX_CALLS_PER_ROUND) {
      records.push({
        name: call.name,
        input: call.input,
        ok: false,
        ms: 0,
        error: 'too_many_calls',
      });
      return result(
        call.id,
        { error: `單一回應最多 ${MAX_CALLS_PER_ROUND} 個工具呼叫，此呼叫未執行` },
        true,
      );
    }
    const rec: ToolCallRecord = { name: call.name, input: call.input, ok: false, ms: 0 };
    records.push(rec);
    const started = now().getTime();
    try {
      const out = await execute(call, rec);
      rec.ok = true;
      rec.ms = now().getTime() - started;
      return result(call.id, out, false);
    } catch (err) {
      rec.ms = now().getTime() - started;
      rec.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (err instanceof ToolInputError) return result(call.id, { error: err.message }, true);
      throw err;
    }
  }

  return {
    records,
    get piiRevealed() {
      return piiRevealed;
    },
    get staged() {
      return staged;
    },
    async runRound(calls) {
      const settled = await Promise.allSettled(calls.map((c, i) => runOne(c, i)));
      const eshopErr = settled.find(
        (s): s is PromiseRejectedResult =>
          s.status === 'rejected' && s.reason instanceof EshopError,
      );
      if (eshopErr) throw eshopErr.reason;
      const other = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (other) throw other.reason;
      return settled.map(
        (s) => (s as PromiseFulfilledResult<Anthropic.Beta.BetaToolResultBlockParam>).value,
      );
    },
  };
}
