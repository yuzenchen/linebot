import { openDatabase } from '../db/index.js';
import { createRepos } from '../db/repos.js';

/**
 * Shared CLI setup: loads .env if present and opens the DB in DATA_DIR.
 * The logger reads the full config (which requires the LINE vars), so placeholders are
 * filled when they are absent — the CLIs never talk to LINE.
 */
export function bootstrap() {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // no .env — fine
  }
  process.env.LINE_CHANNEL_SECRET ||= 'unused-by-cli';
  process.env.LINE_CHANNEL_ACCESS_TOKEN ||= 'unused-by-cli';
  process.env.LOG_LEVEL = 'warn'; // keep stdout clean (e.g. --json)
  const dataDir = process.env.DATA_DIR ?? './data';
  const db = openDatabase(dataDir);
  return { dataDir, db, repos: createRepos(db) };
}
