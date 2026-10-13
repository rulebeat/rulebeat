import { everythingAccess } from '@/lib/access-model';

/**
 * Everything, for the work RuleBeat does on its own account: the scheduler and startup. It is not a
 * person's access and no request may borrow it, so no route or page imports this module
 * (system-access-imports.test.ts holds that). Nothing consumes it yet; #270 wires it.
 */
export const SYSTEM_ACCESS = Object.freeze(everythingAccess('admin'));
