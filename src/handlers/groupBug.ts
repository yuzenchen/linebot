import type { webhook } from '@line/bot-sdk';
import type { Logger } from 'pino';
import { displayBugId } from '../bugs/ids.js';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import { now as clockNow } from '../db/time.js';
import type { HealthChecker } from '../health/check.js';
import type { JobQueue } from '../jobs/queue.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { texts } from '../texts.js';
import type { GroupTextContext } from './dispatcher.js';

/** §13.3 step 5: the same reporter + description within this window is not reported again. */
export const BUG_DEDUPE_WINDOW_MS = 60_000;

export interface GroupBugHandlerDeps {
  repos: Pick<Repos, 'bugReports' | 'adminQueries'>;
  replier: Pick<Replier, 'replyOrPush'>;
  health: HealthChecker;
  jobs: Pick<JobQueue, 'enqueue'>;
  config: Pick<Config, 'GROUP_COMMAND_USER_IDS'>;
  now?: () => Date;
  log?: Logger;
}

type SelfMentionee = webhook.UserMentionee & { isSelf: true };

function isSelfMention(m: webhook.Mentionee): m is SelfMentionee {
  return m.type === 'user' && (m as webhook.UserMentionee).isSelf === true;
}

/**
 * Removes every span that tags this bot (by `index` / `length`, applied right to left so earlier
 * offsets stay valid) and trims. Other mentionees stay in the text.
 */
export function stripSelfMentions(text: string, mentionees: webhook.Mentionee[]): string {
  const spans = mentionees
    .filter(isSelfMention)
    .filter((m) => Number.isInteger(m.index) && Number.isInteger(m.length) && m.index >= 0)
    .sort((a, b) => b.index - a.index);
  let out = text;
  for (const m of spans) {
    const start = Math.min(m.index, out.length);
    const end = Math.min(m.index + Math.max(m.length, 0), out.length);
    out = out.slice(0, start) + out.slice(end);
  }
  return out.trim();
}

/**
 * SPEC-ADMIN §13.2–13.3: in a group / room, an allowlisted sender (`GROUP_COMMAND_USER_IDS`)
 * tagging this bot reports a website bug to Grok. Everything else is logged and ignored (no reply).
 * Group replies never carry order or personal data; progress is DMed to the reporter by the job /
 * callback / sweeper. Never rejects.
 */
export function createGroupBugHandler(deps: GroupBugHandlerDeps) {
  const { repos, replier, health, jobs } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? clockNow;
  const allow = new Set(deps.config.GROUP_COMMAND_USER_IDS);

  return async function handleGroupText(ctx: GroupTextContext): Promise<void> {
    const meta = { groupId: ctx.groupId, sourceType: ctx.sourceType };
    if (allow.size === 0) {
      log.info(meta, 'group message ignored (GROUP_COMMAND_USER_IDS empty)');
      return;
    }
    if (!ctx.mentionees.some(isSelfMention)) {
      log.debug(meta, 'group message ignored (bot not tagged)');
      return;
    }
    if (!ctx.userId || !allow.has(ctx.userId)) {
      log.info({ ...meta, hasUserId: Boolean(ctx.userId) }, 'group tag ignored (not allowlisted)');
      return;
    }
    const reporter = ctx.userId;
    const started = now().getTime();

    // Replies go to the group; a reply-token failure falls back to a push to the same group.
    const reply = (text: string, reason: string) =>
      replier.replyOrPush(ctx.replyToken, ctx.groupId, [text], reason);

    try {
      const description = stripSelfMentions(ctx.text, ctx.mentionees);
      if (!description) {
        await reply(texts.groupBugHelp, 'group_bug_help');
        log.info(meta, 'group bug tag without description');
        return;
      }

      const dup = repos.bugReports.findRecentDuplicate(
        reporter,
        description,
        BUG_DEDUPE_WINDOW_MS,
        now(),
      );
      if (dup) {
        const display = displayBugId(dup.id);
        const replyText = texts.groupBugDuplicate(display);
        await reply(replyText, 'group_bug_duplicate');
        audit(reporter, ctx.text, dup.id, 'duplicate', replyText, started);
        log.info({ ...meta, bugId: dup.id }, 'group bug duplicate within window');
        return;
      }

      const result = await health.check();
      const bugId = repos.bugReports.insert(
        { reporterUserId: reporter, groupId: ctx.groupId, description, health: result },
        now(),
      );
      jobs.enqueue('bug_report', {
        bugId,
        reporterUserId: reporter,
        description,
        health: result,
      });
      const display = displayBugId(bugId);
      const replyText = texts.groupBugAccepted(display);
      audit(reporter, ctx.text, bugId, 'queued', replyText, started);
      log.info({ ...meta, bugId, health: result.status }, 'group bug report queued');
      try {
        await reply(replyText, 'group_bug_accepted');
      } catch (err) {
        // Already queued: a "busy" fallback here would be wrong; the reporter still gets DMs.
        log.error({ ...meta, bugId, err }, 'group bug accepted reply failed');
      }
    } catch (err) {
      log.error({ ...meta, err }, 'group bug handler failed');
      try {
        await reply(texts.fallbackError, 'group_bug_error');
      } catch (replyErr) {
        log.error({ ...meta, err: replyErr }, 'group bug fallback reply failed');
      }
    }
  };

  /** One `admin_queries` row per accepted / duplicate report (SPEC-ADMIN §4 audit trail). */
  function audit(
    userId: string,
    text: string,
    bugId: number,
    result: 'queued' | 'duplicate',
    reply: string,
    started: number,
  ): void {
    try {
      repos.adminQueries.insert({
        userId,
        text,
        tools: JSON.stringify([{ name: 'bug_report', bugId, result }]),
        reply,
        piiRevealed: false,
        latencyMs: Math.max(0, now().getTime() - started),
      });
    } catch (err) {
      log.error({ err, bugId }, 'group bug audit insert failed');
    }
  }
}
