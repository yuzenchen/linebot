import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/classifier/index.js';
import type { Classification } from '../../src/classifier/types.js';

const c = (o: Partial<Classification>): Classification => ({
  category: 'kb_answer',
  confidence: 0.9,
  answer: '滿 NT$500 免運',
  reason: 'r',
  ...o,
});

describe('normalize', () => {
  it('keeps kb_answer at confidence 0.6', () => {
    expect(normalize(c({ confidence: 0.6 }))).toEqual(c({ confidence: 0.6 }));
  });

  it('degrades kb_answer at 0.59', () => {
    expect(normalize(c({ confidence: 0.59 }))).toEqual({
      category: 'service_related',
      confidence: 0.59,
      answer: null,
      reason: 'r (degraded: low confidence)',
    });
  });

  it('degrades off_topic below 0.6', () => {
    const r = normalize(c({ category: 'off_topic', confidence: 0.3, answer: null }));
    expect(r.category).toBe('service_related');
    expect(r.reason).toContain('(degraded: low confidence)');
  });

  it('keeps off_topic at 0.6', () => {
    expect(normalize(c({ category: 'off_topic', confidence: 0.6, answer: null })).category).toBe(
      'off_topic',
    );
  });

  it('leaves low-confidence incident_report untouched', () => {
    const input = c({ category: 'incident_report', confidence: 0.2, answer: null });
    expect(normalize(input)).toEqual(input);
  });

  it('preserves extra result fields', () => {
    const r = normalize({ ...c({ confidence: 0.1 }), classifier: 'rule' as const, latencyMs: 3 });
    expect(r).toMatchObject({ classifier: 'rule', latencyMs: 3, category: 'service_related' });
  });
});
