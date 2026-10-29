import type { Hono } from 'hono';
import { createClassifierFromConfig } from '../classifier/index.js';
import { createGrokCallbackRoute, type GrokCallbackDeps } from '../grok/callback.js';
import { startGrokTaskSweeper, type GrokTaskSweeper } from '../grok/sweeper.js';
import { defaultWelcomeText } from '../handlers/dispatcher.js';
import { createHandoffService } from '../handlers/handoff.js';
import { createTextMessageHandler } from '../handlers/message.js';
import { createJobHandlers } from '../jobs/handlers.js';
import { createAdminNotifier } from '../notify/adminNotifier.js';
import type { BotProfile, Shared } from './types.js';

export const JOB_MAX_ATTEMPTS = 5;

/** Mounts `POST /grok/callback`; shared by both profiles (admin uses Grok for `incident_triage`). */
export function mountGrokCallback(app: Hono, deps: GrokCallbackDeps): void {
  app.route('/grok/callback', createGrokCallbackRoute(deps));
}

/** Customer-facing bot (SPEC.md): classifier pipeline, handoff, job handlers, Grok sweeper. */
export function createEnduserProfile(shared: Shared): BotProfile {
  const { config, repos, replier, jobs, grok, health, logger } = shared;
  const classifier = createClassifierFromConfig();
  // One notifier for every admin notice: relays to the admin bot when ADMIN_NOTIFY_URL is set (T13).
  const adminNotifier = createAdminNotifier({ config, replier, log: logger });
  const handlers = createJobHandlers({
    repos,
    replier,
    grok,
    config,
    adminNotifier,
    maxAttempts: JOB_MAX_ATTEMPTS,
  });
  const handoffService = createHandoffService({ repos, replier, config, adminNotifier });
  const handleText = createTextMessageHandler({
    repos,
    replier,
    classifier,
    health,
    jobs,
    config,
    handoffService,
    adminNotifier,
  });
  let sweeper: GrokTaskSweeper | undefined;

  return {
    name: 'enduser',
    handleText,
    welcomeText: defaultWelcomeText,
    extraRoutes: (app) =>
      mountGrokCallback(app, {
        token: config.GROK_CALLBACK_TOKEN,
        repos,
        replier,
        config,
        adminNotifier,
      }),
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
