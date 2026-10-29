import type { Classifier, ClassifyInput, ClassifyResult } from './types.js';

const INCIDENT = /壞了|錯誤|無法|不能|打不開|失敗|當機|沒反應|異常|bug|error|500|404/i;
const FEATURE = /希望|建議|可不可以|能不能|如果有|增加|新增功能|想要/i;
const GREETING = /你好|哈囉|hi|hello|嗨/i;

export const GREETING_ANSWER = '你好，有什麼可以幫你的嗎？商品、訂單、付款、配送的問題都可以問我。';

/** Keyword heuristics used when no API key is configured or the model call fails. */
export class RuleClassifier implements Classifier {
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const started = Date.now();
    const text = input.text.trim();
    const done = (r: Omit<ClassifyResult, 'classifier' | 'latencyMs'>): ClassifyResult => ({
      ...r,
      classifier: 'rule',
      latencyMs: Date.now() - started,
    });

    const incident = text.match(INCIDENT);
    if (incident) {
      return done({
        category: 'incident_report',
        confidence: 0.7,
        answer: null,
        reason: `rule: incident keyword "${incident[0]}"`,
      });
    }
    const feature = text.match(FEATURE);
    if (feature) {
      return done({
        category: 'feature_request',
        confidence: 0.65,
        answer: null,
        reason: `rule: feature keyword "${feature[0]}"`,
      });
    }
    if (text.length <= 6 && GREETING.test(text)) {
      return done({
        category: 'kb_answer',
        confidence: 0.9,
        answer: GREETING_ANSWER,
        reason: 'rule: greeting only',
      });
    }
    return done({
      category: 'service_related',
      confidence: 0.5,
      answer: null,
      reason: 'rule: no keyword matched (default)',
    });
  }
}
