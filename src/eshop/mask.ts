import {
  labelOf,
  orderTypeLabel,
  paymentMethodLabel,
  paymentStatusLabel,
  shippingMethodLabel,
  statusLabel,
  type Order,
} from './types.js';

/** SPEC-ADMIN §6: PII masking applied before anything reaches the model or the chat. */

export const HIDDEN = '(已隱藏)';

export interface MaskOptions {
  /** Admin explicitly asked for full phone / address / email. Caller must log `pii_revealed`. */
  revealPii?: boolean;
}

export type MaskedOrder = Order & { piiMasked: boolean };

/** `0912345678` → `0912****78`; anything shorter than 7 characters → `***`. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const s = phone.trim();
  if (s.length < 7) return '***';
  return `${s.slice(0, 4)}${'*'.repeat(s.length - 6)}${s.slice(-2)}`;
}

export function maskOrder(order: Order, opts: MaskOptions = {}): MaskedOrder {
  if (opts.revealPii) return { ...order, piiMasked: false };
  const masked: MaskedOrder = { ...order, piiMasked: true };
  if (order.customer) {
    masked.customer = {
      ...order.customer,
      phone: order.customer.phone ? maskPhone(order.customer.phone) : order.customer.phone,
      email: undefined,
      note: undefined,
    };
  }
  if (order.shippingInfo) {
    masked.shippingInfo = {
      ...order.shippingInfo,
      address: order.shippingInfo.address ? HIDDEN : order.shippingInfo.address,
    };
  }
  if (order.dealer) {
    masked.dealer = {
      ...order.dealer,
      phone: order.dealer.phone ? maskPhone(order.dealer.phone) : order.dealer.phone,
    };
  }
  return masked;
}

// ---- formatting ----------------------------------------------------------------------------

const TAIPEI = 'Asia/Taipei';

const shortFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const longFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function parts(fmt: Intl.DateTimeFormat, d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  // Some ICU builds print midnight as "24"; normalise to "00".
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** `MM-DD HH:mm` in Asia/Taipei; empty or invalid input → `-`. */
export function formatTaipeiShort(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = parts(shortFmt, d);
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** `YYYY-MM-DD HH:mm` in Asia/Taipei; empty or invalid input → `-`. */
export function formatTaipeiLong(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = parts(longFmt, d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function formatNtd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return 'NT$-';
  return `NT$${Math.round(amount).toLocaleString('en-US')}`;
}

/** One line: `#id｜MM-DD HH:mm（台北）｜狀態｜付款方式/付款狀態｜NT$total`. Contains no PII. */
export function summariseOrder(order: Order): string {
  const pm = labelOf(paymentMethodLabel, order.payment?.method);
  const ps = labelOf(paymentStatusLabel, order.payment?.status);
  return [
    order.orderId,
    `${formatTaipeiShort(order.createdAt)}（台北）`,
    labelOf(statusLabel, order.status),
    `${pm}/${ps}`,
    formatNtd(order.totalAmount),
  ].join('｜');
}

/**
 * Multi-line detail for a single order. Expects a `MaskedOrder` so the caller has made the
 * reveal decision explicitly; fields that the mask removed are simply not printed.
 */
export function describeOrder(order: MaskedOrder): string {
  const lines: string[] = [];
  const type = labelOf(orderTypeLabel, order.orderType, '');
  lines.push(`${order.orderId}${type ? `（${type}）` : ''}`);
  lines.push(`成立：${formatTaipeiLong(order.createdAt)}（台北）`);
  lines.push(`狀態：${labelOf(statusLabel, order.status)}`);
  const pm = labelOf(paymentMethodLabel, order.payment?.method);
  const ps = labelOf(paymentStatusLabel, order.payment?.status);
  let payLine = `付款：${pm}/${ps}`;
  if (order.payment?.paidAt) payLine += `（${formatTaipeiLong(order.payment.paidAt)}）`;
  lines.push(payLine);
  if (order.payment?.lastError) lines.push(`付款錯誤：${order.payment.lastError}`);

  const items = order.items ?? [];
  if (items.length) {
    lines.push('品項：');
    for (const it of items) {
      const variant = it.variantLabel ? `（${it.variantLabel}）` : '';
      const qty = it.qty ?? 1;
      const price = it.price ?? 0;
      lines.push(`- ${it.name ?? '-'}${variant} x${qty} ${formatNtd(price * qty)}`);
    }
  }
  const money: string[] = [];
  if (order.subtotal !== null && order.subtotal !== undefined)
    money.push(`小計 ${formatNtd(order.subtotal)}`);
  if (order.shipping) money.push(`運費 ${formatNtd(order.shipping)}`);
  if (order.couponDiscount) {
    const code = order.couponCode ? ` ${order.couponCode}` : '';
    money.push(`折扣${code} -${formatNtd(order.couponDiscount)}`);
  }
  money.push(`合計 ${formatNtd(order.totalAmount)}`);
  lines.push(money.join('，'));

  const ship = order.shippingInfo;
  let shipLine = `配送：${labelOf(shippingMethodLabel, order.shippingMethod)}`;
  if (ship?.storeName) shipLine += `｜${ship.storeName}`;
  if (ship?.address) shipLine += `｜${ship.address}`;
  lines.push(shipLine);
  if (ship?.pickupDate) lines.push(`取貨日：${ship.pickupDate}`);
  if (ship?.trackingNo) lines.push(`物流單號：${ship.trackingNo}`);

  const c = order.customer;
  if (c) {
    const bits: string[] = [];
    if (c.name) bits.push(c.name);
    if (c.instagram) bits.push(`IG ${c.instagram}`);
    if (c.phone) bits.push(c.phone);
    if (c.email) bits.push(c.email);
    if (bits.length) lines.push(`客人：${bits.join('｜')}`);
    if (c.note) lines.push(`客人備註：${c.note}`);
  }
  const d = order.dealer;
  if (d) {
    const bits: string[] = [];
    if (d.shopName) bits.push(d.shopName);
    if (d.contact) bits.push(d.contact);
    if (d.phone) bits.push(d.phone);
    if (bits.length) lines.push(`經銷：${bits.join('｜')}`);
    if (d.deliveryDate) lines.push(`交貨日：${d.deliveryDate}`);
    if (d.note) lines.push(`經銷備註：${d.note}`);
  }
  if (order.groupBuy?.name) lines.push(`團購：${order.groupBuy.name}`);
  if (order.adminNote) lines.push(`管理備註：${order.adminNote}`);
  return lines.join('\n');
}
