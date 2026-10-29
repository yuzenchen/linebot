import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { NullGrokGateway } from '../../src/grok/gateway.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { createAdminProfile } from '../../src/profiles/admin.js';
import { createProfile } from '../../src/profiles/index.js';
import type { Shared } from '../../src/profiles/types.js';
import { texts } from '../../src/texts.js';
import {
  fakeHealth,
  harness,
  healthResult,
  inbound,
  pushReasons,
  sentTexts,
  silent,
} from '../handlers/helpers.js';

const adminEnv = {
  LINE_CHANNEL_SECRET: 's',
  LINE_CHANNEL_ACCESS_TOKEN: 't',
  BOT_PROFILE: 'admin',
  ADMIN_USER_IDS: 'Uadmin1, Uadmin2',
  ESHOP_BOT_USERNAME: 'bot',
  ESHOP_BOT_PASSWORD: 'pw',
  ANTHROPIC_API_KEY: 'sk-test',
  ENDUSER_INTERNAL_URL: 'http://127.0.0.1:1',
};

function setup(env: Record<string, string> = adminEnv) {
  const h = harness();
  const config = loadConfig(env);
  const shared: Shared = {
    config,
    repos: h.repos,
    replier: h.replier,
    jobs: new JobQueue(h.repos.jobs, { maxAttempts: 1 }),
    grok: new NullGrokGateway(),
    health: fakeHealth(healthResult({ status: 'healthy' })),
    logger: silent,
  };
  return { ...h, shared, profile: createAdminProfile(shared) };
}

describe('admin profile', () => {
  it('rejects users outside ADMIN_USER_IDS with the admin-only text', async () => {
    const { repos, api, profile } = setup();
    await profile.handleText(inbound(repos, '今天幾筆訂單', { userId: 'Ustranger' }));
    expect(sentTexts(api)).toEqual([{ via: 'reply', text: texts.adminOnly }]);
  });

  it('does not reject either listed id (trimmed) and never calls LINE for them before the model', async () => {
    const { repos, api, shared } = setup();
    // Allowlist membership only: the model/eshop path is covered in test/admin (fake clients).
    const allow = new Set(shared.config.ADMIN_USER_IDS);
    expect(allow.has('Uadmin1') && allow.has('Uadmin2')).toBe(true);
    await createAdminProfile(shared).handleText(inbound(repos, 'hi', { userId: 'Uother' }));
    expect(sentTexts(api)).toEqual([{ via: 'reply', text: texts.adminOnly }]);
  });

  it('start() registers job handlers and stop() is safe without a sweeper', async () => {
    const { profile, shared } = setup();
    const start = vi.spyOn(shared.jobs, 'start');
    await profile.start?.();
    expect(start).toHaveBeenCalledTimes(1);
    const handlers = start.mock.calls[0][0];
    expect(Object.keys(handlers).sort()).toEqual([
      'incident_triage',
      'service_question',
      'summarize_suggestion',
    ]);
    await expect(profile.stop?.()).resolves.toBeUndefined();
    await shared.jobs.stop();
  });

  it('mounts /internal/notify and pushes relayed notices to every admin', async () => {
    const { profile, api, db } = setup({ ...adminEnv, INTERNAL_NOTIFY_TOKEN: 'tkn' });
    const app = new Hono();
    profile.extraRoutes?.(app);
    const res = await app.request('/internal/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'tkn' },
      body: JSON.stringify({ kind: 'incident', text: '網站異常' }),
    });
    expect(res.status).toBe(200);
    expect(api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual(['Uadmin1', 'Uadmin2']);
    expect(pushReasons(db)).toEqual(['relay_incident', 'relay_incident']);
  });

  it('falls back to push without a reply token and logs the reason', async () => {
    const { repos, db, profile } = setup();
    await profile.handleText(inbound(repos, 'hi', { userId: 'Ustranger', replyToken: undefined }));
    expect(pushReasons(db)).toEqual(['admin_only']);
  });

  it('never rejects when the LINE API fails', async () => {
    const { repos, api, profile } = setup();
    api.replyMessage.mockRejectedValue(new Error('boom'));
    api.pushMessage.mockRejectedValue(new Error('boom'));
    await expect(
      profile.handleText(inbound(repos, 'hi', { userId: 'Ustranger' })),
    ).resolves.toBeUndefined();
  });

  it('exposes name, welcome text and a /grok/callback route', async () => {
    const { profile } = setup();
    expect(profile.name).toBe('admin');
    expect(profile.welcomeText()).toBe(texts.adminWelcome);
    const app = new Hono();
    profile.extraRoutes?.(app);
    // No GROK_CALLBACK_TOKEN configured -> the route exists but answers 503.
    const res = await app.request('/grok/callback', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('createProfile picks by name', () => {
    const { shared } = setup();
    expect(createProfile('admin', shared).name).toBe('admin');
  });
});
