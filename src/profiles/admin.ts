import Anthropic from '@anthropic-ai/sdk';
import { createEshopClient, createTokenProvider } from '../eshop/index.js';
import { startGrokTaskSweeper, type GrokTaskSweeper } from '../grok/sweeper.js';
import { createAdminTextHandler } from '../handlers/admin.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { createDirectAdminNotifier } from '../notify/directAdminNotifier.js';
import { createInternalNotifyRoute } from '../notify/internalRoute.js';
import { texts } from '../texts.js';
import { JOB_MAX_ATTEMPTS, mountGrokCallback } from './enduser.js';
import type { BotProfile, Shared } from './types.js';

/**
 * Internal admin bot (SPEC-ADMIN.md, ADMIN-HANDLER-DESIGN.md): allowlist, Claude tool-use loop
 * over the read-only eshop client, `incident_triage` jobs + Grok callback / sweeper whose admin
 * notices go straight to every `ADMIN_USER_IDS` member.
 */
export function createAdminProfile(shared: Shared): BotProfile {
  const { config, repos, replier, jobs, grok, health, logger } = shared;

  const tokenProvider = createTokenProvider({
    baseUrl: config.ESHOP_API_BASE,
    // config validation guarantees both when BOT_PROFILE=admin
    username: config.ESHOP_BOT_USERNAME ?? '',
    password: config.ESHOP_BOT_PASSWORD ?? '',
    log: logger,
  });
  const eshop = createEshopClient({ baseUrl: config.ESHOP_API_BASE, tokenProvider, log: logger });
  const model = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const adminNotifier = createDirectAdminNotifier({
    adminUserIds: config.ADMIN_USER_IDS,
    replier,
    log: logger,
  });
  const handlers = createJobHandlers({
    repos,
    replier,
    grok,
    config,
    adminNotifier,
    maxAttempts: JOB_MAX_ATTEMPTS,
  });
  const handleText = createAdminTextHandler({
    repos,
    replier,
    health,
    jobs,
    grok,
    eshop,
    model,
    config,
    log: logger,
  });
  let sweeper: GrokTaskSweeper | undefined;

  return {
    name: 'admin',
    handleText,
    welcomeText: () => texts.adminWelcome,
    extraRoutes: (app) => {
      mountGrokCallback(app, {
        token: config.GROK_CALLBACK_TOKEN,
        repos,
        replier,
        config,
        adminNotifier,
      });
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
    start: () => {
      jobs.start(handlers);
      logger.info('job queue started');
      if (grok.configured) {
        sweeper = startGrokTaskSweeper({ repos, replier, config, adminNotifier });
        logger.info({ timeoutMs: config.GROK_TASK_TIMEOUT_MS }, 'grok task sweeper started');
      }
    },
    stop: async () => {
      sweeper?.stop();
    },
  };
}
