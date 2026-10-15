'use client';

import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { ROLE_LABELS } from '@/lib/rbac';
import type { AppUserWithAccess } from '@/lib/access';
import type { GrantRole } from '@/lib/access-model';
import { describeOrigins, type ScopeOrigin } from '@/lib/access-mirror-model';
import {
  alsoLinkedNote, canPreviewMirror, canUseSignInAccount, describeScopePath, previewHeading, replacesManualNote,
} from '@/lib/access-picker';
import { previewUrl } from '@/lib/person-form';

export interface MirrorPreview {
  scopes: { scope: string; kind: string; origins: ScopeOrigin[] }[];
  alsoLinkedTo: { id: string; email: string }[];
}

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
            <li key={s.scope} className="min-w-0 px-3 py-2">
              <div className="text-sm font-medium text-ink">{describeScopePath(s.scope)}</div>
              <div className="break-all font-mono text-xs text-ink-2">{s.scope}</div>
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
 * The Linked account of Mirrored access (#311): the object id, "Use their sign-in account" where it means the same
 * account in Azure, and Preview, which reads the account and lists the Scopes it would give. Nothing is stored
 * here: the page's Save reads the account again on the server and stores what it finds, and only after a preview
 * of the id in the field now. The field starts empty, and the button only ever fills it.
 *
 * `user` is null for an invite. For an Admin being demoted the preview takes no person, since the mirror routes
 * refuse an Admin, and the form says what happens if the account cannot be read after the demote.
 */
export function LinkedAccountFields({
  user, email, role, objectId, previewedId, signInTenantIsAzureTenant, disabled, onObjectId, onPreviewed,
}: {
  user: AppUserWithAccess | null;
  email: string;
  role: GrantRole;
  objectId: string;
  previewedId: string | null;
  signInTenantIsAzureTenant: boolean;
  disabled?: boolean;
  /** The field changed: any earlier preview no longer counts. */
  onObjectId: (objectId: string) => void;
  onPreviewed: (objectId: string) => void;
}) {
  const [preview, setPreview] = useState<{ objectId: string; found: MirrorPreview } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = `linked-account-${user?.id ?? 'new'}`;

  async function runPreview() {
    const id = objectId.trim();
    setReading(true);
    setError(null);
    try {
      const res = await fetch(previewUrl(user), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectId: id }),
      });
      const body = await res.json() as MirrorPreview & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not read this account.'); return; }
      setPreview({ objectId: id, found: body });
      onPreviewed(id);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setReading(false); }
  }

  const shown = preview && previewedId === preview.objectId && preview.objectId === objectId.trim() ? preview.found : null;
  const replaces = user && user.role !== 'admin' ? replacesManualNote(user.access) : null;
  const who = email.trim() || 'This person';

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>Linked account</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={fieldId}
            value={objectId}
            onChange={e => onObjectId(e.target.value)}
            placeholder="Azure object id"
            className="min-w-0 flex-1 font-mono"
            disabled={disabled || reading}
            autoComplete="off"
            spellCheck={false}
          />
          {user && canUseSignInAccount(user, signInTenantIsAzureTenant) && (
            <Button size="sm" variant="outline" disabled={disabled || reading} onClick={() => onObjectId(user.oid ?? '')}>
              <UserRound className="size-3.5" />
              Use their sign-in account
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={disabled || reading || !canPreviewMirror(objectId)} onClick={() => void runPreview()}>
            {reading ? 'Reading Azure' : 'Preview'}
          </Button>
        </div>
        <FieldHint>
          The object id of the Azure account whose role assignments this person follows, at the Role above. It can
          differ from the account they sign in with, such as a separate admin account. The Azure role never decides
          the Role: someone who can delete VMs in Azure is not made an Editor by that.
        </FieldHint>
      </div>
      {error && <Callout tone="error">{error}</Callout>}
      {shown && (
        <div className="space-y-1.5">
          <MirrorPreviewList preview={shown} email={who} role={role} />
          {replaces && <Callout tone="warn">{replaces}</Callout>}
          {user?.role === 'admin' && (
            <Callout tone="warn">
              {user.email} is made {ROLE_LABELS[role]} first, holding nothing, and the account is linked next. If
              the account cannot be read, they stay {ROLE_LABELS[role]} with no access until you try again.
            </Callout>
          )}
          <FieldHint>
            Saving reads the account again and stores what it finds. RuleBeat then refreshes it every hour.
          </FieldHint>
        </div>
      )}
    </div>
  );
}
