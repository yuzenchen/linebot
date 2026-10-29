import { MEMORY, openDatabase } from '../../src/db/index.js';

/** Fresh in-memory DB with migrations applied. Env is set so config/logger never throw. */
export function memoryDb() {
  process.env.LINE_CHANNEL_SECRET ??= 'test-secret';
  process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'test-token';
  process.env.LOG_LEVEL ??= 'silent';
  return openDatabase(MEMORY);
}
