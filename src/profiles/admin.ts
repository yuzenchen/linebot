import type { TextMessageContext } from '../handlers/dispatcher.js';
import { createInternalNotifyRoute } from '../notify/internalRoute.js';
import { texts } from '../texts.js';
import { mountGrokCallback } from './enduser.js';
import type { BotProfile, Shared } from './types.js';

/**
 * Internal admin bot (SPEC-ADMIN.md). T10 placeholder: allowlist check only;
 * T12b replaces `handleText` with the Claude tool-use conversation handler.
 */
export function createAdminProfile(shared: Shared): BotProfile {
  const { config, repos, replier, logger } = shared;
  const allow = new Set(config.ADMIN_USER_IDS);

  async function handleText(ctx: TextMessageContext): Promise<void> {
    try {
      if (!allow.has(ctx.userId)) {
        logger.info({ userId: ctx.userId }, 'admin bot: rejected non-allowlisted user');
        await replier.replyOrPush(ctx.replyToken, ctx.userId, [texts.adminOnly], 'admin_only');
        return;
      }
      await replier.replyOrPush(
        ctx.replyToken,
        ctx.userId,
        [texts.adminPlaceholder],
        'admin_placeholder',
      );
    } catch (err) {
      logger.error({ err, userId: ctx.userId }, 'admin bot: failed to reply');
    }
  }

  return {
    name: 'admin',
    handleText,
    welcomeText: () => texts.adminWelcome,
    extraRoutes: (app) => {
      mountGrokCallback(app, { token: config.GROK_CALLBACK_TOKEN, repos, replier, config });
      // T13: notices relayed from the enduser bot; reachable only inside the docker network.
      app.route(
        '/internal/notify',
        createInternalNotifyRoute({
          token: config.INTERNAL_NOTIFY_TOKEN,
          adminUserIds: config.ADMIN_USER_IDS,
          replier,
          log: logger,
        }),
      );
    },
  };
}
