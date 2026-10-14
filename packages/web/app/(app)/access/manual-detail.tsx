import type { AppUserWithAccess } from '@/lib/access';
import { describeScopePath } from '@/lib/access-picker';
import { ROLE_LABELS } from '@/lib/rbac';

/**
 * What a person with Manual access holds, for an Admin: each Scope with the Role at it, so the list can be read
 * without opening Edit. A person given nothing has no row; the Access column already says so.
 */
export function ManualDetailRow({ user }: { user: AppUserWithAccess }) {
  if (user.access.grants.length === 0) return null;
  return (
    <tr className="border-b border-border bg-surface-sunken last:border-0">
      <td colSpan={7} className="px-3 py-3">
        <ul className="max-w-3xl divide-y divide-border bg-surface">
          {user.access.grants.map(g => (
            <li key={g.scope.path} className="flex items-baseline gap-3 px-3 py-1.5">
              <span className="text-sm text-ink">{describeScopePath(g.scope.path)}</span>
              <span className="font-mono text-xs text-ink-2">{g.scope.path}</span>
              <span className="ml-auto text-xs text-ink-2">{ROLE_LABELS[g.role]}</span>
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}
