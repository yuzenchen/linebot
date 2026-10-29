import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number; version: string };
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.version).toBe('string');
  });
});
