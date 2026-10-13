import { everythingAccess } from '@/lib/access-model';

/**
 * Everything, for the work RuleBeat does on its own account: the scheduler tick, startup recovery,
 * the cache warmer, the backfills, the Demo's replay, notification dispatch, and the stored
 * posture snapshot (an install-wide value that must never be computed under whoever triggered it).
 * It is not a person's access and no request may borrow it, so no route or page imports this module
 * (system-access-imports.test.ts holds that).
 */
export const SYSTEM_ACCESS = Object.freeze(everythingAccess('admin'));
