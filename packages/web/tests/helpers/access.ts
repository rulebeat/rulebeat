import { everythingAccess, type Access } from '@/lib/access-model';

/** The Everything access the existing tests read and run as: every read behaves as it did before access was threaded through. */
export const EVERYTHING_ACCESS: Access = everythingAccess('admin');
