import type Anthropic from '@anthropic-ai/sdk';
import { vi } from 'vitest';
import {
  EnduserClientError,
  type EnduserClient,
  type TicketDetail,
  type TicketSummary,
} from '../../src/admin/enduserClient.js';
import type { AdminModelClient } from '../../src/admin/loop.js';
import type { EshopClient } from '../../src/eshop/index.js';
import { orderSchema, type Order } from '../../src/eshop/types.js';
import { sampleOrder } from '../eshop/helpers.js';

export type ScriptItem =
  Partial<Anthropic.Beta.BetaMessage> | Error | (() => Promise<Anthropic.Beta.BetaMessage>);

export interface ModelCall {
  params: Anthropic.Beta.MessageCreateParamsNonStreaming;
  options?: Anthropic.RequestOptions;
}

/** Fills in the fields a `BetaMessage` always has. */
export function message(partial: Partial<Anthropic.Beta.BetaMessage>): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    } as unknown as Anthropic.Beta.BetaUsage,
    ...partial,
  } as Anthropic.Beta.BetaMessage;
}

export function text(t: string): Anthropic.Beta.BetaTextBlock {
  return { type: 'text', text: t, citations: null };
}

export function toolUse(id: string, name: string, input: unknown): Anthropic.Beta.BetaToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

export function endTurn(t: string): Partial<Anthropic.Beta.BetaMessage> {
  return { stop_reason: 'end_turn', content: [text(t)] };
}

export function toolTurn(
  ...calls: Anthropic.Beta.BetaToolUseBlock[]
): Partial<Anthropic.Beta.BetaMessage> {
  return { stop_reason: 'tool_use', content: calls };
}

/** Scripted `beta.messages.create`; records every call (deep-cloned params). */
export function fakeModel(script: ScriptItem[]) {
  const calls: ModelCall[] = [];
  const client: AdminModelClient = {
    beta: {
      messages: {
        create: async (params, options) => {
          calls.push({ params: structuredClone(params), options });
          const next = script.shift();
          if (next === undefined) throw new Error('model script exhausted');
          if (next instanceof Error) throw next;
          return typeof next === 'function' ? next() : message(next);
        },
      },
    },
  };
  return { client, calls };
}

export type FakeEshop = { [K in keyof EshopClient]: ReturnType<typeof vi.fn<EshopClient[K]>> };

export function order(over: Record<string, unknown> = {}): Order {
  return orderSchema.parse(sampleOrder(over));
}

export function fakeEshop(): FakeEshop {
  return {
    listOrders: vi.fn(async () => ({
      orders: [order()],
      pagination: { page: 1, limit: 10, total: 1, pages: 1 },
    })),
    getOrder: vi.fn(async () => order()),
    listProducts: vi.fn(async () => []),
    lowStock: vi.fn(async () => ({ products: [], addons: [], total: 0 })),
    stats: vi.fn(async () => ({
      today: { orders: 3, revenue: 1280 },
      month: { revenue: 56000 },
      pendingShipping: 2,
      lowStockCount: 1,
    })),
  };
}

export type FakeEnduser = {
  [K in keyof EnduserClient]: ReturnType<typeof vi.fn<EnduserClient[K]>>;
};

export function ticketSummary(over: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 1,
    display: 'T001',
    userIdShort: 'U6037873…',
    question: '我的訂單什麼時候出貨',
    orderIds: ['#20261029-VXJG7AZY'],
    status: 'open',
    createdAt: '2026-10-29T17:12:00.000Z',
    updatedAt: '2026-10-29T17:12:00.000Z',
    ...over,
  };
}

export function ticketDetail(over: Partial<TicketDetail> = {}): TicketDetail {
  return {
    ...ticketSummary(),
    context: ['昨天訂的', '我的訂單什麼時候出貨'],
    answeredBy: null,
    answer: null,
    answeredAt: null,
    ...over,
  };
}

/** In-memory enduser client: one open ticket T001 by default. */
export function fakeEnduser(): FakeEnduser {
  return {
    listOpenTickets: vi.fn(async () => [ticketSummary()]),
    getTicket: vi.fn(async (id: number) => {
      if (id !== 1) throw new EnduserClientError('not_found', '找不到這張工單', 404);
      return ticketDetail();
    }),
    replyTicket: vi.fn(async (id: number) => ({
      ok: true as const,
      pushed: true as const,
      ticketId: id,
      userIdShort: 'U6037873…',
    })),
    closeTicket: vi.fn(async () => {}),
  };
}

/** A pending promise the test resolves by hand. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const LIST_ORDERS_INPUT = {
  status: null,
  paymentStatus: 'pending',
  paymentMethod: null,
  orderType: null,
  dateFrom: '2026-10-30T00:00:00+08:00',
  dateTo: '2026-10-30T23:59:59+08:00',
  q: null,
  page: null,
  limit: 1,
  reveal_pii: false,
};
