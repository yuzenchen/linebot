import { describe, expect, it } from 'vitest';
import { DEFERRAL_RE, looksLikeDeferral } from '../../src/grok/deferral.js';

describe('looksLikeDeferral', () => {
  it.each([
    '已經一併轉給專人查詢，請稍候。',
    '已轉給專人查詢',
    '我已轉交專人，會再通知你。',
    '這部分需要專人確認。',
    '稍後會有專人回覆你。',
    '我請專人處理。',
    '之後會由專人聯繫你。',
    '會有專人跟你聯絡。',
    '建議洽人工客服。',
    '需要人工處理。',
    '我幫你通知專人了。',
    '已通知專人。',
  ])('matches deferral text %s', (text) => {
    expect(looksLikeDeferral(text)).toBe(true);
  });

  it.each([
    '訂單已出貨，預計明天到。',
    '專人',
    '我們有專人負責包裝，品質很穩定。',
    '退貨請在 7 天內申請。',
    '人工香料完全不添加。',
  ])('does not match a normal answer %s', (text) => {
    expect(looksLikeDeferral(text)).toBe(false);
  });

  it('exports the regex', () => {
    expect(DEFERRAL_RE.test('轉給專人')).toBe(true);
  });
});
