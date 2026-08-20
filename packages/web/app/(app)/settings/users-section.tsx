'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import { ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, type Role } from '@/lib/rbac';
import type { AppUser } from '@/lib/db/users';
import { Plus, Trash2, Check, X, Mail, ShieldCheck, KeyRound } from 'lucide-react';

const ROLE_OPTIONS = ROLES.map(r => ({ value: r, label: ROLE_LABELS[r] }));

function RoleSelect({
  value, onChange, disabled, title,
}: {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    /* The trigger is w-full by design, so it needs a block wrapper with a real
       width to resolve against. Inside a shrink-to-content table cell it would
       otherwise collapse to the chevron. */
    <span title={title} className="inline-block w-36">
      <Select
        value={value}
        onValueChange={v => onChange(v as Role)}
        options={ROLE_OPTIONS}
        disabled={disabled}
        size="sm"
        aria-label="Role"
      />
    </span>
  );
}

function InviteRow({ onSave, onCancel, saving }: {
  onSave: (email: string, role: Role) => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');

  return (
    <tr className="border-b border-border bg-surface-sunken last:border-0">
      <td colSpan={6} className="px-3 py-4">
        <div className="flex max-w-lg flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Work email</Label>
            <Input
              id="invite-email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="person@company.com"
              autoFocus
            />
            <FieldHint>
              They keep this role when they first sign in. No invitation email is sent, since
              RuleBeat never sends mail.
            </FieldHint>
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <RoleSelect value={role} onChange={setRole} />
            <FieldHint>{ROLE_DESCRIPTIONS[role]}</FieldHint>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" disabled={saving || !email.trim()} onClick={() => onSave(email.trim(), role)}>
              <Check className="size-3.5" />
              Add
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel}>
              <X className="size-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function UsersSection({
  initialUsers, initialUsersWithPassword, currentUserId,
}: {
  initialUsers: AppUser[];
  initialUsersWithPassword: string[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState<AppUser[]>(initialUsers);
  const [usersWithPassword, setUsersWithPassword] = useState<Set<string>>(new Set(initialUsersWithPassword));
  const [inviting, setInviting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [passwordBusyFor, setPasswordBusyFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adminCount = users.filter(u => u.role === 'admin').length;
  // The API refuses this too — the disabled control just explains why before the click.
  const lastAdminNote = 'This is the only admin. Promote someone else to admin first.';

  async function changeRole(user: AppUser, role: Role) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const body = await res.json() as AppUser & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to change role'); return; }
      setUsers(us => us.map(u => u.id === user.id ? body : u));
    } finally { setSaving(false); }
  }

  async function invite(email: string, role: Role) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const body = await res.json() as AppUser & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to add user'); return; }
      setUsers(us => [...us, body].sort((a, b) => a.email.localeCompare(b.email)));
      setInviting(false);
    } finally { setSaving(false); }
  }

  async function remove(user: AppUser) {
    const self = user.id === currentUserId;
    const message = self
      ? 'Remove your own access? You will be signed out on your next request, and denied if you try to sign in again — an admin would need to add you back first.'
      : `Remove ${user.email}? They lose access immediately, and are denied if they try to sign in again until an admin adds them back.`;
    if (!confirm(message)) return;

    setError(null);
    const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setError(body.error ?? 'Failed to remove user');
      return;
    }
    setUsers(us => us.filter(u => u.id !== user.id));
  }

  async function setOrResetPassword(user: AppUser) {
    const hasPassword = usersWithPassword.has(user.id);
    if (!confirm(
      hasPassword
        ? `Reset ${user.email}'s local password? They'll need to set a new one on their next sign-in.`
        : `Give ${user.email} a local password? They'll need to set their own on first sign-in.`,
    )) return;

    setPasswordBusyFor(user.id);
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
    } finally { setPasswordBusyFor(null); }
  }

  async function removePassword(user: AppUser) {
    if (!confirm(`Remove ${user.email}'s local password? They'll only be able to sign in through SSO.`)) return;
    setPasswordBusyFor(user.id);
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
    } finally { setPasswordBusyFor(null); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        {!inviting && (
          <Button size="sm" variant="outline" onClick={() => setInviting(true)}>
            <Plus className="size-3.5" />
            Add user
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {error && <Callout tone="error" className="border-x-0 border-t-0">{error}</Callout>}

        <TableScroll>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead shrink>Role</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Local password</TableHead>
                <TableHead shrink />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map(user => {
                const isLastAdmin = user.role === 'admin' && adminCount === 1;
                return (
                  <TableRow key={user.id} className="group transition-colors hover:bg-surface-hover">
                    <TableCell>
                      <div className="font-medium text-ink">{user.name ?? user.email}</div>
                      {user.name && <div className="text-xs text-ink">{user.email}</div>}
                    </TableCell>
                    <TableCell>
                      {user.oid ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                          <span className="size-2 shrink-0 bg-ink-muted" />
                          Active
                        </span>
                      ) : (
                        /* Not an alarm. Someone added by email before their first sign-in is a
                           normal, expected state, so it reads as a plain label. */
                        <span className="inline-flex w-fit items-center gap-1 bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-ink-2">
                          <Mail className="size-2.5 shrink-0" />
                          Never signed in
                        </span>
                      )}
                    </TableCell>
                    <TableCell shrink>
                      <RoleSelect
                        value={user.role}
                        disabled={saving || isLastAdmin}
                        title={isLastAdmin ? lastAdminNote : undefined}
                        onChange={r => { void changeRole(user, r); }}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-ink-muted">
                      {user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell>
                      {usersWithPassword.has(user.id) ? (
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                            <span className="size-2 shrink-0 bg-ink-muted" />
                            Set
                          </span>
                          <button
                            type="button"
                            disabled={passwordBusyFor !== null}
                            onClick={() => { void setOrResetPassword(user); }}
                            className="text-xs font-medium text-ink underline underline-offset-2 hover:no-underline disabled:opacity-60"
                          >
                            Reset
                          </button>
                          <button
                            type="button"
                            disabled={passwordBusyFor !== null}
                            onClick={() => { void removePassword(user); }}
                            className="text-xs text-ink-2 underline underline-offset-2 hover:text-ink disabled:opacity-60"
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={passwordBusyFor !== null}
                          onClick={() => { void setOrResetPassword(user); }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-ink underline underline-offset-2 hover:no-underline disabled:opacity-60"
                        >
                          <KeyRound className="size-3" />
                          Set password
                        </button>
                      )}
                    </TableCell>
                    <TableCell shrink>
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {!isLastAdmin && (
                          <Button
                            variant="ghost" size="icon-sm" title="Remove user"
                            className="hover:text-sev-critical"
                            onClick={() => { void remove(user); }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {inviting && (
                <InviteRow
                  onSave={(email, role) => { void invite(email, role); }}
                  onCancel={() => setInviting(false)}
                  saving={saving}
                />
              )}
              {users.length === 0 && !inviting && (
                <TableEmpty colSpan={6}>
                  <ShieldCheck className="mx-auto mb-2 size-5 text-ink-faint" />
                  No one has signed in yet.
                </TableEmpty>
              )}
            </TableBody>
          </Table>
        </TableScroll>
      </CardContent>
    </Card>
  );
}
