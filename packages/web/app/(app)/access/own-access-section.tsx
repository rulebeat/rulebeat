import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import type { OwnAccess } from '@/lib/access';
import { MIRRORED_NO_SCOPE_MESSAGE } from '@/lib/access-mirror-model';
import { describeScopePath } from '@/lib/access-picker';
import { ROLE_LABELS } from '@/lib/rbac';

/** Where a person's access came from, in words. A person who holds nothing has no source to name. */
function sourceText(own: OwnAccess): string {
  if (own.source === 'manual') return 'Chosen by an Admin';
  if (own.source === 'mirrored') return 'Mirrored from Azure';
  return 'Not set';
}

const KIND_LABEL = {
  everything: 'Everything',
  directory: 'Directory',
  managementGroup: 'Management group',
  subscription: 'Subscription',
  resourceGroup: 'Resource group',
} as const;

/**
 * A Viewer's or Editor's own access, read-only: the Scopes they hold, the Role at each and where it
 * came from. It holds nothing about anyone else, and no control: only an Admin changes access.
 */
export function OwnAccessSection({ own }: { own: OwnAccess }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your access</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <p className="px-6 py-3 text-sm text-ink-2">
          You are a {ROLE_LABELS[own.role]}. {sourceText(own)}. You see the findings inside the scopes below, and
          only an Admin can change them.
        </p>
        <TableScroll>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {own.scopes.map(scope => (
                <TableRow key={scope.path}>
                  <TableCell>
                    <div className="font-medium text-ink">{describeScopePath(scope.path)}</div>
                    {scope.kind !== 'everything' && scope.kind !== 'directory' && (
                      <div className="font-mono text-xs text-ink-2">{scope.path}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-ink-2">{KIND_LABEL[scope.kind]}</TableCell>
                  <TableCell className="text-sm text-ink-2">{ROLE_LABELS[scope.role]}</TableCell>
                </TableRow>
              ))}
              {own.scopes.length === 0 && (
                <TableEmpty colSpan={3}>
                  {own.source === 'mirrored'
                    ? MIRRORED_NO_SCOPE_MESSAGE
                    : 'You have been given no access, so no findings are listed for you. Ask an Admin to give you access.'}
                </TableEmpty>
              )}
            </TableBody>
          </Table>
        </TableScroll>
      </CardContent>
    </Card>
  );
}
