import type { Logger } from 'pino';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { type AdminNotifier, fallbackReason } from './adminNotifier.js';

export interface DirectAdminNotifierDeps {
  adminUserIds: readonly string[];
  replier: Pick<Replier, 'push'>;
  log?: Logger;
}

/**
 * Admin-profile notifier: pushes every notice straight to all `ADMIN_USER_IDS` (reason
 * `admin_<kind>`), one push per recipient with its own catch. `pushed` when at least one
 * delivery succeeded, else `logged`. Never rejects.
 */
export function createDirectAdminNotifier(deps: DirectAdminNotifierDeps): AdminNotifier {
  const log = deps.log ?? logger;
  return {
    async notify(n) {
      const reason = fallbackReason(n.kind);
      let delivered = 0;
      for (const id of deps.adminUserIds) {
        try {
          await deps.replier.push(id, [n.text], reason);
          delivered += 1;
        } catch (err) {
          log.error({ ...n.meta, kind: n.kind, reason, adminId: id, err }, 'admin push failed');
        }
      }
      if (delivered > 0) {
        log.info({ ...n.meta, kind: n.kind, delivered, result: 'pushed' }, 'admin notice pushed');
        return 'pushed';
      }
      log.warn(
        { ...n.meta, kind: n.kind, reason, notice: n.text, result: 'logged' },
        'admin notice not delivered to any admin',
      );
      return 'logged';
    },
  };
}
