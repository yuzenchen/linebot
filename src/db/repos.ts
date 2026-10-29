import type { Database } from 'better-sqlite3';
import { createClassificationsRepo } from './classifications.js';
import { createEventsRepo } from './events.js';
import { createIncidentsRepo } from './incidents.js';
import { createJobsRepo } from './jobs.js';
import { createMessagesRepo } from './messages.js';
import { createPushLogRepo } from './pushLog.js';
import { createSuggestionsRepo } from './suggestions.js';
import { createUsersRepo } from './users.js';

/** Builds every repository on one connection. */
export function createRepos(db: Database) {
  return {
    events: createEventsRepo(db),
    users: createUsersRepo(db),
    messages: createMessagesRepo(db),
    classifications: createClassificationsRepo(db),
    incidents: createIncidentsRepo(db),
    suggestions: createSuggestionsRepo(db),
    pushLog: createPushLogRepo(db),
    jobs: createJobsRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;
