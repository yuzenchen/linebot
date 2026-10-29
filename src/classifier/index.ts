import { config } from '../config.js';
import { logger } from '../logger.js';
import { AnthropicClassifier, type ClassifierLog } from './anthropic.js';
import { loadKnowledge } from './knowledge.js';
import { RuleClassifier } from './rule.js';
import type { Classification, Classifier, ClassifyInput, ClassifyResult } from './types.js';

export * from './types.js';
export { AnthropicClassifier, buildMessages } from './anthropic.js';
export type { ClassifierLog, ParseClient } from './anthropic.js';
export { RuleClassifier } from './rule.js';
export { loadKnowledge, resetKnowledgeCache } from './knowledge.js';
export { buildSystemBlocks } from './prompt.js';

export const MIN_CONFIDENCE = 0.6;

/** SPEC 5.3: low-confidence kb_answer / off_topic degrade to service_related. */
export function normalize<T extends Classification>(c: T): T {
  if (c.confidence < MIN_CONFIDENCE && (c.category === 'kb_answer' || c.category === 'off_topic')) {
    return {
      ...c,
      category: 'service_related',
      answer: null,
      reason: `${c.reason} (degraded: low confidence)`,
    };
  }
  if (c.category !== 'kb_answer' && c.answer !== null) return { ...c, answer: null };
  return c;
}

/** Tries the primary classifier; on any error logs a warning and uses the fallback. */
export class FallbackClassifier implements Classifier {
  constructor(
    private readonly primary: Classifier,
    private readonly fallback: Classifier,
    private readonly log?: ClassifierLog,
  ) {}

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    try {
      return await this.primary.classify(input);
    } catch (err) {
      this.log?.warn({ err }, 'primary classifier failed; using rule fallback');
      return this.fallback.classify(input);
    }
  }
}

class NormalizingClassifier implements Classifier {
  constructor(private readonly inner: Classifier) {}
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    return normalize(await this.inner.classify(input));
  }
}

export type CreateClassifierOptions = {
  apiKey?: string;
  model: string;
  knowledgeText: string;
  log?: ClassifierLog;
};

export function createClassifier(opts: CreateClassifierOptions): Classifier {
  const rule = new RuleClassifier();
  if (!opts.apiKey) return new NormalizingClassifier(rule);
  const anthropic = new AnthropicClassifier({
    apiKey: opts.apiKey,
    model: opts.model,
    knowledgeText: opts.knowledgeText,
    log: opts.log,
  });
  return new NormalizingClassifier(new FallbackClassifier(anthropic, rule, opts.log));
}

export function createClassifierFromConfig(): Classifier {
  return createClassifier({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.CLASSIFIER_MODEL,
    knowledgeText: loadKnowledge().text,
    log: logger,
  });
}
