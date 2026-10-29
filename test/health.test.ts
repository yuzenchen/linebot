import { describe, expect, it } from 'vitest';
import { createRepos } from '../src/db/repos.js';
import { createApp } from '../src/server.js';
import { memoryDb } from './db/helpers.js';

describe('GET /health', () => {
  it('returns 200 with status ok and the default profile', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      uptime: number;
      version: string;
      profile: string;
    };
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.version).toBe('string');
    expect(body.profile).toBe('enduser');
  });

  it('reports the profile passed in deps and mounts extraRoutes', async () => {
    const repos = createRepos(memoryDb());
    const app = createApp({
      channelSecret: 'secret',
      repos,
      dispatch: async () => {},
      profile: 'admin',
      extraRoutes: (a) => a.get('/extra', (c) => c.text('yes')),
    });
    const body = (await (await app.request('/health')).json()) as { profile: string };
    expect(body.profile).toBe('admin');
    expect(await (await app.request('/extra')).text()).toBe('yes');
    // Without a grok callback route the fallback answers 503.
    expect((await app.request('/grok/callback', { method: 'POST' })).status).toBe(503);
  });
});
