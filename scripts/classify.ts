/**
 * Manual check against the real Anthropic API (not part of tests).
 *   npm run classify -- "訂單怎麼查"
 */
import { AnthropicClassifier } from '../src/classifier/anthropic.js';
import { normalize } from '../src/classifier/index.js';
import { loadKnowledge } from '../src/classifier/knowledge.js';
import { configSchema } from '../src/config.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Usage: npm run classify -- "<message text>"');
  process.exit(1);
}

// Load ./.env when present (Node >= 21.7); real env vars take precedence.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env — rely on the environment
}

// Only the classifier fields are needed; LINE secrets are not required for this script.
const cfg = configSchema
  .pick({ ANTHROPIC_API_KEY: true, CLASSIFIER_MODEL: true })
  .parse(process.env);
if (!cfg.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Put it in .env or the environment and retry.');
  process.exit(1);
}

const log = {
  info: (obj: object, msg?: string) => console.error(msg ?? '', JSON.stringify(obj)),
  warn: (obj: object, msg?: string) => console.error(msg ?? '', JSON.stringify(obj)),
};

const classifier = new AnthropicClassifier({
  apiKey: cfg.ANTHROPIC_API_KEY,
  model: cfg.CLASSIFIER_MODEL,
  knowledgeText: loadKnowledge().text,
  log,
});

try {
  const result = normalize(await classifier.classify({ text, context: [] }));
  console.log(JSON.stringify(result, null, 2));
  console.log(`latency: ${result.latencyMs} ms`);
} catch (err) {
  console.error('classify failed:', err);
  process.exit(1);
}
