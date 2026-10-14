'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, TableScroll,
} from '@/components/ui/table';
import { ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, type Role } from '@/lib/rbac';
import type { AppUserWithAccess } from '@/lib/access';
import { describeAccess, EVERYTHING_SCOPE_PATH, type GrantRole, type ManualGrant } from '@/lib/access-model';
import { canInvite, canInviteMirrored, canPreviewMirror, EDIT_STOPS_MIRROR_NOTE, grantsOfAccess, setEveryRole } from '@/lib/access-picker';
import { Plus, Trash2, Check, X, Mail, ShieldCheck, KeyRound } from 'lucide-react';
import { MirroredAccessRow, MirrorPreviewList, type MirrorPreview } from './mirrored-access-form';
import { MirroredDetailRow } from './mirrored-detail';
import { ManualDetailRow } from './manual-detail';
import { ScopePicker } from './scope-picker';

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

/** What the invite form sends: an Admin with nothing to choose, or a Viewer or Editor with exactly one source. */
export type InviteRequest =
  | { email: string; role: 'admin' }
  | { email: string; role: GrantRole; source: 'manual'; access: ManualGrant[] }
  | { email: string; role: GrantRole; source: 'mirrored'; objectId: string };

export function InviteRow({ onSave, onCancel, saving }: {
  onSave: (invite: InviteRequest) => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  // Nothing is chosen to start with, neither the source nor a Scope: an invited Viewer or Editor is given what
  // an Admin picks, never a default, so a forgotten step grants nothing.
  const [mode, setMode] = useState<'manual' | 'mirrored' | null>(null);
  const [grants, setGrants] = useState<ManualGrant[]>([]);
  const [objectId, setObjectId] = useState('');
  const [preview, setPreview] = useState<{ objectId: string; found: MirrorPreview } | null>(null);
  const [reading, setReading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const scoped = role !== 'admin';

  async function runPreview() {
    const id = objectId.trim();
    setReading(true);
    setPreviewError(null);
    try {
      const res = await fetch('/api/users/mirror-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectId: id }),
      });
      const body = await res.json() as MirrorPreview & { error?: string };
      if (!res.ok) { setPreviewError(body.error ?? 'Could not read this account.'); return; }
      setPreview({ objectId: id, found: body });
    } catch {
      setPreviewError('Could not reach the RuleBeat server.');
    } finally { setReading(false); }
  }

  const ready = !scoped
    ? email.trim() !== ''
    : mode === 'manual'
      ? canInvite(email, grants)
      : mode === 'mirrored' && canInviteMirrored(email, objectId, preview?.objectId ?? null);

  function send() {
    const to = email.trim();
    if (!scoped) onSave({ email: to, role: 'admin' });
    else if (mode === 'manual') onSave({ email: to, role: role as GrantRole, source: 'manual', access: grants });
    else if (mode === 'mirrored') onSave({ email: to, role: role as GrantRole, source: 'mirrored', objectId: objectId.trim() });
  }

  return (
    <tr className="border-b border-border bg-surface-sunken last:border-0">
      <td colSpan={7} className="px-3 py-4">
        <div className="flex max-w-2xl flex-col gap-3">
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
              They keep this access when they first sign in. No invitation email is sent, since
              RuleBeat never sends mail.
            </FieldHint>
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <RoleSelect
              value={role}
              onChange={r => { setRole(r); if (r !== 'admin') setGrants(g => setEveryRole(g, r as GrantRole)); }}
            />
            <FieldHint>{ROLE_DESCRIPTIONS[role]}</FieldHint>
          </div>
          {!scoped && <FieldHint>An Admin has access to everything, so there is no access to choose.</FieldHint>}
          {scoped && <SourceSwitch mode={mode} onChange={setMode} />}
          {scoped && mode === 'manual' && (
            <div className="space-y-1.5">
              <Label>Access</Label>
              <ScopePicker value={grants} onChange={setGrants} defaultRole={role as GrantRole} />
              <FieldHint>
                {grants.length === 0
                  ? 'Choose at least one. They see only the findings inside what you choose, and can act only there.'
                  : 'Each Scope has its own Role. Change one to make this person an Editor in one place and a Viewer in another.'}
              </FieldHint>
            </div>
          )}
          {scoped && mode === 'mirrored' && (
            <div className="space-y-1.5">
              <Label htmlFor="invite-linked-account">Linked account</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="invite-linked-account"
                  value={objectId}
                  onChange={e => { setObjectId(e.target.value); setPreview(null); }}
                  placeholder="Azure object id"
                  className="font-mono"
                  disabled={reading}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button size="sm" variant="outline" disabled={reading || !canPreviewMirror(objectId)} onClick={() => void runPreview()}>
                  {reading ? 'Reading Azure' : 'Preview'}
                </Button>
              </div>
              <FieldHint>
                The object id of the Azure account whose role assignments this person follows, at the Role above.
                Preview it before adding; adding reads the account again and stores what it finds.
              </FieldHint>
              {previewError && <Callout tone="error">{previewError}</Callout>}
              {preview && <MirrorPreviewList preview={preview.found} email={email.trim() || 'This person'} role={role as GrantRole} />}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" disabled={saving || reading || !ready} onClick={send}>
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

/** Chooses what one existing person can access: an edit of their Manual access, or what a demoted Admin is given. */
function AccessPromptRow({ heading, hint, notice, modeSwitch, initial, defaultRole, confirmLabel, onConfirm, onCancel, saving }: {
  heading: string;
  hint: string;
  /** Said above the list, for a state the Admin should know before changing it. */
  notice?: string;
  /** The Manual access / Mirrored access choice, drawn above the list by the row that owns it. */
  modeSwitch?: ReactNode;
  initial: ManualGrant[];
  defaultRole: GrantRole;
  confirmLabel: string;
  onConfirm: (grants: ManualGrant[]) => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const [grants, setGrants] = useState<ManualGrant[]>(initial);
  return (
    <tr className="border-b border-border bg-surface-sunken last:border-0">
      <td colSpan={7} className="px-3 py-4">
        <div className="flex max-w-2xl flex-col gap-3">
          {modeSwitch}
          {notice && <Callout tone="warn">{notice}</Callout>}
          <div className="space-y-1.5">
            <Label>{heading}</Label>
            <ScopePicker value={grants} onChange={setGrants} defaultRole={defaultRole} disabled={saving} />
            <FieldHint>
              {grants.length === 0
                ? 'Nothing is chosen, so this person will see no findings until an Admin gives them access.'
                : hint}
            </FieldHint>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" disabled={saving} onClick={() => onConfirm(grants)}>
              <Check className="size-3.5" />
              {confirmLabel}
            </Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={onCancel}>
              <X className="size-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      </td>
    </tr>
  );
}

/** What remounts an Edit prompt: the Role and Scopes it was opened on. A prompt copies them into its own
 *  list once, so a prompt left open over a person whose access has since changed would otherwise save the
 *  old Roles back over the new ones. */
export function editPromptKey(user: AppUserWithAccess): string {
  return `edit:${user.role}:${JSON.stringify(grantsOfAccess(user.access))}`;
}

/** What remounts a demote prompt: the Role the Admin is being made. Picking another Role has to start the
 *  list again at that Role, or the button would say Editor and the person would become a Viewer. */
export function demotePromptKey(role: Role): string {
  return `demote:${role}`;
}

const SOURCE_LABELS = { manual: 'Manual access', mirrored: 'Mirrored access' } as const;

/** The choice between the two ways of giving a Viewer or Editor access. An Admin has none, so never gets it. */
function SourceSwitch({ mode, onChange }: { mode: 'manual' | 'mirrored' | null; onChange: (mode: 'manual' | 'mirrored') => void }) {
  return (
    <div className="space-y-1.5">
      <Label>Access source</Label>
      <div className="flex items-center gap-2">
        {(['manual', 'mirrored'] as const).map(m => (
          <Button
            key={m}
            size="sm"
            variant={mode === m ? 'default' : 'outline'}
            aria-pressed={mode === m}
            onClick={() => onChange(m)}
          >
            {SOURCE_LABELS[m]}
          </Button>
        ))}
      </div>
      <FieldHint>
        {mode === null
          ? 'Choose one. Until you do, this person is given nothing.'
          : mode === 'manual'
            ? 'You pick the Scopes, each with its own Role. Nothing in Azure changes them.'
            : 'One Role, and Scopes that follow the role assignments of a Linked account in Azure.'}
      </FieldHint>
    </div>
  );
}

/**
 * Edit for one Viewer or Editor: Manual access, picked by hand, or Mirrored access from a Linked account. It
 * opens on Manual access, so editing a mirrored person says that saving turns them manual, with the Scopes
 * they have now.
 */
function EditAccessRow({ user, saving, signInTenantIsAzureTenant, onSaveAccess, onMirrored, onCancel }: {
  user: AppUserWithAccess;
  saving: boolean;
  signInTenantIsAzureTenant: boolean;
  onSaveAccess: (grants: ManualGrant[]) => void;
  onMirrored: (user: AppUserWithAccess) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'manual' | 'mirrored'>('manual');
  const modeSwitch = <SourceSwitch mode={mode} onChange={setMode} />;
  if (mode === 'mirrored') {
    return (
      <MirroredAccessRow
        user={user}
        signInTenantIsAzureTenant={signInTenantIsAzureTenant}
        modeSwitch={modeSwitch}
        onSaved={onMirrored}
        onCancel={onCancel}
      />
    );
  }
  return (
    <AccessPromptRow
      heading={`What ${user.email} can access`}
      hint="Each Scope has its own Role. Saving replaces everything this person had."
      notice={user.accessSource === 'mirrored' ? EDIT_STOPS_MIRROR_NOTE : undefined}
      modeSwitch={modeSwitch}
      initial={grantsOfAccess(user.access)}
      defaultRole={user.role as GrantRole}
      confirmLabel="Save access"
      saving={saving}
      onConfirm={onSaveAccess}
      onCancel={onCancel}
    />
  );
}

/** The prompts that can open under one person's row, each keyed by what it was opened on so it remounts
 *  when that changes. */
export function PromptRows({
  user, editing, demotingTo, saving, signInTenantIsAzureTenant = false, onSaveAccess, onMirrored = () => undefined,
  onDemote, onCancelEdit, onCancelDemote,
}: {
  user: AppUserWithAccess;
  editing: boolean;
  demotingTo: Role | null;
  saving: boolean;
  /** Whether the sign-in tenant is the Azure connection's, so "Use their sign-in account" means the same account. */
  signInTenantIsAzureTenant?: boolean;
  onSaveAccess: (grants: ManualGrant[]) => void;
  onMirrored?: (user: AppUserWithAccess) => void;
  onDemote: (role: Role, access: ManualGrant[]) => void;
  onCancelEdit: () => void;
  onCancelDemote: () => void;
}) {
  return (
    <>
      {editing && user.role !== 'admin' && (
        <EditAccessRow
          key={editPromptKey(user)}
          user={user}
          saving={saving}
          signInTenantIsAzureTenant={signInTenantIsAzureTenant}
          onSaveAccess={onSaveAccess}
          onMirrored={onMirrored}
          onCancel={onCancelEdit}
        />
      )}
      {demotingTo && (
        <AccessPromptRow
          key={demotePromptKey(demotingTo)}
          heading={`What ${user.email} can access as ${ROLE_LABELS[demotingTo]}`}
          hint="An Admin holds everything, so the access they keep after this is chosen here. Everything is preselected."
          initial={[{ scope: EVERYTHING_SCOPE_PATH, role: demotingTo as GrantRole }]}
          defaultRole={demotingTo as GrantRole}
          confirmLabel={`Make ${ROLE_LABELS[demotingTo]}`}
          saving={saving}
          onConfirm={access => onDemote(demotingTo, access)}
          onCancel={onCancelDemote}
        />
      )}
    </>
  );
}

export function UsersSection({
  initialUsers, initialUsersWithPassword, currentUserId, signInTenantIsAzureTenant = false,
}: {
  initialUsers: AppUserWithAccess[];
  initialUsersWithPassword: string[];
  currentUserId: string;
  /** Whether the sign-in tenant is the Azure connection's, so a person's sign-in account can be linked in one click. */
  signInTenantIsAzureTenant?: boolean;
}) {
  const [users, setUsers] = useState<AppUserWithAccess[]>(initialUsers);
  const [usersWithPassword, setUsersWithPassword] = useState<Set<string>>(new Set(initialUsersWithPassword));
  const [inviting, setInviting] = useState(false);
  const [editingAccess, setEditingAccess] = useState<string | null>(null);
  const [demoting, setDemoting] = useState<{ id: string; role: Role } | null>(null);
  const [saving, setSaving] = useState(false);
  const [passwordBusyFor, setPasswordBusyFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adminCount = users.filter(u => u.role === 'admin').length;
  // The API refuses this too: the disabled control just explains why before the click.
  const lastAdminNote = 'This is the only admin. Promote someone else to admin first.';

  /** A Role change. Demoting an Admin first asks what they are to access, so it opens that prompt instead. */
  function changeRole(user: AppUserWithAccess, role: Role) {
    if (user.role === 'admin' && role !== 'admin') {
      setError(null);
      setEditingAccess(null);
      setDemoting({ id: user.id, role });
      return;
    }
    void sendRole(user, { role });
  }

  async function sendRole(user: AppUserWithAccess, payload: { role: Role; access?: ManualGrant[] }) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json() as AppUserWithAccess & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to change role'); return; }
      setUsers(us => us.map(u => u.id === user.id ? body : u));
      setDemoting(null);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setSaving(false); }
  }

  async function saveAccess(user: AppUserWithAccess, access: ManualGrant[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access }),
      });
      const body = await res.json() as AppUserWithAccess & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to change access'); return; }
      setUsers(us => us.map(u => u.id === user.id ? body : u));
      setEditingAccess(null);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setSaving(false); }
  }

  async function invite(request: InviteRequest) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await res.json() as AppUserWithAccess & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Failed to add user'); return; }
      setUsers(us => [...us, body].sort((a, b) => a.email.localeCompare(b.email)));
      setInviting(false);
    } finally { setSaving(false); }
  }

  async function remove(user: AppUserWithAccess) {
    const self = user.id === currentUserId;
    const message = self
      ? 'Remove your own access? You will be signed out on your next request, and denied if you try to sign in again. An admin would need to add you back first.'
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

  async function setOrResetPassword(user: AppUserWithAccess) {
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

  async function removePassword(user: AppUserWithAccess) {
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
                <TableHead>Access</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Local password</TableHead>
                <TableHead shrink />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map(user => {
                const isLastAdmin = user.role === 'admin' && adminCount === 1;
                return (
                  <Fragment key={user.id}>
                  <TableRow className="group transition-colors hover:bg-surface-hover">
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
                        onChange={r => changeRole(user, r)}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-ink-2">
                      <span>{describeAccess(user.access)}</span>
                      {user.role !== 'admin' && (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => { setDemoting(null); setEditingAccess(user.id); }}
                          className="ml-2 font-medium text-ink underline underline-offset-2 hover:no-underline disabled:opacity-60"
                        >
                          Edit
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-ink-muted">
                      {user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : '-'}
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
                  {user.accessSource === 'mirrored' && user.role !== 'admin' && (
                    <MirroredDetailRow
                      user={user}
                      disabled={saving}
                      onChanged={updated => setUsers(us => us.map(u => u.id === updated.id ? updated : u))}
                    />
                  )}
                  {user.accessSource !== 'mirrored' && user.role !== 'admin' && editingAccess !== user.id && (
                    <ManualDetailRow user={user} />
                  )}
                  <PromptRows
                    user={user}
                    editing={editingAccess === user.id}
                    demotingTo={demoting?.id === user.id ? demoting.role : null}
                    saving={saving}
                    signInTenantIsAzureTenant={signInTenantIsAzureTenant}
                    onMirrored={updated => {
                      setUsers(us => us.map(u => u.id === updated.id ? updated : u));
                      setEditingAccess(null);
                    }}
                    onSaveAccess={grants => { void saveAccess(user, grants); }}
                    onDemote={(role, access) => { void sendRole(user, { role, access }); }}
                    onCancelEdit={() => setEditingAccess(null)}
                    onCancelDemote={() => setDemoting(null)}
                  />
                  </Fragment>
                );
              })}
              {inviting && (
                <InviteRow
                  onSave={request => { void invite(request); }}
                  onCancel={() => setInviting(false)}
                  saving={saving}
                />
              )}
              {users.length === 0 && !inviting && (
                <TableEmpty colSpan={7}>
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
