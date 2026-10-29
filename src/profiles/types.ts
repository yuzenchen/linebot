import type { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { GrokGateway } from '../grok/gateway.js';
import type { TextMessageContext } from '../handlers/dispatcher.js';
import type { HealthChecker } from '../health/check.js';
import type { JobQueue } from '../jobs/queue.js';
import type { Replier } from '../line/replier.js';

export type ProfileName = Config['BOT_PROFILE'];

/** Infrastructure both profiles share; built once in `server.ts` `main()`. */
export interface Shared {
  config: Config;
  repos: Repos;
  replier: Replier;
  jobs: JobQueue;
  grok: GrokGateway;
  health: HealthChecker;
  logger: Logger;
}

/** What a deployable bot variant plugs into the shared webhook / dispatcher / server. */
export interface BotProfile {
  name: ProfileName;
  /** Text-message handler passed to the dispatcher. Must never reject. */
  handleText: (ctx: TextMessageContext) => Promise<void>;
  /** Reply sent on `follow`. */
  welcomeText: () => string;
  /** Extra Hono routes (e.g. `/grok/callback`); mounted inside `createApp`. */
  extraRoutes?: (app: Hono) => void;
  /** Called once the HTTP server is listening (job handlers, sweepers). */
  start?: () => void | Promise<void>;
  /** Called on shutdown before the job queue stops. */
  stop?: () => Promise<void>;
}
