import { describe, expect, it, vi } from 'vitest';
import { createAdminNotifier, fallbackReason } from '../../src/notify/adminNotifier.js';
import { harness, pushReasons, sentTexts, silent } from '../handlers/helpers.js';

const URL_ = 'http://linebot-admin:8090/internal/notify';
const ADMIN = 'Uadmin000000';

function fakeFetch(impl: () => Promise<Response>) {
  return vi.fn<typeof fetch>(async () => impl());
}

function setup(
  config: {
    ADMIN_NOTIFY_URL?: string;
    INTERNAL_NOTIFY_TOKEN?: string;
    ADMIN_LINE_USER_ID?: string;
  },
  fetchImpl?: typeof fetch,
) {
  const h = harness();
  const notifier = createAdminNotifier({ config, replier: h.replier, fetchImpl, log: silent });
  return { ...h, notifier };
}

describe('createAdminNotifier', () => {
  it('relays to the admin bot with the internal token and JSON body', async () => {
    const f = fakeFetch(async () => new Response('{"ok":true}', { status: 200 }));
    const s = setup(
      { ADMIN_NOTIFY_URL: URL_, INTERNAL_NOTIFY_TOKEN: 'tkn', ADMIN_LINE_USER_ID: ADMIN },
      f,
    );
    const r = await s.notifier.notify({
      kind: 'incident',
      text: '網站異常',
      meta: { userId: 'U1' },
    });
    expect(r).toBe('relayed');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['x-internal-token']).toBe('tkn');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'incident', text: '網站異常', meta: { userId: 'U1' } });
    expect(typeof body.sentAt).toBe('string');
    expect(s.api.pushMessage).not.toHaveBeenCalled();
    expect(pushReasons(s.db)).toEqual([]);
  });

  it('falls back to a direct push when the relay answers 500', async () => {
    const f = fakeFetch(async () => new Response('boom', { status: 500 }));
    const s = setup(
      { ADMIN_NOTIFY_URL: URL_, INTERNAL_NOTIFY_TOKEN: 'tkn', ADMIN_LINE_USER_ID: ADMIN },
      f,
    );
    expect(await s.notifier.notify({ kind: 'incident', text: 'x' })).toBe('pushed');
    expect(pushReasons(s.db)).toEqual(['admin_incident']);
    expect(sentTexts(s.api)).toEqual([{ via: 'push', text: 'x' }]);
  });

  it('falls back on a network error', async () => {
    const f = fakeFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const s = setup(
      { ADMIN_NOTIFY_URL: URL_, INTERNAL_NOTIFY_TOKEN: 'tkn', ADMIN_LINE_USER_ID: ADMIN },
      f,
    );
    expect(await s.notifier.notify({ kind: 'handoff', text: 'x' })).toBe('pushed');
    expect(pushReasons(s.db)).toEqual(['admin_handoff']);
  });

  it('falls back on a relay timeout', async () => {
    const f = vi.fn<typeof fetch>(
      (_u, init) =>
        new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener('abort', () => rej(init.signal?.reason)),
        ),
    );
    const h = harness();
    const notifier = createAdminNotifier({
      config: { ADMIN_NOTIFY_URL: URL_, INTERNAL_NOTIFY_TOKEN: 'tkn', ADMIN_LINE_USER_ID: ADMIN },
      replier: h.replier,
      fetchImpl: f,
      timeoutMs: 20,
      log: silent,
    });
    expect(await notifier.notify({ kind: 'triage', text: 'x' })).toBe('pushed');
    expect(pushReasons(h.db)).toEqual(['admin_triage']);
  });

  it('does not relay without a token', async () => {
    const f = fakeFetch(async () => new Response('', { status: 200 }));
    const s = setup({ ADMIN_NOTIFY_URL: URL_, ADMIN_LINE_USER_ID: ADMIN }, f);
    expect(await s.notifier.notify({ kind: 'forward', text: 'x' })).toBe('pushed');
    expect(f).not.toHaveBeenCalled();
    expect(pushReasons(s.db)).toEqual(['admin_forward']);
  });

  it('only logs without URL and admin id', async () => {
    const s = setup({});
    expect(await s.notifier.notify({ kind: 'incident', text: 'x' })).toBe('logged');
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('never rejects, even when relay and push both fail', async () => {
    const f = fakeFetch(async () => {
      throw new Error('down');
    });
    const s = setup(
      { ADMIN_NOTIFY_URL: URL_, INTERNAL_NOTIFY_TOKEN: 'tkn', ADMIN_LINE_USER_ID: ADMIN },
      f,
    );
    s.api.pushMessage.mockRejectedValue(new Error('line down'));
    await expect(s.notifier.notify({ kind: 'service_question', text: 'x' })).resolves.toBe(
      'logged',
    );
  });

  it('maps kinds to the pre-T13 push_log reasons', () => {
    expect(fallbackReason('incident')).toBe('admin_incident');
    expect(fallbackReason('handoff')).toBe('admin_handoff');
    expect(fallbackReason('forward')).toBe('admin_forward');
    expect(fallbackReason('service_question')).toBe('admin_service_question');
    expect(fallbackReason('triage')).toBe('admin_triage');
  });
});
