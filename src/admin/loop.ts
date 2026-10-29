import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { EshopError } from '../eshop/errors.js';
import { logger } from '../logger.js';
import { texts } from '../texts.js';
import { buildSystem, CAP_INSTRUCTION } from './prompt.js';
import { ADMIN_TOOL_DEFS, type ToolCallRecord, type ToolExecutor } from './tools.js';

/** ADMIN-HANDLER-DESIGN §1: hand-written model/tool loop over `beta.messages.create`. */

export interface AdminModelClient {
  beta: {
    messages: {
      create(
        body: Anthropic.Beta.MessageCreateParamsNonStreaming,
        options?: Anthropic.RequestOptions,
      ): PromiseLike<Anthropic.Beta.BetaMessage>;
    };
  };
}

export const ADMIN_MAX_TOKENS = 16000;
export const ADMIN_REQUEST_TIMEOUT_MS = 60_000;
export const ADMIN_MAX_RETRIES = 1;
export const ADMIN_LOOP_BUDGET_MS = 150_000;

export type AdminOutcome =
  'answered' | 'capped' | 'refused' | 'eshop_error' | 'model_error' | 'error';

export interface AdminRunResult {
  text: string;
  outcome: AdminOutcome;
  tools: ToolCallRecord[];
  piiRevealed: boolean;
  rounds: number;
  /** Model that actually answered the last call (differs from config on server-side fallback). */
  servedBy?: string;
}

/** Unexpected `stop_reason` or an aborted budget: mapped to `model_error`. */
export class AdminLoopError extends Error {
  constructor(readonly stopReason: string) {
    super(`admin loop stopped with stop_reason=${stopReason}`);
    this.name = 'AdminLoopError';
  }
}

export interface RunAdminQueryOptions {
  client: AdminModelClient;
  executor: ToolExecutor;
  messages: Anthropic.Beta.BetaMessageParam[];
  config: Pick<Config, 'ADMIN_MODEL' | 'ADMIN_MAX_TOOL_ROUNDS'>;
  userId: string;
  now?: () => Date;
  /** Overall budget; default `AbortSignal.timeout(ADMIN_LOOP_BUDGET_MS)`. */
  budgetSignal?: AbortSignal;
  requestTimeoutMs?: number;
  log?: Logger;
}

function textOf(res: Anthropic.Beta.BetaMessage): string {
  return res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function isModelError(err: unknown): boolean {
  return err instanceof Anthropic.APIError || err instanceof AdminLoopError;
}

/**
 * Runs the conversation until the model answers. Never rejects: every failure becomes a result
 * whose `text` is the user-facing message (`EshopError.userMessage`, `texts.adminModelUnavailable`
 * or `texts.fallbackError`).
 */
export async function runAdminQuery(opts: RunAdminQueryOptions): Promise<AdminRunResult> {
  const { client, executor, config, userId } = opts;
  const log = opts.log ?? logger;
  const now = opts.now ?? (() => new Date());
  const budgetSignal = opts.budgetSignal ?? AbortSignal.timeout(ADMIN_LOOP_BUDGET_MS);
  const system = buildSystem(now());
  const messages: Anthropic.Beta.BetaMessageParam[] = [...opts.messages];
  let toolRounds = 0;
  let servedBy: string | undefined;

  const finish = (text: string, outcome: AdminOutcome): AdminRunResult => ({
    text,
    outcome,
    tools: executor.records,
    piiRevealed: executor.piiRevealed,
    rounds: toolRounds,
    servedBy,
  });

  try {
    for (;;) {
      if (budgetSignal.aborted) throw new AdminLoopError('budget_exhausted');
      const forceAnswer = toolRounds >= config.ADMIN_MAX_TOOL_ROUNDS;
      const res = await client.beta.messages.create(
        {
          model: config.ADMIN_MODEL,
          max_tokens: ADMIN_MAX_TOKENS,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          system,
          tools: [...ADMIN_TOOL_DEFS],
          tool_choice: forceAnswer ? { type: 'none' } : { type: 'auto' },
          messages: forceAnswer
            ? [...messages, { role: 'system', content: CAP_INSTRUCTION }]
            : [...messages],
        },
        {
          timeout: opts.requestTimeoutMs ?? ADMIN_REQUEST_TIMEOUT_MS,
          maxRetries: ADMIN_MAX_RETRIES,
          signal: budgetSignal,
        },
      );
      servedBy = res.model;
      const u = res.usage;
      log.info(
        {
          userId,
          round: toolRounds,
          stopReason: res.stop_reason,
          model: res.model,
          usage: {
            input_tokens: u?.input_tokens,
            cache_read_input_tokens: u?.cache_read_input_tokens,
            cache_creation_input_tokens: u?.cache_creation_input_tokens,
            output_tokens: u?.output_tokens,
          },
        },
        'admin model usage',
      );
      if (res.model !== config.ADMIN_MODEL) {
        log.warn(
          { userId, requested: config.ADMIN_MODEL, served: res.model },
          'admin model fallback served',
        );
      }

      switch (res.stop_reason) {
        case 'end_turn': {
          const text = textOf(res);
          if (forceAnswer) {
            return finish(`${text || texts.adminEmptyAnswer}\n${texts.adminToolCapNote}`, 'capped');
          }
          return finish(text || texts.adminEmptyAnswer, 'answered');
        }
        case 'tool_use': {
          if (forceAnswer) throw new AdminLoopError('tool_use_after_cap');
          const calls = res.content.filter(
            (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
          );
          messages.push({ role: 'assistant', content: res.content });
          const results = await executor.runRound(calls);
          messages.push({ role: 'user', content: results });
          toolRounds += 1;
          continue;
        }
        case 'refusal':
          log.warn({ userId, stopDetails: res.stop_details }, 'admin model refused');
          return finish(texts.adminModelRefused, 'refused');
        default:
          throw new AdminLoopError(res.stop_reason ?? 'null');
      }
    }
  } catch (err) {
    if (err instanceof EshopError) {
      log.error({ userId, outcome: 'eshop_error', err }, 'admin query failed');
      return finish(err.userMessage, 'eshop_error');
    }
    if (isModelError(err)) {
      log.error({ userId, outcome: 'model_error', err }, 'admin query failed');
      return finish(texts.adminModelUnavailable, 'model_error');
    }
    log.error({ userId, outcome: 'error', err }, 'admin query failed');
    return finish(texts.fallbackError, 'error');
  }
}
