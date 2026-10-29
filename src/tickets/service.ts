import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import type { TicketRow, TicketSource } from '../db/tickets.js';
import { logger } from '../logger.js';
import type { AdminNotifier } from '../notify/adminNotifier.js';
import { ticketFollowUpNotice, ticketNotice } from '../texts.js';
import { displayId } from './ids.js';
import { extractOrderIds } from './orderIds.js';

/** Conversation turns as the classifier / job payloads carry them. */
export interface TicketContextMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface OpenTicketRequest {
  userId: string;
  source: TicketSource;
  /** The customer's current text. */
  question: string;
  /** Recent turns (excluding or including `question`; it is appended when missing). */
  context?: TicketContextMessage[];
  grokTaskId?: string;
}

export interface TicketServiceDeps {
  repos: Pick<Repos, 'tickets'>;
  adminNotifier: AdminNotifier;
  log?: Logger;
}

/** Customer texts kept in `tickets.context` and shown in the admin notice. */
export const RECENT_CUSTOMER_TEXTS = 3;

export interface TicketService {
  /**
   * Opens the customer's ticket (or appends to their open one) and notifies the admin bot:
   * a full §12.2 notice on create, a `[T042 追問]` notice on append. Never rejects.
   */
  open(req: OpenTicketRequest): Promise<TicketRow>;
  /** Appends a further customer text to an open ticket and sends the `[T042 追問]` notice. */
  notifyFollowUp(ticket: TicketRow, text: string): Promise<void>;
}

export function createTicketService(deps: TicketServiceDeps): TicketService {
  const { repos, adminNotifier } = deps;
  const log = deps.log ?? logger;

  function recentCustomerTexts(req: OpenTicketRequest): string[] {
    const texts = (req.context ?? []).filter((m) => m.role === 'user').map((m) => m.text);
    if (texts.at(-1) !== req.question) texts.push(req.question);
    return texts.slice(-RECENT_CUSTOMER_TEXTS);
  }

  async function sendFollowUp(ticket: TicketRow, text: string): Promise<void> {
    const ticketId = displayId(ticket.id);
    await adminNotifier.notify({
      kind: 'ticket_followup',
      text: ticketFollowUpNotice({ ticketId, userId: ticket.user_id, text }),
      meta: { ticketId: ticket.id, userId: ticket.user_id },
    });
  }

  return {
    async open(req) {
      const recent = recentCustomerTexts(req);
      const orderIds = extractOrderIds(recent.join('\n'));
      const { ticket, created, appended } = repos.tickets.openOrAppend({
        userId: req.userId,
        source: req.source,
        question: req.question,
        context: recent,
        orderIds,
        grokTaskId: req.grokTaskId,
      });
      if (!appended) {
        log.info({ ticketId: ticket.id, userId: req.userId }, 'ticket text already present');
        return ticket;
      }
      log.info(
        { ticketId: ticket.id, userId: req.userId, source: req.source, created, orderIds },
        created ? 'ticket opened' : 'ticket appended',
      );
      if (!created) {
        await sendFollowUp(ticket, req.question);
        return ticket;
      }
      const ticketId = displayId(ticket.id);
      await adminNotifier.notify({
        kind: 'ticket',
        text: ticketNotice({
          ticketId,
          userId: req.userId,
          question: req.question,
          recentMessages: recent,
          orderIds,
        }),
        meta: { ticketId: ticket.id, userId: req.userId, source: req.source },
      });
      return ticket;
    },
    async notifyFollowUp(ticket, text) {
      const { ticket: updated, appended } = repos.tickets.openOrAppend({
        userId: ticket.user_id,
        source: ticket.source,
        question: text,
        orderIds: extractOrderIds(text),
      });
      if (!appended) {
        log.info({ ticketId: updated.id, userId: ticket.user_id }, 'ticket text already present');
        return;
      }
      log.info({ ticketId: updated.id, userId: ticket.user_id }, 'ticket follow-up');
      await sendFollowUp(updated, text);
    },
  };
}
