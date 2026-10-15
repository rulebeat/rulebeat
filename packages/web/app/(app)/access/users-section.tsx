'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ROLE_LABELS } from '@/lib/rbac';
import type { AppUserWithAccess } from '@/lib/access';
import { describeAccess } from '@/lib/access-model';
import { KeyRound, Mail, MoreHorizontal, Plus, ShieldCheck, Trash2 } from 'lucide-react';

/** The href of one person's page. */
export const personHref = (id: string): string => `/access/users/${encodeURIComponent(id)}`;

/**
 * Who can sign in (#311): one row a person, with their Role and a short line of what they can access. Nothing is
 * edited in the row: the name opens the person's page, where the Role and the access are set together. The menu
 * holds what is not about access: the local password, and removing the person. The table fits its panel, so the
 * page never scrolls sideways.
 */
export function UsersSection({
  initialUsers, initialUsersWithPassword, currentUserId,
}: {
  initialUsers: AppUserWithAccess[];
  initialUsersWithPassword: string[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState<AppUserWithAccess[]>(initialUsers);
  const [usersWithPassword, setUsersWithPassword] = useState<Set<string>>(new Set(initialUsersWithPassword));
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const adminCount = users.filter(u => u.role === 'admin').length;

  async function remove(user: AppUserWithAccess) {
    const self = user.id === currentUserId;
    const message = self
      ? 'Remove your own access? You will be signed out on your next request, and denied if you try to sign in again. An admin would need to add you back first.'
      : `Remove ${user.email}? They lose access immediately, and are denied if they try to sign in again until an admin adds them back.`;
    if (!confirm(message)) return;

    setError(null);
    setBusyFor(user.id);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? 'Failed to remove user');
        return;
      }
      setUsers(us => us.filter(u => u.id !== user.id));
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusyFor(null); }
  }

  async function setOrResetPassword(user: AppUserWithAccess) {
    const hasPassword = usersWithPassword.has(user.id);
    if (!confirm(
      hasPassword
        ? `Reset ${user.email}'s local password? They'll need to set a new one on their next sign-in.`
        : `Give ${user.email} a local password? They'll need to set their own on first sign-in.`,
    )) return;

    setBusyFor(user.id);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json() as { generatedPassword?: string; error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not set the password.'); return; }
      setUsersWithPassword(s => new Set(s).add(user.id));
      if (body.generatedPassword) {
        alert(`Temporary password for ${user.email}:\n\n${body.generatedPassword}\n\nThey'll be asked to choose their own on first sign-in. This is shown once, and it isn't stored anywhere readable.`);
      }
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusyFor(null); }
  }

  async function removePassword(user: AppUserWithAccess) {
    if (!confirm(`Remove ${user.email}'s local password? They'll only be able to sign in through SSO.`)) return;
    setBusyFor(user.id);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/password`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? 'Could not remove the password.');
        return;
      }
      setUsersWithPassword(s => { const next = new Set(s); next.delete(user.id); return next; });
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusyFor(null); }
  }

  const needle = search.trim().toLowerCase();
  const shown = needle === ''
    ? users
    : users.filter(u => u.email.toLowerCase().includes(needle) || (u.name ?? '').toLowerCase().includes(needle));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <Link href="/access/users/new" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <Plus className="size-3.5" />
          Add user
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {error && <Callout tone="error" className="border-x-0 border-t-0">{error}</Callout>}
        <div className="px-5 py-3">
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email"
            aria-label="Search users"
            className="max-w-sm"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead className="w-24">Role</TableHead>
              <TableHead className="w-[30%]">Access</TableHead>
              <TableHead className="w-44">Last seen</TableHead>
              <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map(user => {
              const isLastAdmin = user.role === 'admin' && adminCount === 1;
              const hasPassword = usersWithPassword.has(user.id);
              return (
                <TableRow key={user.id} className="transition-colors hover:bg-surface-hover">
                  <TableCell>
                    <Link href={personHref(user.id)} className="block min-w-0 hover:underline hover:underline-offset-2">
                      <span className="block truncate font-medium text-ink" title={user.name ?? user.email}>{user.name ?? user.email}</span>
                      {user.name && <span className="block truncate text-xs text-ink-2" title={user.email}>{user.email}</span>}
                    </Link>
                    {!user.oid && (
                      /* Not an alarm. Someone added by email before their first sign-in is a normal, expected
                         state, so it reads as a plain label. */
                      <span className="mt-1 inline-flex w-fit items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2">
                        <Mail className="size-2.5 shrink-0" />
                        Never signed in
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-ink">{ROLE_LABELS[user.role]}</TableCell>
                  <TableCell>
                    <span className="block truncate text-xs text-ink-2" title={describeAccess(user.access)}>{describeAccess(user.access)}</span>
                  </TableCell>
                  <TableCell className="text-xs text-ink-muted">
                    {user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : '-'}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" disabled={busyFor !== null} aria-label={`Actions for ${user.email}`}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={() => void setOrResetPassword(user)}>
                          <KeyRound />{hasPassword ? 'Reset password' : 'Set password'}
                        </DropdownMenuItem>
                        {hasPassword && (
                          <DropdownMenuItem onClick={() => void removePassword(user)}>
                            <KeyRound />Remove password
                          </DropdownMenuItem>
                        )}
                        {!isLastAdmin && (
                          <DropdownMenuItem variant="destructive" onClick={() => void remove(user)}>
                            <Trash2 />Remove user
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
            {users.length === 0 && (
              <TableEmpty colSpan={5}>
                <ShieldCheck className="mx-auto mb-2 size-5 text-ink-faint" />
                No one has signed in yet.
              </TableEmpty>
            )}
            {users.length > 0 && shown.length === 0 && (
              <TableEmpty colSpan={5}>No one matches “{search.trim()}”. Search by part of a name or an email.</TableEmpty>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
