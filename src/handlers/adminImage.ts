import type { Logger } from 'pino';
import { DM_CONVERSATION, IMAGE_ACK_BURST_MS, MAX_PENDING_IMAGES } from '../admin/images.js';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { texts } from '../texts.js';
import type { GroupImageContext, ImageMessageContext } from './dispatcher.js';

export interface AdminImageHandlerDeps {
  repos: Pick<Repos, 'pendingImages'>;
  replier: Pick<Replier, 'replyOrPush'>;
  config: Pick<Config, 'ADMIN_USER_IDS' | 'GROUP_COMMAND_USER_IDS'>;
  now?: () => Date;
  log?: Logger;
}

/**
 * SPEC-ADMIN §16.2 step 1: records allowlisted images as pending (LINE message id only, nothing is
 * downloaded here). DM: one `adminImageReceived` per burst — an image within `IMAGE_ACK_BURST_MS`
 * of this user's previous pending DM image (e.g. the rest of a LINE image set) is not acknowledged
 * again. Group: silent. Both handlers never reject.
 */
export function createAdminImageHandlers(deps: AdminImageHandlerDeps) {
  const { repos, replier, config } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => new Date());
  const dmAllow = new Set(config.ADMIN_USER_IDS);
  const groupAllow = new Set(config.GROUP_COMMAND_USER_IDS);

  async function handleImage(ctx: ImageMessageContext): Promise<void> {
    const { userId, replyToken } = ctx;
    try {
      if (!dmAllow.has(userId)) {
        log.info({ userId }, 'admin bot: rejected image from non-allowlisted user');
        await replier.replyOrPush(replyToken, userId, [texts.adminOnly], 'admin_only');
        return;
      }
      const t = now();
      // Check before insert; no await in between, so concurrent events of one burst see each other.
      const previous = repos.pendingImages.newestAt(userId, DM_CONVERSATION);
      const inBurst = previous !== null && t.getTime() - previous.getTime() < IMAGE_ACK_BURST_MS;
      repos.pendingImages.add({
        userId,
        conversation: DM_CONVERSATION,
        lineMessageId: ctx.lineMessageId,
        contentProvider: ctx.contentProvider,
        now: t,
        keep: MAX_PENDING_IMAGES,
      });
      log.info({ userId, inBurst }, 'admin image pending');
      if (inBurst) return;
      await replier.replyOrPush(replyToken, userId, [texts.adminImageReceived], 'admin_image');
    } catch (err) {
      log.error({ userId, err }, 'admin image handling failed');
      try {
        await replier.replyOrPush(replyToken, userId, [texts.fallbackError], 'fallback_error');
      } catch (fallbackErr) {
        log.error({ userId, err: fallbackErr }, 'fallback reply failed');
      }
    }
  }

  async function handleGroupImage(ctx: GroupImageContext): Promise<void> {
    const meta = { groupId: ctx.groupId, sourceType: ctx.sourceType };
    try {
      if (!ctx.userId || !groupAllow.has(ctx.userId)) {
        log.debug({ ...meta, hasUserId: Boolean(ctx.userId) }, 'group image ignored');
        return;
      }
      repos.pendingImages.add({
        userId: ctx.userId,
        conversation: ctx.groupId,
        lineMessageId: ctx.lineMessageId,
        contentProvider: ctx.contentProvider,
        now: now(),
        keep: MAX_PENDING_IMAGES,
      });
      log.info({ ...meta, userId: ctx.userId }, 'group image pending');
    } catch (err) {
      // Group images never get a reply (§16.2 step 1), not even on failure.
      log.error({ ...meta, err }, 'group image handling failed');
    }
  }

  return { handleImage, handleGroupImage };
}
