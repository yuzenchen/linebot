import type { Logger } from 'pino';
import type { ContextMessage } from '../classifier/types.js';
import type { Config } from '../config.js';
import type { HealthResult } from '../health/check.js';
import { logger } from '../logger.js';

export type GrokTaskType = 'service_question' | 'incident_triage' | 'summarize_suggestion';

export interface GrokTask {
  id: string;
  type: GrokTaskType;
  userMessage: string;
  context: ContextMessage[];
  /** incident_triage only. */
  health?: HealthResult;
  /** summarize_suggestion only. */
  existingSuggestions?: Array<{ id: number; title: string }>;
}

/**
 * Outcome of dispatching a task. The answer itself never travels in this result: the Cursor
 * agent reports back later through `POST /grok/callback` (see `callback.ts`).
 */
export interface GrokResult {
  ok: boolean;
  /** True when the webhook accepted the task (2xx) and a callback is expected. */
  accepted?: boolean;
  error?: string;
  /** Set when the failure is worth retrying (5xx, network / timeout). 4xx is never transient. */
  transient?: boolean;
}

export interface GrokGateway {
  /** False for the Null gateway: callers treat the job as `skipped`. */
  readonly configured: boolean;
  /** Never throws. */
  run(task: GrokTask): Promise<GrokResult>;
}

/** Used when `GROK_WEBHOOK_URL` is unset (SPEC 5.6). */
export class NullGrokGateway implements GrokGateway {
  readonly configured = false;
  run(): Promise<GrokResult> {
    return Promise.resolve({ ok: false, error: 'grok_not_configured' });
  }
}

export interface WebhookGrokGatewayOptions {
  url: string;
  /** Cursor Automations token, with or without a leading `Bearer `. */
  secret?: string;
  /** Absolute URL of our `/grok/callback`. */
  callbackUrl: string;
  /** Token the agent must echo in `x-linebot-token`. */
  callbackToken: string;
  /** Default 30000. Only covers the dispatch request, not the agent run. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

export const CALLBACK_TOKEN_HEADER = 'x-linebot-token';

/** `crsr_x` and `Bearer crsr_x` (any case) both become `Bearer crsr_x`. */
export function bearerHeader(secret: string): string {
  return `Bearer ${secret.trim().replace(/^bearer\s+/i, '')}`;
}

/**
 * Self-describing instructions appended to the Cursor automation prompt with every task. Keep the
 * wording stable so the prompt on the Cursor side stays easy to read and diff.
 */
export const GROK_INSTRUCTIONS =
  '你是「王媽媽寵物手工零食」LINE 客服的後援系統。請依 type 處理：service_question 要回答使用者關於商品/訂單/網站的問題；incident_triage 要依 health 與使用者描述整理異常原因與建議處置；summarize_suggestion 要把需求建議整理成 title/summary/category，並比對 existingSuggestions 給出 mergedInto（相似項目的 id）或 null。收到任務後請先 POST callback status=received；處理中可 POST status=processing（可附 text）；完成後 POST status=done 並附 text（繁體中文、口語、1 到 4 句、不用 emoji、不透露內部系統）；service_question：能回答 → done；查不到、需要人工介入、或你只是把問題轉給別人 → status=needs_human 並附上要給客戶看的簡短說明，不要用 done；無法處理時 POST status=failed 並附簡短原因。callback 請用 header x-linebot-token 帶上 token，body 為 JSON。';

/** JSON body of the dispatch request (also documents the contract for the Cursor prompt). */
export function buildDispatchBody(
  task: GrokTask,
  opts: Pick<WebhookGrokGatewayOptions, 'callbackUrl' | 'callbackToken'>,
  sentAt: Date = new Date(),
): Record<string, unknown> {
  return {
    ...task,
    sentAt: sentAt.toISOString(),
    callback: {
      url: opts.callbackUrl,
      method: 'POST',
      header: CALLBACK_TOKEN_HEADER,
      token: opts.callbackToken,
      body: {
        taskId: task.id,
        status:
          'received | processing | done | failed | needs_human（service_question：能回答 → done；查不到、需要人工介入、或你只是把問題轉給別人 → status=needs_human 並附上要給客戶看的簡短說明，不要用 done）',
        text: '給使用者或管理員看的繁體中文',
        structured: 'summarize_suggestion 的 done 必填：{title, summary, category, mergedInto?}',
      },
    },
    instructions: GROK_INSTRUCTIONS,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? ` (${cause.message})` : '';
    return `${err.name}: ${err.message}${causeMsg}`;
  }
  return String(err);
}

/**
 * Dispatch-only gateway to a Cursor Automations webhook (`https://api2.cursor.sh/automations/webhook/<id>`).
 *
 * Request: `POST <GROK_WEBHOOK_URL>` with `authorization: Bearer <GROK_WEBHOOK_SECRET>` and
 * `content-type: application/json`; body = `buildDispatchBody(task)`. The POST starts one
 * asynchronous agent run; the body is appended to the automation's prompt, and the HTTP response
 * carries no answer. The agent reports back by POSTing to `callback.url` (possibly several times:
 * `received`, `processing`, then `done` / `failed`).
 *
 * Result:
 * - 2xx → `{ ok:true, accepted:true }` (response body logged at debug when JSON).
 * - 401 / 403 → `{ ok:false, error:'http_<status>', transient:false }` (bad token).
 * - other 4xx → non-transient; 5xx / network / timeout → transient.
 */
export class WebhookGrokGateway implements GrokGateway {
  readonly configured = true;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly authorization?: string;

  constructor(private readonly opts: WebhookGrokGatewayOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? logger;
    this.authorization = opts.secret ? bearerHeader(opts.secret) : undefined;
  }

  async run(task: GrokTask): Promise<GrokResult> {
    const started = Date.now();
    const ctx = { taskId: task.id, type: task.type };
    try {
      const body = JSON.stringify(buildDispatchBody(task, this.opts));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.authorization) headers.authorization = this.authorization;
      const res = await this.fetchImpl(this.opts.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const ms = Date.now() - started;

      if (res.status < 200 || res.status >= 300) {
        this.log.warn({ ...ctx, ms, status: res.status }, 'grok webhook http error');
        return { ok: false, error: `http_${res.status}`, transient: res.status >= 500 };
      }

      const text = await res.text().catch(() => '');
      if (text && this.log.isLevelEnabled('debug')) {
        try {
          this.log.debug(
            { ...ctx, response: JSON.parse(text) as unknown },
            'grok webhook response',
          );
        } catch {
          // Non-JSON acknowledgement; nothing useful to log.
        }
      }
      this.log.info({ ...ctx, ms, status: res.status }, 'grok task accepted');
      return { ok: true, accepted: true };
    } catch (err) {
      const error = errorMessage(err);
      this.log.warn({ ...ctx, ms: Date.now() - started, err: error }, 'grok webhook failed');
      return { ok: false, error, transient: true };
    }
  }
}

export function callbackUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/grok/callback`;
}

export function createGrokGateway(
  config: Pick<
    Config,
    'GROK_WEBHOOK_URL' | 'GROK_WEBHOOK_SECRET' | 'PUBLIC_BASE_URL' | 'GROK_CALLBACK_TOKEN'
  >,
  log?: Logger,
): GrokGateway {
  if (!config.GROK_WEBHOOK_URL) return new NullGrokGateway();
  return new WebhookGrokGateway({
    url: config.GROK_WEBHOOK_URL,
    secret: config.GROK_WEBHOOK_SECRET,
    // loadConfig guarantees both when GROK_WEBHOOK_URL is set.
    callbackUrl: callbackUrlFor(config.PUBLIC_BASE_URL ?? ''),
    callbackToken: config.GROK_CALLBACK_TOKEN ?? '',
    log,
  });
}
