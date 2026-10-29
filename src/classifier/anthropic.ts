import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { buildSystemBlocks, type SystemBlocks } from './prompt.js';
import {
  classificationSchema,
  type Classifier,
  type ClassifyInput,
  type ClassifyResult,
  type ContextMessage,
} from './types.js';

/** Minimal logger surface (pino-compatible). */
export type ClassifierLog = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
};

/** Only the part of the SDK client we use; lets tests inject a fake. */
export type ParseClient = { messages: Pick<Anthropic['messages'], 'parse'> };

export type AnthropicClassifierOptions = {
  client?: ParseClient;
  apiKey?: string;
  model: string;
  knowledgeText: string;
  timeoutMs?: number;
  log?: ClassifierLog;
};

const outputFormat = zodOutputFormat(classificationSchema);

/**
 * Turns LINE context + the new message into a valid Messages API list:
 * consecutive same-role turns are merged and the list always starts with `user`.
 */
export function buildMessages(input: ClassifyInput): Anthropic.MessageParam[] {
  const all: ContextMessage[] = [...input.context, { role: 'user', text: input.text }];
  const merged: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of all) {
    const text = m.text.trim();
    if (!text) continue;
    const last = merged.at(-1);
    if (last && last.role === m.role) {
      last.content = `${last.content}\n${text}`;
    } else {
      merged.push({ role: m.role, content: text });
    }
  }
  while (merged.length > 0 && merged[0].role !== 'user') merged.shift();
  return merged;
}

export class AnthropicClassifier implements Classifier {
  private readonly client: ParseClient;
  private readonly model: string;
  private readonly system: SystemBlocks;
  private readonly timeoutMs: number;
  private readonly log?: ClassifierLog;

  constructor(opts: AnthropicClassifierOptions) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model;
    this.system = buildSystemBlocks(opts.knowledgeText);
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.log = opts.log;
  }

  /** Throws on any failure (API error, timeout, refusal, schema mismatch) so callers can fall back. */
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const started = Date.now();
    const response = await this.client.messages.parse(
      {
        model: this.model,
        max_tokens: 1024,
        output_config: { effort: 'low', format: outputFormat },
        system: this.system,
        messages: buildMessages(input),
      },
      // The whole classification is bounded by timeoutMs; no hidden retries past it.
      { timeout: this.timeoutMs, maxRetries: 0 },
    );
    const latencyMs = Date.now() - started;

    const u = response.usage;
    this.log?.info(
      {
        model: this.model,
        stopReason: response.stop_reason,
        latencyMs,
        usage: {
          input_tokens: u?.input_tokens,
          cache_read_input_tokens: u?.cache_read_input_tokens,
          cache_creation_input_tokens: u?.cache_creation_input_tokens,
          output_tokens: u?.output_tokens,
        },
      },
      'classifier usage',
    );

    if (response.stop_reason !== 'end_turn') {
      throw new Error(`classifier stopped with stop_reason=${response.stop_reason}`);
    }
    if (response.parsed_output == null) {
      throw new Error('classifier returned no parsed output');
    }
    const parsed = classificationSchema.parse(response.parsed_output);
    return { ...parsed, classifier: 'anthropic', latencyMs };
  }
}
