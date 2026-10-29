import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
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

  it('answers allowlisted users with the placeholder text (every listed id, trimmed)', async () => {
    const { repos, api, profile } = setup();
    await profile.handleText(inbound(repos, '今天幾筆訂單', { userId: 'Uadmin1' }));
    await profile.handleText(inbound(repos, '庫存', { userId: 'Uadmin2' }));
    expect(sentTexts(api).map((s) => s.text)).toEqual([
      texts.adminPlaceholder,
      texts.adminPlaceholder,
    ]);
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
      profile.handleText(inbound(repos, 'hi', { userId: 'Uadmin1' })),
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
