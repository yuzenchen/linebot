/**
 * LINE delivery for the staff bot. Everything goes through `Replier` (one use per reply token,
 * push fallback, `push_log`). Long texts are packed into messages of at most `MAX_TEXT_LENGTH`
 * characters, split on line breaks, and sent in batches of `MAX_MESSAGES` so nothing is
 * truncated: the first batch uses the reply token, later batches are pushed.
 *
 * Notification helpers never throw: a failed push to one recipient is logged and the next
 * recipient is still tried.
 */
import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import { MAX_MESSAGES, MAX_TEXT_LENGTH, type Replier } from '../line/replier.js';

/** Packs lines into texts of at most `max` characters (a longer single line is hard-split). */
export function packLines(lines: string[], max = MAX_TEXT_LENGTH): string[] {
  const out: string[] = [];
  let current = '';
  let has = false;
  const flush = () => {
    if (has) out.push(current);
    current = '';
    has = false;
  };
  for (const line of lines) {
    let rest = line;
    while (rest.length > max) {
      flush();
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const candidate = has ? `${current}\n${rest}` : rest;
    if (candidate.length > max) {
      flush();
      current = rest;
    } else {
      current = candidate;
    }
    has = true;
  }
  flush();
  return out;
}

function batches<T>(items: T[], size = MAX_MESSAGES): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface StaffMessengerDeps {
  replier: Pick<Replier, 'reply' | 'push' | 'replyOrPush'>;
  repos: Pick<Repos, 'users'>;
  adminUserIds: readonly string[];
  log: Logger;
}

export function createStaffMessenger(deps: StaffMessengerDeps) {
  const { replier, repos, log } = deps;

  /** Pushes every line (packed + batched) to `to`. Throws on the first failed push. */
  async function pushLines(to: string, lines: string[], reason: string): Promise<void> {
    for (const batch of batches(packLines(lines))) await replier.push(to, batch, reason);
  }

  /** Same as `pushLines`, but returns false instead of throwing. */
  async function tryPush(to: string, lines: string[], reason: string): Promise<boolean> {
    try {
      await pushLines(to, lines, reason);
      return true;
    } catch (err) {
      log.warn({ reason, err: errSummary(err) }, 'staff push failed');
      return false;
    }
  }

  /**
   * Answers `to` (a user or group): first batch via the reply token (or push without one), the
   * rest pushed. Throws when LINE fails (the caller sends the fallback).
   */
  async function answer(
    replyToken: string | undefined,
    to: string,
    lines: string[],
    reason: string,
  ): Promise<void> {
    const [first, ...rest] = batches(packLines(lines));
    if (!first) return;
    await replier.replyOrPush(replyToken, to, first, reason);
    for (const batch of rest) await replier.push(to, batch, reason);
  }

  /** True when the user is known to have unfollowed / blocked the bot (no push attempt). */
  function knownUnfollowed(userId: string): boolean {
    const row = repos.users.get(userId);
    return row !== undefined && row.followed === 0;
  }

  /**
   * DMs a user. Returns false (logged) when the user unfollowed or LINE rejects the push —
   * typically because they never added the bot as a friend.
   */
  async function dm(userId: string, lines: string[], reason: string): Promise<boolean> {
    if (knownUnfollowed(userId)) return false;
    return tryPush(userId, lines, reason);
  }

  /** DMs every admin (optionally skipping one, e.g. the one already answered). */
  async function notifyAdmins(lines: string[], reason: string, except?: string): Promise<void> {
    for (const adminId of deps.adminUserIds) {
      if (adminId === except) continue;
      await tryPush(adminId, lines, reason);
    }
  }

  /**
   * DMs the applicant; when that fails and a group is known, posts `groupText` there instead.
   */
  async function dmOrGroup(
    userId: string,
    text: string,
    groupId: string | null,
    groupText: string,
    reason: string,
  ): Promise<'dm' | 'group' | 'none'> {
    if (await dm(userId, [text], reason)) return 'dm';
    if (groupId && (await tryPush(groupId, [groupText], `${reason}_group`))) return 'group';
    return 'none';
  }

  return { pushLines, tryPush, answer, dm, notifyAdmins, dmOrGroup };
}

export type StaffMessenger = ReturnType<typeof createStaffMessenger>;

function errSummary(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const e = err as { name?: string; message?: string; status?: number };
  return { name: e.name, message: e.message, status: e.status };
}
