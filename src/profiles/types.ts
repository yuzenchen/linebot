import type { Database } from 'better-sqlite3';
import type { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { GrokGateway } from '../grok/gateway.js';
import type {
  GroupImageContext,
  GroupTextContext,
  ImageMessageContext,
  TextMessageContext,
} from '../handlers/dispatcher.js';
import type { HealthChecker } from '../health/check.js';
import type { JobQueue } from '../jobs/queue.js';
import type { LineBlobApi } from '../line/client.js';
import type { Replier } from '../line/replier.js';

export type ProfileName = Config['BOT_PROFILE'];

/** Infrastructure every profile shares; built once in `server.ts` `main()`. */
export interface Shared {
  config: Config;
  /** The SQLite connection behind `repos` (the staff profile builds its own service on it). */
  db: Database;
  repos: Repos;
  replier: Replier;
  jobs: JobQueue;
  grok: GrokGateway;
  health: HealthChecker;
  logger: Logger;
  /** LINE content download (admin images, SPEC-ADMIN §16); the admin profile builds one if absent. */
  lineBlob?: LineBlobApi;
}

/** What a deployable bot variant plugs into the shared webhook / dispatcher / server. */
export interface BotProfile {
  name: ProfileName;
  /** Text-message handler passed to the dispatcher. Must never reject. */
  handleText: (ctx: TextMessageContext) => Promise<void>;
  /** Group / room text handler (admin: SPEC-ADMIN §13; staff: SPEC-STAFF §4–6); absent → groups are ignored. Must never reject. */
  handleGroupText?: (ctx: GroupTextContext) => Promise<void>;
  /** DM image handler (admin: SPEC-ADMIN §16); absent → fixed non-text reply. Must never reject. */
  handleImage?: (ctx: ImageMessageContext) => Promise<void>;
  /** Group / room image handler (admin: SPEC-ADMIN §16); absent → ignored. Must never reject. */
  handleGroupImage?: (ctx: GroupImageContext) => Promise<void>;
  /** Reply sent on `follow`. */
  welcomeText: () => string;
  /** Extra Hono routes (e.g. `/grok/callback`); mounted inside `createApp`. */
  extraRoutes?: (app: Hono) => void;
  /** Called once the HTTP server is listening (job handlers, sweepers). */
  start?: () => void | Promise<void>;
  /** Called on shutdown before the job queue stops. */
  stop?: () => Promise<void>;
}
