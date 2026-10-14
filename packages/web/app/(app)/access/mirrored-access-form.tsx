'use client';

import { useState, type ReactNode } from 'react';
import { Check, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ROLE_LABELS } from '@/lib/rbac';
import type { AppUserWithAccess } from '@/lib/access';
import type { GrantRole } from '@/lib/access-model';
import { describeOrigins, type ScopeOrigin } from '@/lib/access-mirror-model';
import {
  alsoLinkedNote, canPreviewMirror, canUseSignInAccount, demotedWithoutAccessMessage, demoteToMirrored, describeScopePath, previewHeading,
  replacesManualNote,
} from '@/lib/access-picker';

const ROLE_OPTIONS = (['viewer', 'editor'] as const).map(r => ({ value: r, label: ROLE_LABELS[r] }));

export interface MirrorPreview {
  scopes: { scope: string; kind: string; origins: ScopeOrigin[] }[];
  alsoLinkedTo: { id: string; email: string }[];
}

type Answer<T> = (T & { error?: string }) | { error?: string };

/** What a preview found for an account: its Scopes with the Azure roles behind them, and who else is linked to it. */
export function MirrorPreviewList({ preview, email, role }: { preview: MirrorPreview; email: string; role: GrantRole }) {
  const others = alsoLinkedNote(preview.alsoLinkedTo);
  return (
    <>
      <Label>Scopes {email} would get as {ROLE_LABELS[role]}</Label>
      <p className="text-sm text-ink">{previewHeading(preview.scopes, email)}</p>
      {preview.scopes.length > 0 && (
        <ul className="divide-y divide-border bg-surface">
          {preview.scopes.map(s => (
            <li key={s.scope} className="px-3 py-2">
              <div className="text-sm font-medium text-ink">{describeScopePath(s.scope)}</div>
              <div className="font-mono text-xs text-ink-2">{s.scope}</div>
              <div className="text-xs text-ink-2">{describeOrigins(s.origins)}</div>
            </li>
          ))}
        </ul>
      )}
      {others && <Callout tone="warn">{others}</Callout>}
    </>
  );
}

/**
 * Chooses Mirrored access for one person: one Role and a Linked account. Saving runs the mirror once and shows the
 * Scopes it would give; nothing is stored until Confirm, which runs it again on the server. The object id field
 * starts empty. "Use their sign-in account" only fills it, and is offered only when the id RuleBeat holds for
 * the person means the same account in the Azure connection's tenant.
 *
 * With `demoteTo` the person is an Admin being demoted, and the Role is the one the Role control already names.
 * The mirror routes refuse an Admin, so the preview is the invite preview, which takes no person, and Confirm
 * demotes them with no Scopes before it mirrors. If the mirror then fails they stay demoted and hold nothing,
 * and the form says so; `onDemoted` hands the page the row as the demote left it.
 */
export function MirroredAccessRow({ user, signInTenantIsAzureTenant, modeSwitch, demoteTo, onSaved, onDemoted, onCancel }: {
  user: AppUserWithAccess;
  signInTenantIsAzureTenant: boolean;
  /** The Manual access / Mirrored access choice, drawn above the fields by the row that owns it. */
  modeSwitch?: ReactNode;
  /** The Role an Admin is being demoted to. */
  demoteTo?: GrantRole;
  onSaved: (user: AppUserWithAccess) => void;
  onDemoted?: (user: AppUserWithAccess) => void;
  onCancel: () => void;
}) {
  const [chosenRole, setRole] = useState<GrantRole>(user.role === 'editor' ? 'editor' : 'viewer');
  const role = demoteTo ?? chosenRole;
  const [objectId, setObjectId] = useState('');
  const [preview, setPreview] = useState<MirrorPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<{ ok: boolean; body: Answer<T> }> {
    try {
      const url = demoteTo ? '/api/users/mirror-preview' : `/api/users/${encodeURIComponent(user.id)}/mirror${path}`;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, body: await res.json() as Answer<T> };
    } catch {
      return { ok: false, body: { error: 'Could not reach the RuleBeat server.' } };
    }
  }

  async function runPreview() {
    setBusy(true);
    setError(null);
    const answer = await send<MirrorPreview>('POST', '/preview', { objectId: objectId.trim() });
    setBusy(false);
    if (!answer.ok) { setError(answer.body.error ?? 'Could not read this account.'); return; }
    setPreview(answer.body as MirrorPreview);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    if (demoteTo) { await confirmDemote(demoteTo); return; }
    const answer = await send<AppUserWithAccess>('PUT', '', { objectId: objectId.trim(), role });
    setBusy(false);
    if (!answer.ok) { setError(answer.body.error ?? 'Could not save this access.'); return; }
    onSaved(answer.body as AppUserWithAccess);
  }

  async function confirmDemote(to: GrantRole) {
    // Once the demote worked the person is no longer an Admin, and a second demote would be refused: only the mirror runs again.
    const demoted = user.role === 'admin' ? undefined : user;
    const result = await demoteToMirrored({ userId: user.id, role: to, objectId: objectId.trim(), demoted }, (url, init) => fetch(url, init));
    setBusy(false);
    if (result.ok) { onSaved(result.user); return; }
    if (result.stage === 'mirror') {
      onDemoted?.(result.user);
      setError(demotedWithoutAccessMessage(user.email, to, result.error));
      return;
    }
    setError(result.error);
  }

  const replaces = demoteTo ? null : replacesManualNote(user.access);

  return (
    <tr className="border-b border-border bg-surface-sunken last:border-0">
      <td colSpan={7} className="px-3 py-4">
        <div className="flex max-w-2xl flex-col gap-3">
          {modeSwitch}
          {error && <Callout tone="error">{error}</Callout>}

          {preview === null ? (
            <>
              <div className="space-y-1.5">
                <Label>Role</Label>
                {demoteTo ? (
                  <p className="text-sm text-ink">{ROLE_LABELS[demoteTo]}</p>
                ) : (
                  <span className="inline-block w-36">
                    <Select
                      value={role}
                      onValueChange={v => setRole(v as GrantRole)}
                      options={ROLE_OPTIONS}
                      disabled={busy}
                      size="sm"
                      aria-label="Role"
                    />
                  </span>
                )}
                <FieldHint>
                  One Role at every Scope. The Azure role never decides it: someone who can delete VMs in Azure is not
                  made an Editor by that.{demoteTo ? ' Change it with the Role control in the row above.' : ''}
                </FieldHint>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`linked-account-${user.id}`}>Linked account</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`linked-account-${user.id}`}
                    value={objectId}
                    onChange={e => setObjectId(e.target.value)}
                    placeholder="Azure object id"
                    className="font-mono"
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {canUseSignInAccount(user, signInTenantIsAzureTenant) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setObjectId(user.oid ?? '')}
                    >
                      <UserRound className="size-3.5" />
                      Use their sign-in account
                    </Button>
                  )}
                </div>
                <FieldHint>
                  The object id of the Azure account whose role assignments this person follows. It can differ from the
                  account they sign in with, such as a separate admin account.
                </FieldHint>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" disabled={busy || !canPreviewMirror(objectId)} onClick={() => void runPreview()}>
                  <Check className="size-3.5" />
                  {busy ? 'Reading Azure' : 'Save'}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
                  <X className="size-3.5" />
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <MirrorPreviewList preview={preview} email={user.email} role={role} />
                {replaces && <Callout tone="warn">{replaces}</Callout>}
                {demoteTo && user.role === 'admin' && (
                  <Callout tone="warn">
                    {user.email} is made {ROLE_LABELS[demoteTo]} first, holding nothing, and the account is linked next. If
                    the account cannot be read, they stay {ROLE_LABELS[demoteTo]} with no access until you try again.
                  </Callout>
                )}
                <FieldHint>
                  Confirming reads the account again and stores what it finds. RuleBeat then refreshes it every hour.
                </FieldHint>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" disabled={busy} onClick={() => void confirm()}>
                  <Check className="size-3.5" />
                  Confirm
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setPreview(null)}>
                  Change account
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
                  <X className="size-3.5" />
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
