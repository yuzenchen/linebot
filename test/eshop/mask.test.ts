import { describe, expect, it } from 'vitest';
import {
  describeOrder,
  formatTaipeiShort,
  HIDDEN,
  maskOrder,
  maskPhone,
  summariseOrder,
} from '../../src/eshop/mask.js';
import { orderSchema } from '../../src/eshop/types.js';
import { sampleOrder } from './helpers.js';

const order = () => orderSchema.parse(sampleOrder());

describe('maskPhone', () => {
  it('keeps first 4 and last 2', () => {
    expect(maskPhone('0912345678')).toBe('0912****78');
    expect(maskPhone('+886912345678')).toBe('+886*******78');
    expect(maskPhone(' 0912345678 ')).toBe('0912****78');
  });
  it('short or empty values', () => {
    expect(maskPhone('123456')).toBe('***');
    expect(maskPhone('1234567')).toBe('1234*67');
    expect(maskPhone('')).toBe('');
    expect(maskPhone(undefined)).toBe('');
  });
});

describe('maskOrder', () => {
  it('default masks phone and removes email / note / address', () => {
    const m = maskOrder(order());
    expect(m.piiMasked).toBe(true);
    expect(m.customer?.name).toBe('王小明');
    expect(m.customer?.instagram).toBe('ming_ig');
    expect(m.customer?.phone).toBe('0912****78');
    expect(m.customer?.email).toBeUndefined();
    expect(m.customer?.note).toBeUndefined();
    expect(m.shippingInfo?.address).toBe(HIDDEN);
    expect(m.shippingInfo?.storeName).toBe('全家測試店');
    expect(m.dealer?.phone).toBe('0987****21');
    expect(m.dealer?.contact).toBe('李老闆');
    const text = describeOrder(m);
    expect(text).not.toContain('ming@example.com');
    expect(text).not.toContain('0912345678');
    expect(text).not.toContain('台北市中正區');
    expect(text).not.toContain('請小心輕放');
  });

  it('does not mutate the input', () => {
    const o = order();
    maskOrder(o);
    expect(o.customer?.phone).toBe('0912345678');
    expect(o.shippingInfo?.address).toBe('台北市中正區XX路1號');
  });

  it('revealPii keeps everything', () => {
    const m = maskOrder(order(), { revealPii: true });
    expect(m.piiMasked).toBe(false);
    expect(m.customer?.phone).toBe('0912345678');
    expect(m.customer?.email).toBe('ming@example.com');
    expect(m.shippingInfo?.address).toBe('台北市中正區XX路1號');
    expect(describeOrder(m)).toContain('ming@example.com');
  });

  it('tolerates orders without customer / shippingInfo / dealer', () => {
    const m = maskOrder(
      orderSchema.parse({ orderId: '#1', customer: null, shippingInfo: undefined, dealer: null }),
    );
    expect(m.customer).toBeNull();
    expect(m.dealer).toBeNull();
    expect(() => describeOrder(m)).not.toThrow();
  });
});

describe('formatting', () => {
  it('formats UTC ISO input in Asia/Taipei', () => {
    expect(formatTaipeiShort('2026-10-29T16:05:00Z')).toBe('10-30 00:05');
    expect(formatTaipeiShort('2026-10-30T04:00:00+08:00')).toBe('10-30 04:00');
    expect(formatTaipeiShort(undefined)).toBe('-');
    expect(formatTaipeiShort('garbage')).toBe('-');
  });

  it('summariseOrder is one line with labels and NT$', () => {
    const s = summariseOrder(order());
    expect(s).toBe('#20261029-ABCDEF12｜10-30 00:05（台北）｜已付款｜LINE Pay/已付款｜NT$1,260');
    expect(s.includes('\n')).toBe(false);
  });

  it('summariseOrder falls back for missing fields', () => {
    const s = summariseOrder(orderSchema.parse({ orderId: '#X' }));
    expect(s).toBe('#X｜-（台北）｜-｜-/-｜NT$-');
  });

  it('describeOrder lists items, shipping, pickup date and admin note', () => {
    const m = maskOrder(orderSchema.parse(sampleOrder({ adminNote: '已電話確認' })));
    const text = describeOrder(m);
    expect(text).toContain('- 雞肉條 x2 NT$1,200');
    expect(text).toContain('配送：超商取貨｜全家測試店');
    expect(text).toContain('取貨日：2026-11-01');
    expect(text).toContain('管理備註：已電話確認');
    expect(text).toContain('成立：2026-10-30 00:05（台北）');
    expect(text).toContain('客人：王小明｜IG ming_ig｜0912****78');
  });
});
