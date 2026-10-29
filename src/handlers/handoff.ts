import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import { now as clockNow } from '../db/time.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { type AdminNotifier, createAdminNotifier } from '../notify/adminNotifier.js';
import {
  adminForwardNotice,
  adminHandoffDone,
  adminHandoffNotice,
  adminPrefixMismatch,
  adminResumeDone,
  adminStatus,
  texts,
} from '../texts.js';
import type { TextMessageContext } from './dispatcher.js';
import type { HandoffHook } from './message.js';

/** Any of these in a user message enters handoff before classification (SPEC 5.7). */
export const HANDOFF_KEYWORDS = [
  '真人',
  '客服人員',
  '人工客服',
  '轉人工',
  '找專人',
  '專人處理',
] as const;
export const HANDOFF_DURATION_MS = 24 * 60 * 60 * 1000;
/** Consecutive `confidence < MIN_CONFIDENCE` messages that trigger handoff. */
export const LOW_CONF_STREAK_LIMIT = 2;

const RECENT_INBOUND = 3;
const RECENT_SCAN = 20;

export interface HandoffDeps {
  repos: Pick<Repos, 'users' | 'messages' | 'pushLog' | 'jobs'> & Partial<Pick<Repos, 'grokTasks'>>;
  replier: Replier;
  config: Pick<Config, 'ADMIN_LINE_USER_ID'> &
    Partial<Pick<Config, 'ADMIN_NOTIFY_URL' | 'INTERNAL_NOTIFY_TOKEN'>>;
  /** Defaults to one built from `config` + `replier`. */
  adminNotifier?: AdminNotifier;
  now?: () => Date;
  log?: Logger;
}

/** SPEC 5.7 human handoff and admin commands. No method throws on admin push failure. */
export function createHandoffService(deps: HandoffDeps) {
  const { repos, replier, config } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? clockNow;
  // Admin *notices* go through the AdminNotifier (relayed to the admin bot when configured, T13).
  // Admin *commands* (/status, /resume, /handoff) stay on this enduser bot because its DB owns the
  // handoff state; they are still authorised by ADMIN_LINE_USER_ID.
  const adminId = config.ADMIN_LINE_USER_ID;
  const notifier = deps.adminNotifier ?? createAdminNotifier({ config, replier, log: deps.log });

  async function pushUser(userId: string, text: string, reason: string) {
    try {
      await replier.push(userId, [text], reason);
    } catch (err) {
      log.error({ userId, reason, err }, 'user push failed');
    }
  }

  function recentInbound(userId: string): string[] {
    return repos.messages
      .recent(userId, RECENT_SCAN)
      .filter((m) => m.direction === 'in' && m.type === 'text' && m.text !== null)
      .slice(-RECENT_INBOUND)
      .map((m) => m.text as string);
  }

  function startHandoff(userId: string): void {
    const until = new Date(now().getTime() + HANDOFF_DURATION_MS).toISOString();
    repos.users.setHandoffUntil(userId, until);
    repos.users.resetLowConf(userId);
  }

  /** Enters handoff, notifies admin, and returns the messages to send to the user. */
  async function enter(userId: string, reason: string): Promise<string[]> {
    startHandoff(userId);
    log.info({ userId, reason }, 'handoff entered');
    await notifier.notify({
      kind: 'handoff',
      text: adminHandoffNotice({ userId, reason, recentMessages: recentInbound(userId) }),
      meta: { userId },
    });
    return [texts.handoffEntered];
  }

  const hook: HandoffHook = {
    isActive(userId: string): boolean {
      const until = repos.users.get(userId)?.handoff_until;
      if (!until) return false;
      if (new Date(until).getTime() > now().getTime()) return true;
      repos.users.setHandoffUntil(userId, null);
      log.info({ userId, until }, 'handoff expired');
      return false;
    },
    async forward(ctx: TextMessageContext): Promise<void> {
      try {
        log.info({ userId: ctx.userId, messageId: ctx.messageId }, 'handoff: forwarding to admin');
        await notifier.notify({
          kind: 'forward',
          text: adminForwardNotice({ userId: ctx.userId, text: ctx.text }),
          meta: { userId: ctx.userId, messageId: ctx.messageId },
        });
      } catch (err) {
        log.error({ userId: ctx.userId, err }, 'handoff forward failed');
      }
    },
  };

  function isAdmin(userId: string): boolean {
    return adminId !== undefined && adminId !== '' && userId === adminId;
  }

  /** Resolves an id prefix to exactly one user, or replies with the mismatch count. */
  function resolvePrefix(prefix: string): { userId: string } | { error: string } {
    const matches = repos.users.findByPrefix(prefix);
    if (matches.length === 1) return { userId: matches[0].user_id };
    return { error: adminPrefixMismatch(prefix, matches.length) };
  }

  async function handleAdminCommand(ctx: TextMessageContext): Promise<void> {
    const [rawCmd, arg] = ctx.text.trim().split(/\s+/, 2);
    const cmd = rawCmd.toLowerCase();
    const replyAdmin = (text: string) =>
      replier.replyOrPush(ctx.replyToken, ctx.userId, [text], 'admin_command');
    log.info({ cmd }, 'admin command');

    if (cmd === '/status') {
      const at = now();
      await replyAdmin(
        adminStatus({
          messagesToday: repos.messages.countToday(at),
          pushesThisMonth: repos.pushLog.countMonth(at),
          pendingJobs: repos.jobs.countPending(),
          inHandoff: repos.users.listInHandoff(at).length,
          grokWaiting: repos.grokTasks?.countOpen(),
        }),
      );
      return;
    }

    if ((cmd === '/resume' || cmd === '/handoff') && arg) {
      const r = resolvePrefix(arg);
      if ('error' in r) {
        await replyAdmin(r.error);
        return;
      }
      if (cmd === '/resume') {
        repos.users.setHandoffUntil(r.userId, null);
        log.info({ userId: r.userId }, 'handoff resumed by admin');
        await replyAdmin(adminResumeDone(r.userId));
        await pushUser(r.userId, texts.handoffResumed, 'handoff_resumed');
      } else {
        startHandoff(r.userId);
        log.info({ userId: r.userId }, 'handoff entered by admin');
        await replyAdmin(adminHandoffDone(r.userId));
        await pushUser(r.userId, texts.handoffEntered, 'handoff_admin');
      }
      return;
    }

    await replyAdmin(texts.adminHelp);
  }

  return {
    hook,
    shouldEnterByKeyword(text: string): boolean {
      return HANDOFF_KEYWORDS.some((k) => text.includes(k));
    },
    enter,
    /** After classification: enters handoff when the low-confidence streak hits the limit. */
    async afterClassification(userId: string): Promise<string[]> {
      const streak = repos.users.get(userId)?.low_conf_streak ?? 0;
      if (streak < LOW_CONF_STREAK_LIMIT) return [];
      return enter(userId, '連續低信心');
    },
    isAdmin,
    handleAdminCommand,
  };
}

export type HandoffService = ReturnType<typeof createHandoffService>;
