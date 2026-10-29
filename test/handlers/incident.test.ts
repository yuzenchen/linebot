import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetClock, setClock } from '../../src/db/time.js';
import { createIncidentHandler, INCIDENT_MERGE_WINDOW_MS } from '../../src/handlers/incident.js';
import { adminIncidentNotice, texts } from '../../src/texts.js';
import {
  fakeHealth,
  harness,
  healthResult,
  inbound,
  incidentRows,
  jobRows,
  pushReasons,
  silent,
  type Harness,
} from './helpers.js';

const ADMIN = 'Uadmin000000000000000000000000000';

function make(
  h: Harness,
  health: ReturnType<typeof fakeHealth>,
  config: { ADMIN_LINE_USER_ID?: string; GROK_WEBHOOK_URL?: string } = {},
  log = silent,
) {
  return createIncidentHandler({
    repos: h.repos,
    replier: h.replier,
    health,
    jobs: h.jobs,
    config,
    log,
  });
}

describe('incident handler', () => {
  afterEach(() => resetClock());

  it('healthy: follow-up questions, incident row, no admin push, no triage without Grok', async () => {
    const h = harness();
    const handle = make(h, fakeHealth(healthResult({ status: 'healthy', httpStatus: 200 })), {
      ADMIN_LINE_USER_ID: ADMIN,
    });
    const msgs = await handle(inbound(h.repos, '購物車按了沒反應'));
    expect(msgs).toEqual([texts.incidentHealthyFollowUp]);
    const rows = incidentRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'U1', health_status: 'healthy', admin_notified: 0 });
    expect(JSON.parse(rows[0].health_raw as string)).toMatchObject({ httpStatus: 200 });
    expect(h.api.pushMessage).not.toHaveBeenCalled();
    expect(jobRows(h.db)).toHaveLength(0);
  });

  it('healthy with GROK_WEBHOOK_URL set enqueues incident_triage', async () => {
    const h = harness();
    const handle = make(h, fakeHealth(healthResult({ status: 'healthy', httpStatus: 200 })), {
      GROK_WEBHOOK_URL: 'https://grok.example.test/hook',
    });
    const ctx = inbound(h.repos, '購物車按了沒反應');
    await handle(ctx, [{ role: 'user', text: 'hi' }]);
    const jobs = jobRows(h.db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe('incident_triage');
    expect(jobs[0].payload).toMatchObject({
      userId: 'U1',
      incidentId: incidentRows(h.db)[0].id,
      text: '購物車按了沒反應',
      health: { status: 'healthy' },
      context: [{ role: 'user', text: 'hi' }],
    });
    expect(h.api.pushMessage).not.toHaveBeenCalled();
  });

  it('degraded with admin: user confirmation, one admin push, merge window of 10 minutes', async () => {
    let t = Date.parse('2026-10-29T10:00:00.000Z');
    setClock(() => new Date(t));
    const h = harness();
    const result = healthResult({
      status: 'degraded',
      httpStatus: 503,
      body: { status: 'error', db: 'x' },
    });
    const handle = make(h, fakeHealth(result), { ADMIN_LINE_USER_ID: ADMIN });

    const msgs1 = await handle(inbound(h.repos, '網站打不開'));
    expect(msgs1).toEqual([texts.incidentConfirmed]);
    expect(h.api.pushMessage).toHaveBeenCalledTimes(1);
    const adminReq = h.api.pushMessage.mock.calls[0][0];
    expect(adminReq.to).toBe(ADMIN);
    expect(adminReq.messages[0].text).toBe(
      adminIncidentNotice({ userId: 'U1', text: '網站打不開', health: result }),
    );
    expect(adminReq.messages[0].text).toContain('degraded 503');
    expect(adminReq.messages[0].text).toContain('"db":"x"');
    expect(pushReasons(h.db)).toEqual(['admin_incident']);
    expect(incidentRows(h.db)[0].admin_notified).toBe(1);
    expect(jobRows(h.db).map((j) => j.type)).toEqual(['incident_triage']);

    // Second report one minute later from another user: user still answered, admin not pinged.
    t += 60_000;
    const msgs2 = await handle(inbound(h.repos, '還是打不開', { userId: 'U2' }));
    expect(msgs2).toEqual([texts.incidentConfirmed]);
    expect(h.api.pushMessage).toHaveBeenCalledTimes(1);
    expect(incidentRows(h.db)).toHaveLength(2);
    expect(incidentRows(h.db)[1].admin_notified).toBe(0);
    expect(jobRows(h.db).map((j) => j.type)).toEqual(['incident_triage', 'incident_triage']);

    // Third report after the window: admin pinged again.
    t += INCIDENT_MERGE_WINDOW_MS + 60_000;
    await handle(inbound(h.repos, '又掛了'));
    expect(h.api.pushMessage).toHaveBeenCalledTimes(2);
    expect(pushReasons(h.db)).toEqual(['admin_incident', 'admin_incident']);
    expect(incidentRows(h.db)[2].admin_notified).toBe(1);
  });

  it('merge window is per status: a down report after a degraded one notifies admin', async () => {
    const h = harness();
    const degraded = fakeHealth(healthResult({ status: 'degraded', httpStatus: 503 }));
    await make(h, degraded, { ADMIN_LINE_USER_ID: ADMIN })(inbound(h.repos, 'a'));
    const down = fakeHealth(healthResult({ status: 'down', error: 'TimeoutError' }));
    await make(h, down, { ADMIN_LINE_USER_ID: ADMIN })(inbound(h.repos, 'b'));
    expect(h.api.pushMessage).toHaveBeenCalledTimes(2);
  });

  it('down without admin id: no push, warn logged, triage still enqueued', async () => {
    const h = harness();
    const warn = vi.fn();
    const log = pino({ level: 'silent' });
    log.warn = warn as unknown as typeof log.warn;
    const handle = make(
      h,
      fakeHealth(healthResult({ status: 'down', error: 'TypeError: fetch failed' })),
      {},
      log,
    );
    const msgs = await handle(inbound(h.repos, '網站打不開'));
    expect(msgs).toEqual([texts.incidentConfirmed]);
    expect(h.api.pushMessage).not.toHaveBeenCalled();
    expect(h.repos.pushLog.countMonth()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ userId: 'U1' });
    expect(String(warn.mock.calls[0][0].notice)).toContain('fetch failed');
    expect(incidentRows(h.db)[0]).toMatchObject({ health_status: 'down', admin_notified: 0 });
    expect(jobRows(h.db).map((j) => j.type)).toEqual(['incident_triage']);
  });
});
