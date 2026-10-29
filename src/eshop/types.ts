import { z } from 'zod';

/**
 * Backend shapes for pet eshop `/api/v1` (facts from the wa'mahouse maintainers, 2026-10-30).
 * No OpenAPI exists, so every object is loose: unknown extra fields pass through.
 */

// ---- enums -------------------------------------------------------------------------------

export const orderStatuses = [
  'created',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const orderTypes = ['general', 'dealer', 'groupbuy'] as const;
export type OrderType = (typeof orderTypes)[number];

export const paymentStatuses = [
  'pending',
  'authorized',
  'paid',
  'refunding',
  'refunded',
  'failed',
  'cancelled',
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export const paymentMethods = ['linepay', 'bank_transfer', 'cvs_payment'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const shippingMethods = [
  'home_delivery',
  'convenience_store',
  'self_pickup',
  'dealer_logistics',
] as const;
export type ShippingMethod = (typeof shippingMethods)[number];

export const productTypes = ['easy', 'mild', 'medium', 'hard', 'bulk'] as const;
export type ProductType = (typeof productTypes)[number];

// ---- zh-TW labels ------------------------------------------------------------------------

export const statusLabel: Record<OrderStatus, string> = {
  created: '已成立',
  paid: '已付款',
  processing: '處理中',
  shipped: '已出貨',
  delivered: '已送達',
  cancelled: '已取消',
};

export const orderTypeLabel: Record<OrderType, string> = {
  general: '一般',
  dealer: '經銷',
  groupbuy: '團購',
};

export const paymentStatusLabel: Record<PaymentStatus, string> = {
  pending: '未付款',
  authorized: '已授權',
  paid: '已付款',
  refunding: '退款中',
  refunded: '已退款',
  failed: '付款失敗',
  cancelled: '已取消',
};

export const paymentMethodLabel: Record<PaymentMethod, string> = {
  linepay: 'LINE Pay',
  bank_transfer: '銀行轉帳',
  cvs_payment: '超商付款',
};

export const shippingMethodLabel: Record<ShippingMethod, string> = {
  home_delivery: '宅配',
  convenience_store: '超商取貨',
  self_pickup: '自取',
  dealer_logistics: '經銷物流',
};

/** Label lookup that tolerates unknown / missing backend values (returns the raw value). */
export function labelOf<K extends string>(
  table: Record<K, string>,
  value: string | null | undefined,
  fallback = '-',
): string {
  if (value === null || value === undefined || value === '') return fallback;
  return (table as Record<string, string>)[value] ?? value;
}

// ---- schemas -----------------------------------------------------------------------------

/** Backend enums are validated loosely: an unexpected value is kept as a string, not rejected. */
const looseEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.string()]).nullish();

const nullishString = z.string().nullish();
const nullishNumber = z.number().nullish();

export const orderItemSchema = z.looseObject({
  refType: nullishString,
  refId: z.union([z.string(), z.number()]).nullish(),
  name: nullishString,
  type: nullishString,
  price: nullishNumber,
  origPrice: nullishNumber,
  qty: nullishNumber,
  variantIndex: nullishNumber,
  variantLabel: nullishString,
});
export type OrderItem = z.infer<typeof orderItemSchema>;

export const orderPaymentSchema = z.looseObject({
  method: looseEnum(paymentMethods),
  status: looseEnum(paymentStatuses),
  paidAt: nullishString,
  refundedAt: nullishString,
  lastError: nullishString,
  transactionId: nullishString,
});

export const orderCustomerSchema = z.looseObject({
  name: nullishString,
  phone: nullishString,
  email: nullishString,
  instagram: nullishString,
  note: nullishString,
});

export const orderDealerSchema = z.looseObject({
  shopName: nullishString,
  contact: nullishString,
  phone: nullishString,
  deliveryDate: nullishString,
  note: nullishString,
});

export const orderShippingInfoSchema = z.looseObject({
  address: nullishString,
  storeName: nullishString,
  pickupDate: nullishString,
  trackingNo: nullishString,
});

export const orderSchema = z.looseObject({
  orderId: z.string(),
  orderType: looseEnum(orderTypes),
  createdAt: nullishString,
  updatedAt: nullishString,
  status: looseEnum(orderStatuses),
  payment: orderPaymentSchema.nullish(),
  subtotal: nullishNumber,
  shipping: nullishNumber,
  totalAmount: nullishNumber,
  couponCode: nullishString,
  couponDiscount: nullishNumber,
  items: z.array(orderItemSchema).nullish(),
  shippingMethod: looseEnum(shippingMethods),
  shippingInfo: orderShippingInfoSchema.nullish(),
  adminNote: nullishString,
  groupBuy: z.looseObject({ slug: nullishString, name: nullishString }).nullish(),
  customer: orderCustomerSchema.nullish(),
  dealer: orderDealerSchema.nullish(),
});
export type Order = z.infer<typeof orderSchema>;

export const paginationSchema = z.looseObject({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  pages: z.number(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const ordersListResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  orders: z.array(orderSchema),
  pagination: paginationSchema,
});
export type OrdersListResponse = z.infer<typeof ordersListResponseSchema>;

export const orderResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  order: orderSchema,
});

export const productVariantSchema = z.looseObject({
  label: nullishString,
  price: nullishNumber,
  stock: nullishNumber,
  trackStock: z.boolean().nullish(),
});

export const productSchema = z.looseObject({
  productId: z.union([z.number(), z.string()]),
  name: z.string(),
  sub: nullishString,
  price: nullishNumber,
  orig: nullishNumber,
  type: looseEnum(productTypes),
  isBulk: z.boolean().nullish(),
  active: z.boolean().nullish(),
  stock: nullishNumber,
  lowStockThreshold: nullishNumber,
  trackStock: z.boolean().nullish(),
  variants: z.array(productVariantSchema).nullish(),
  endsAt: nullishString,
  badge: nullishString,
});
export type Product = z.infer<typeof productSchema>;

export const productsResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  products: z.array(productSchema),
});

/** Addon shape is not documented; keep whatever the backend sends. */
export const lowStockAddonSchema = z.looseObject({
  name: nullishString,
  stock: nullishNumber,
  lowStockThreshold: nullishNumber,
});
export type LowStockAddon = z.infer<typeof lowStockAddonSchema>;

export const lowStockResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  products: z.array(productSchema),
  addons: z.array(lowStockAddonSchema).default([]),
  total: z.number().optional(),
});
export type LowStockResponse = z.infer<typeof lowStockResponseSchema>;

export const statsSchema = z.looseObject({
  catalog: z
    .looseObject({
      products: nullishNumber,
      bundlesPublic: nullishNumber,
      bundlesDealer: nullishNumber,
      addons: nullishNumber,
    })
    .nullish(),
  today: z.looseObject({ orders: nullishNumber, revenue: nullishNumber }).nullish(),
  month: z.looseObject({ revenue: nullishNumber }).nullish(),
  pendingShipping: nullishNumber,
  lowStockCount: nullishNumber,
  members: nullishNumber,
  dealers: nullishNumber,
  activeGroupBuys: nullishNumber,
  activeCoupons: nullishNumber,
  statusBreakdown: z.record(z.string(), z.number()).nullish(),
});
export type Stats = z.infer<typeof statsSchema>;

export const statsResponseSchema = z.looseObject({
  success: z.boolean().optional(),
  stats: statsSchema,
});

export const loginResponseSchema = z.looseObject({
  token: z.string().min(1),
  user: z.unknown().optional(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

// ---- request params ----------------------------------------------------------------------

export interface ListOrdersParams {
  page?: number;
  /** Clamped to 1–100 by the client. */
  limit?: number;
  status?: OrderStatus;
  orderType?: OrderType;
  paymentStatus?: PaymentStatus;
  paymentMethod?: PaymentMethod;
  /** ISO with timezone; filters createdAt, inclusive. */
  dateFrom?: string;
  dateTo?: string;
  /** Fuzzy: orderId, customer name, IG, email, dealer shop name. */
  q?: string;
}
