import { describe, expect, it } from 'vitest';
import { displayId, parseTicketId } from '../../src/tickets/ids.js';
import { extractOrderIds } from '../../src/tickets/orderIds.js';

describe('ticket ids', () => {
  it('displayId zero-pads to three digits and keeps longer ids', () => {
    expect(displayId(1)).toBe('T001');
    expect(displayId(42)).toBe('T042');
    expect(displayId(999)).toBe('T999');
    expect(displayId(1234)).toBe('T1234');
  });

  it('parseTicketId accepts T42 / t042 / 42 and rejects the rest', () => {
    expect(parseTicketId('T42')).toBe(42);
    expect(parseTicketId('t042')).toBe(42);
    expect(parseTicketId('42')).toBe(42);
    expect(parseTicketId(' T7 ')).toBe(7);
    expect(parseTicketId('T0')).toBeNull();
    expect(parseTicketId('TT42')).toBeNull();
    expect(parseTicketId('T42a')).toBeNull();
    expect(parseTicketId('')).toBeNull();
    expect(parseTicketId('回覆')).toBeNull();
  });
});

describe('extractOrderIds', () => {
  it('normalises to a leading # and uppercase, keeps the D / G prefix, dedupes in order', () => {
    expect(
      extractOrderIds('訂單 20261029-vxjg7azy 和 #20261029-VXJG7AZY，還有 D20261030-ABCD1234'),
    ).toEqual(['#20261029-VXJG7AZY', '#D20261030-ABCD1234']);
    expect(extractOrderIds('#G20261030-ZZZZ9999')).toEqual(['#G20261030-ZZZZ9999']);
  });

  it('ignores partial or over-long ids and returns [] when none', () => {
    expect(extractOrderIds('沒有訂單')).toEqual([]);
    expect(extractOrderIds('2026102-VXJG7AZY')).toEqual([]);
    expect(extractOrderIds('20261029-VXJG7AZ')).toEqual([]);
    expect(extractOrderIds('20261029-VXJG7AZY9')).toEqual([]);
    expect(extractOrderIds('X20261029-VXJG7AZY')).toEqual([]);
  });
});
