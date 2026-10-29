import { createAdminNotifier } from '../../src/notify/adminNotifier.js';
import { createTicketService, type TicketService } from '../../src/tickets/service.js';
import { silent, type Harness } from '../handlers/helpers.js';

/** Ticket service whose notices are pushed straight to `admin` (reason `admin_ticket*`). */
export function ticketService(h: Harness, admin: string | undefined): TicketService {
  const adminNotifier = createAdminNotifier({
    config: { ADMIN_LINE_USER_ID: admin },
    replier: h.replier,
    log: silent,
  });
  return createTicketService({ repos: h.repos, adminNotifier, log: silent });
}

export interface TicketDbRow {
  id: number;
  user_id: string;
  source: string;
  question: string;
  context: string | null;
  order_ids: string | null;
  grok_task_id: string | null;
  status: string;
  answered_by: string | null;
  answer: string | null;
  answered_at: string | null;
  created_at: string;
  updated_at: string;
}

export function ticketRows(h: Harness): TicketDbRow[] {
  return h.db.prepare('SELECT * FROM tickets ORDER BY id').all() as TicketDbRow[];
}
