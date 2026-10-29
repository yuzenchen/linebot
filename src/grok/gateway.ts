import { createHmac } from 'node:crypto';
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

export interface GrokResult {
  ok: boolean;
  text?: string;
  structured?: unknown;
  error?: string;
  /**
   * Set by the gateway when the failure is worth retrying (5xx, network / timeout,
   * async_pending). Grok's own `ok:false` answers are never transient.
   */
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
  secret?: string;
  /** Default 60000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

export const SIGNATURE_HEADER = 'x-linebot-signature';
export const TIMESTAMP_HEADER = 'x-linebot-timestamp';

/** Hex HMAC-SHA256 of the raw body (shared by the gateway and `/grok/callback`). */
export function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
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
 * HTTP webhook to the external Grok bot.
 *
 * PROVISIONAL CONTRACT — awaiting the user's Grok bot webhook spec. Change here once it is known.
 *
 * Request: `POST <GROK_WEBHOOK_URL>`, `content-type: application/json`, body =
 * `{ ...GrokTask, sentAt: <ISO 8601> }`. When `GROK_WEBHOOK_SECRET` is set, also
 * `x-linebot-signature: <hex HMAC-SHA256(secret, raw body)>` and
 * `x-linebot-timestamp: <unix ms>` (informational; not part of the signature).
 *
 * Response:
 * - 2xx JSON `{ ok: boolean, text?: string, structured?: unknown, error?: string }` → passed through.
 * - 202, or JSON `{ async: true }` → `{ ok:false, error:'async_pending' }` (callback mode TBD).
 * - any other 2xx body → `{ ok:false, error:'bad_response' }`.
 * - non-2xx → `{ ok:false, error:'http_<status>' }`.
 * - network error / timeout → `{ ok:false, error:<message> }`.
 */
export class WebhookGrokGateway implements GrokGateway {
  readonly configured = true;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;

  constructor(private readonly opts: WebhookGrokGatewayOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? logger;
  }

  async run(task: GrokTask): Promise<GrokResult> {
    const started = Date.now();
    const ctx = { taskId: task.id, type: task.type };
    try {
      const body = JSON.stringify({ ...task, sentAt: new Date().toISOString() });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.opts.secret) {
        headers[SIGNATURE_HEADER] = signBody(body, this.opts.secret);
        headers[TIMESTAMP_HEADER] = String(Date.now());
      }
      const res = await this.fetchImpl(this.opts.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const ms = Date.now() - started;

      if (res.status === 202) {
        // TODO(grok): callback mode (POST /grok/callback) not finalized; treat as pending.
        this.log.info({ ...ctx, ms }, 'grok accepted task asynchronously');
        return { ok: false, error: 'async_pending', transient: true };
      }
      if (res.status < 200 || res.status >= 300) {
        this.log.warn({ ...ctx, ms, status: res.status }, 'grok webhook http error');
        return { ok: false, error: `http_${res.status}`, transient: res.status >= 500 };
      }

      let json: unknown;
      try {
        json = JSON.parse(await res.text()) as unknown;
      } catch {
        this.log.warn({ ...ctx, ms }, 'grok webhook returned non-JSON');
        return { ok: false, error: 'bad_response' };
      }
      if (typeof json !== 'object' || json === null) return { ok: false, error: 'bad_response' };
      const r = json as Record<string, unknown>;
      if (r.async === true) {
        // TODO(grok): callback mode not finalized.
        this.log.info({ ...ctx, ms }, 'grok accepted task asynchronously');
        return { ok: false, error: 'async_pending', transient: true };
      }
      if (typeof r.ok !== 'boolean') {
        this.log.warn({ ...ctx, ms }, 'grok webhook response missing ok');
        return { ok: false, error: 'bad_response' };
      }

      const result: GrokResult = { ok: r.ok };
      if (typeof r.text === 'string') result.text = r.text;
      if (r.structured !== undefined) result.structured = r.structured;
      if (typeof r.error === 'string') result.error = r.error;
      this.log.info({ ...ctx, ms, ok: result.ok }, 'grok webhook answered');
      return result;
    } catch (err) {
      const error = errorMessage(err);
      this.log.warn({ ...ctx, ms: Date.now() - started, err: error }, 'grok webhook failed');
      return { ok: false, error, transient: true };
    }
  }
}

export function createGrokGateway(
  config: Pick<Config, 'GROK_WEBHOOK_URL' | 'GROK_WEBHOOK_SECRET'>,
  log?: Logger,
): GrokGateway {
  if (!config.GROK_WEBHOOK_URL) return new NullGrokGateway();
  return new WebhookGrokGateway({
    url: config.GROK_WEBHOOK_URL,
    secret: config.GROK_WEBHOOK_SECRET,
    log,
  });
}
