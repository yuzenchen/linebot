import { describe, expect, it } from 'vitest';
import { RuleClassifier } from '../../src/classifier/rule.js';

const rule = new RuleClassifier();
const run = (text: string) => rule.classify({ text, context: [] });

describe('RuleClassifier', () => {
  it('incident keywords', async () => {
    const r = await run('網站打不開');
    expect(r).toMatchObject({ category: 'incident_report', confidence: 0.7, answer: null });
    expect(r.classifier).toBe('rule');
    expect(r.reason).toContain('打不開');
    expect((await run('結帳出現 Error')).category).toBe('incident_report');
  });

  it('feature keywords', async () => {
    const r = await run('希望可以用信用卡付款');
    expect(r).toMatchObject({ category: 'feature_request', confidence: 0.65, answer: null });
    expect(r.reason).toContain('希望');
  });

  it('incident wins over feature', async () => {
    expect((await run('希望修好，現在無法登入')).category).toBe('incident_report');
  });

  it('greeting only', async () => {
    const r = await run('你好');
    expect(r).toMatchObject({ category: 'kb_answer', confidence: 0.9 });
    expect(r.answer).toBeTruthy();
    expect((await run('Hello')).category).toBe('kb_answer');
  });

  it('long greeting is not greeting-only', async () => {
    const r = await run('你好，請問我的訂單寄出了沒');
    expect(r).toMatchObject({ category: 'service_related', confidence: 0.5, answer: null });
  });

  it('default service_related', async () => {
    const r = await run('訂單怎麼查');
    expect(r).toMatchObject({ category: 'service_related', confidence: 0.5, answer: null });
    expect(r.reason).toContain('default');
  });
});
