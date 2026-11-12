import type { webhook } from '@line/bot-sdk';
import type { Logger } from 'pino';
import type { EnduserClient } from '../admin/enduserClient.js';
import { type ImageAttacher, withImages } from '../admin/images.js';
import { type AdminModelClient, type AdminRunResult, runAdminQuery } from '../admin/loop.js';
import { GROUP_PROMPT } from '../admin/prompt.js';
import { createToolExecutor, GROUP_TOOL_DEFS, GROUP_TOOL_NAMES } from '../admin/tools.js';
import { displayBugId } from '../bugs/ids.js';
import type { ContextMessage } from '../classifier/types.js';
import type { Config } from '../config.js';
import type { QueryUsage } from '../db/adminQueries.js';
import type { Repos } from '../db/repos.js';
import { now as clockNow } from '../db/time.js';
import type { EshopClient } from '../eshop/index.js';
import type { GrokGateway } from '../grok/gateway.js';
import type { HealthChecker } from '../health/check.js';
import type { JobQueue } from '../jobs/queue.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { texts } from '../texts.js';
import { DEADLINE, raceDeadline, splitReply, toModelMessages } from './admin.js';
import type { GroupTextContext } from './dispatcher.js';

/** §13.3 step 5: the same reporter + description within this window is not reported again. */
export const BUG_DEDUPE_WINDOW_MS = 60_000;

/** SPEC-ADMIN §14.2: `/bug` or full-width `／bug` at the very start, any case, not `/bugfix`. */
const BUG_COMMAND_RE = /^[/／]bug(?![a-z])/i;

export interface GroupHandlerDeps {
  repos: Pick<
    Repos,
    'bugReports' | 'adminQueries' | 'groupContext' | 'incidents' | 'pendingConfirmations'
  >;
  replier: Pick<Replier, 'replyOrPush'>;
  health: HealthChecker;
  jobs: Pick<JobQueue, 'enqueue'>;
  grok: Pick<GrokGateway, 'configured'>;
  eshop: EshopClient;
  /** Ticket reads only (`list_tickets` / `get_ticket`). */
  enduser: Pick<EnduserClient, 'getTicket' | 'listOpenTickets'>;
  model: AdminModelClient;
  /** SPEC-ADMIN §16: the sender's pending images in this group; absent → text only. */
  images?: ImageAttacher;
  config: Pick<
    Config,
    | 'GROUP_COMMAND_USER_IDS'
    | 'ADMIN_MODEL'
    | 'ADMIN_MAX_TOOL_ROUNDS'
    | 'REPLY_DEADLINE_MS'
    | 'CONTEXT_MESSAGES'
    | 'CONFIRMATION_TTL_MS'
  >;
  now?: () => Date;
  log?: Logger;
  /** Tests: per-request model timeout. */
  requestTimeoutMs?: number;
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
 * §14.2: for already stripped + trimmed text, the bug description after a leading `/bug` (trimmed,
 * possibly empty), or null when the text is not a `/bug` command.
 */
export function parseBugCommand(text: string): string | null {
  const m = BUG_COMMAND_RE.exec(text);
  return m ? text.slice(m[0].length).trim() : null;
}

/**
 * SPEC-ADMIN §13–§14: in a group / room, an allowlisted sender (`GROUP_COMMAND_USER_IDS`) tagging
 * this bot either reports a website bug (`/bug …`, no model call) or asks a read-only question
 * answered by the admin tool-use loop with `GROUP_TOOL_DEFS`. Everything else is logged and
 * ignored (no reply). DM ticket shortcuts never apply here. Never rejects.
 */
export function createGroupHandler(deps: GroupHandlerDeps) {
  const { repos, replier, health, jobs, config } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? clockNow;
  const allow = new Set(config.GROUP_COMMAND_USER_IDS);

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
    const sender = ctx.userId;
    const started = now().getTime();

    // Replies go to the group; the reply token is used at most once, then pushes to the group.
    let tokenUsed = ctx.replyToken === undefined;
    const send = async (msgs: string[], reason: string, opts?: { recordAs?: string[] }) => {
      const token = tokenUsed ? undefined : ctx.replyToken;
      tokenUsed = true;
      await replier.replyOrPush(token, ctx.groupId, msgs, reason, opts);
    };

    try {
      const stripped = stripSelfMentions(ctx.text, ctx.mentionees);
      if (!stripped) {
        audit(sender, ctx.text, [{ name: 'group_help' }], texts.groupHelp, false, started);
        await send([texts.groupHelp], 'group_help');
        log.info(meta, 'group tag without text');
        return;
      }
      const bugDescription = parseBugCommand(stripped);
      if (bugDescription !== null) {
        await reportBug(bugDescription);
        return;
      }
      await answerQuery(stripped);
    } catch (err) {
      log.error({ ...meta, err }, 'group handler failed');
      try {
        await send([texts.groupBugError], 'group_error');
      } catch (replyErr) {
        log.error({ ...meta, err: replyErr }, 'group fallback reply failed');
      }
    }

    /** §14.3 step 2 (= §13.3 steps 3–5). Never calls the model; never enters group context. */
    async function reportBug(description: string): Promise<void> {
      if (!description) {
        audit(sender, ctx.text, [{ name: 'bug_help' }], texts.groupBugHelp, false, started);
        await send([texts.groupBugHelp], 'group_bug_help');
        log.info(meta, 'group /bug without description');
        return;
      }

      const dup = repos.bugReports.findRecentDuplicate(
        sender,
        description,
        BUG_DEDUPE_WINDOW_MS,
        now(),
      );
      if (dup) {
        const replyText = texts.groupBugDuplicate(displayBugId(dup.id));
        await send([replyText], 'group_bug_duplicate');
        audit(
          sender,
          ctx.text,
          [{ name: 'bug_report', bugId: dup.id, result: 'duplicate' }],
          replyText,
          false,
          started,
        );
        log.info({ ...meta, bugId: dup.id }, 'group bug duplicate within window');
        return;
      }

      const result = await health.check();
      const bugId = repos.bugReports.insert(
        { reporterUserId: sender, groupId: ctx.groupId, description, health: result },
        now(),
      );
      jobs.enqueue('bug_report', { bugId, reporterUserId: sender, description, health: result });
      const replyText = texts.groupBugAccepted(displayBugId(bugId));
      audit(
        sender,
        ctx.text,
        [{ name: 'bug_report', bugId, result: 'queued' }],
        replyText,
        false,
        started,
      );
      log.info({ ...meta, bugId, health: result.status }, 'group bug report queued');
      try {
        await send([replyText], 'group_bug_accepted');
      } catch (err) {
        // Already queued: a "failed" fallback here would be wrong; the reporter still gets DMs.
        log.error({ ...meta, bugId, err }, 'group bug accepted reply failed');
      }
    }

    /** §14.3 steps 3–6: read-only admin loop, group context, deadline ack + push to the group. */
    async function answerQuery(query: string): Promise<void> {
      const context = buildContext(ctx.groupId);
      const inId = repos.groupContext.insert({
        groupId: ctx.groupId,
        userId: sender,
        direction: 'in',
        text: query,
      });
      const executor = createToolExecutor({
        eshop: deps.eshop,
        health,
        repos,
        jobs,
        grok: deps.grok,
        enduser: deps.enduser,
        confirmationTtlMs: config.CONFIRMATION_TTL_MS,
        userId: sender,
        userText: query,
        messageId: inId,
        context,
        allowedTools: GROUP_TOOL_NAMES,
        now,
        log,
      });
      // §16.2 steps 2–3: only this sender's pending images in this group; `/bug` and help never
      // get here, so they leave them for the next query.
      let imageCount = 0;
      let imageFailed = 0;
      const run = (async () => {
        let messages = toModelMessages(query, context);
        if (deps.images) {
          const prepared = await deps.images.take(sender, ctx.groupId);
          imageCount = prepared.blocks.length;
          imageFailed = prepared.failed;
          messages = withImages(messages, prepared.blocks);
        }
        return runAdminQuery({
          client: deps.model,
          executor,
          messages,
          config,
          userId: sender,
          now,
          log,
          requestTimeoutMs: deps.requestTimeoutMs,
          tools: GROUP_TOOL_DEFS,
          systemAddendum: GROUP_PROMPT,
          imageCount,
        });
      })();

      const raced = await raceDeadline(run, config.REPLY_DEADLINE_MS);
      let result: AdminRunResult;
      if (raced === DEADLINE) {
        log.info({ ...meta, deadlineMs: config.REPLY_DEADLINE_MS }, 'group reply deadline hit');
        if (!tokenUsed) await send([texts.adminAckPending], 'group_ack');
        result = await run;
      } else {
        result = raced;
      }

      const stored = result.piiRevealed ? texts.adminPiiRecordPlaceholder : result.text;
      const replyText = imageFailed > 0 ? `${texts.adminImageFailed}\n${result.text}` : result.text;
      const audited = result.piiRevealed ? texts.adminPiiRecordPlaceholder : replyText;
      audit(sender, ctx.text, result.tools, audited, result.piiRevealed, started, {
        imageCount,
        usage: result.usage,
        model: result.servedBy,
      });
      log.info(
        {
          ...meta,
          userId: sender,
          imageCount,
          imageFailed,
          outcome: result.outcome,
          rounds: result.rounds,
          tools: result.tools.map((t) => t.name),
          piiRevealed: result.piiRevealed,
          latencyMs: now().getTime() - started,
          servedBy: result.servedBy,
        },
        'group query done',
      );

      const opts = result.piiRevealed ? { recordAs: [texts.adminPiiRecordPlaceholder] } : undefined;
      await send(splitReply(replyText), 'group_late_reply', opts);
      repos.groupContext.insert({ groupId: ctx.groupId, direction: 'out', text: stored });
    }
  };

  function buildContext(groupId: string): ContextMessage[] {
    return repos.groupContext
      .recent(groupId, config.CONTEXT_MESSAGES)
      .map((r) => ({ role: r.direction === 'in' ? 'user' : 'assistant', text: r.text }));
  }

  /** One `admin_queries` row per handled tag (SPEC-ADMIN §14.3 step 6). Best effort. */
  function audit(
    userId: string,
    text: string,
    tools: unknown[],
    reply: string,
    piiRevealed: boolean,
    started: number,
    model?: { imageCount: number; usage: QueryUsage; model?: string },
  ): void {
    try {
      repos.adminQueries.insert({
        userId,
        text,
        tools: JSON.stringify(tools),
        reply,
        piiRevealed,
        latencyMs: Math.max(0, now().getTime() - started),
        ...model,
      });
    } catch (err) {
      log.error({ err, userId }, 'group audit insert failed');
    }
  }
}
