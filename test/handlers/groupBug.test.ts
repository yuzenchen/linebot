import type { webhook } from '@line/bot-sdk';
import { describe, expect, it } from 'vitest';
import type { GroupTextContext } from '../../src/handlers/dispatcher.js';
import { createGroupBugHandler, stripSelfMentions } from '../../src/handlers/groupBug.js';
import { texts } from '../../src/texts.js';
import {
  fakeHealth,
  harness,
  healthResult,
  jobRows,
  pushReasons,
  sentTexts,
  silent,
} from './helpers.js';

const OWNER = 'Uowner000001';
const OTHER = 'Uother000002';
const GROUP = 'Cgroup0001';
const T0 = new Date('2026-11-02T08:00:00.000Z');

const self = (index: number, length: number): webhook.UserMentionee => ({
  type: 'user',
  index,
  length,
  isSelf: true,
  userId: 'Ubot',
});
const other = (index: number, length: number): webhook.UserMentionee => ({
  type: 'user',
  index,
  length,
  userId: 'Usomeone',
});

function setup(allow: string[] = [OWNER], clock: { t: Date } = { t: T0 }) {
  const h = harness();
  const health = fakeHealth(healthResult({ status: 'healthy' }));
  const handle = createGroupBugHandler({
    repos: h.repos,
    replier: h.replier,
    health,
    jobs: h.jobs,
    config: { GROUP_COMMAND_USER_IDS: allow },
    now: () => clock.t,
    log: silent,
  });
  let n = 0;
  const ctx = (
    text: string,
    mentionees: webhook.Mentionee[],
    userId: string | null = OWNER,
  ): GroupTextContext => {
    n += 1;
    return {
      groupId: GROUP,
      sourceType: 'group',
      userId: userId ?? undefined,
      text,
      mentionees,
      replyToken: `tok-${n}`,
      event: {} as webhook.MessageEvent,
    };
  };
  const bugRows = () =>
    h.db.prepare('SELECT * FROM bug_reports ORDER BY id').all() as {
      id: number;
      reporter_user_id: string;
      group_id: string;
      description: string;
      health_raw: string;
      status: string;
      created_at: string;
    }[];
  return { ...h, health, handle, ctx, bugRows, clock };
}

describe('stripSelfMentions', () => {
  it('removes only isSelf spans by index / length and trims', () => {
    const text = '@小幫手 @Amy 結帳頁 @小幫手 壞了';
    // '@小幫手' = 4 code units at 0 and 14; '@Amy' at 5.
    expect(stripSelfMentions(text, [self(0, 4), other(5, 4), self(14, 4)])).toBe(
      '@Amy 結帳頁  壞了',
    );
    expect(stripSelfMentions('@bot', [self(0, 4)])).toBe('');
    expect(stripSelfMentions('壞了 @bot', [self(3, 4)])).toBe('壞了');
  });

  it('clamps out-of-range spans', () => {
    expect(stripSelfMentions('abc @bot', [self(4, 99)])).toBe('abc');
  });
});

describe('group bug handler', () => {
  it('allowlisted tag: bug row, bug_report job, accepted reply in the group, audit row', async () => {
    const s = setup();
    await s.handle(s.ctx('@bot 結帳頁按 LINE Pay 沒反應', [self(0, 4)]));

    const rows = s.bugRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      reporter_user_id: OWNER,
      group_id: GROUP,
      description: '結帳頁按 LINE Pay 沒反應',
      status: 'queued',
      created_at: T0.toISOString(),
    });
    expect(JSON.parse(rows[0]!.health_raw)).toMatchObject({ status: 'healthy' });
    expect(s.health.check).toHaveBeenCalledTimes(1);

    expect(jobRows(s.db)).toEqual([
      {
        type: 'bug_report',
        status: 'pending',
        payload: {
          bugId: 1,
          reporterUserId: OWNER,
          description: '結帳頁按 LINE Pay 沒反應',
          health: expect.objectContaining({ status: 'healthy' }),
        },
      },
    ]);
    expect(s.api.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok-1',
      messages: [{ type: 'text', text: texts.groupBugAccepted('B001') }],
    });
    expect(s.api.pushMessage).not.toHaveBeenCalled();

    const audit = s.repos.adminQueries.recent(5);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: OWNER, pii_revealed: 0 });
    expect(JSON.parse(audit[0]!.tools!)).toEqual([
      { name: 'bug_report', bugId: 1, result: 'queued' },
    ]);
  });

  it('a tag from a non-allowlisted sender (or without userId) sends nothing', async () => {
    const s = setup();
    await s.handle(s.ctx('@bot 網站壞了', [self(0, 4)], OTHER));
    await s.handle(s.ctx('@bot 網站壞了', [self(0, 4)], null));
    expect(sentTexts(s.api)).toEqual([]);
    expect(s.bugRows()).toHaveLength(0);
    expect(jobRows(s.db)).toHaveLength(0);
    expect(s.health.check).not.toHaveBeenCalled();
  });

  it('an allowlisted sender without tagging the bot (or tagging someone else) sends nothing', async () => {
    const s = setup();
    await s.handle(s.ctx('網站壞了', []));
    await s.handle(s.ctx('@Amy 網站壞了', [other(0, 4)]));
    expect(sentTexts(s.api)).toEqual([]);
    expect(s.bugRows()).toHaveLength(0);
  });

  it('empty description after stripping replies the help text and opens nothing', async () => {
    const s = setup();
    await s.handle(s.ctx('  @bot  ', [self(2, 4)]));
    expect(sentTexts(s.api)).toEqual([{ via: 'reply', text: texts.groupBugHelp }]);
    expect(s.bugRows()).toHaveLength(0);
    expect(jobRows(s.db)).toHaveLength(0);
  });

  it('strips multiple self mentions but keeps other mentionees', async () => {
    const s = setup();
    await s.handle(s.ctx('@bot @Amy 首頁 @bot 圖片破圖', [self(0, 4), other(5, 4), self(13, 4)]));
    expect(s.bugRows()[0]!.description).toBe('@Amy 首頁  圖片破圖');
  });

  it('dedupes the same reporter + description within 60 s', async () => {
    const s = setup();
    await s.handle(s.ctx('@bot 購物車清空', [self(0, 4)]));
    s.clock.t = new Date(T0.getTime() + 59_000);
    await s.handle(s.ctx('@bot   購物車清空', [self(0, 4)]));
    expect(s.bugRows()).toHaveLength(1);
    expect(jobRows(s.db)).toHaveLength(1);
    expect(sentTexts(s.api)).toEqual([
      { via: 'reply', text: texts.groupBugAccepted('B001') },
      { via: 'reply', text: texts.groupBugDuplicate('B001') },
    ]);

    // A different description, or the same one after the window, opens a new report.
    await s.handle(s.ctx('@bot 會員頁 500', [self(0, 4)]));
    s.clock.t = new Date(T0.getTime() + 61_000);
    await s.handle(s.ctx('@bot 購物車清空', [self(0, 4)]));
    expect(s.bugRows().map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('is off when GROUP_COMMAND_USER_IDS is empty', async () => {
    const s = setup([]);
    await s.handle(s.ctx('@bot 網站壞了', [self(0, 4)]));
    expect(sentTexts(s.api)).toEqual([]);
    expect(s.bugRows()).toHaveLength(0);
  });

  it('falls back to a push to the group when there is no reply token', async () => {
    const s = setup();
    const c = s.ctx('@bot 網站壞了', [self(0, 4)]);
    await s.handle({ ...c, replyToken: undefined });
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([GROUP]);
    expect(pushReasons(s.db)).toEqual(['group_bug_accepted']);
  });

  it('never rejects when LINE fails; the report stays queued', async () => {
    const s = setup();
    s.api.replyMessage.mockRejectedValue(new Error('boom'));
    s.api.pushMessage.mockRejectedValue(new Error('boom'));
    await expect(s.handle(s.ctx('@bot 網站壞了', [self(0, 4)]))).resolves.toBeUndefined();
    expect(s.bugRows()).toHaveLength(1);
  });
});
