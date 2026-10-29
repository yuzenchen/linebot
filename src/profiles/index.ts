import { createAdminProfile } from './admin.js';
import { createEnduserProfile } from './enduser.js';
import type { BotProfile, ProfileName, Shared } from './types.js';

export type { BotProfile, ProfileName, Shared } from './types.js';

/** Picks the profile implementation for `BOT_PROFILE`. */
export function createProfile(name: ProfileName, shared: Shared): BotProfile {
  switch (name) {
    case 'admin':
      return createAdminProfile(shared);
    case 'enduser':
      return createEnduserProfile(shared);
  }
}
