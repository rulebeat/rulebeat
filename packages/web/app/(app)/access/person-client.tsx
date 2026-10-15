'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { LockedSurface } from '@/components/layout/locked-surface';
import type { AppUserWithAccess } from '@/lib/access';
import type { GrantRole } from '@/lib/access-model';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from '@/lib/rbac';
import { demotedWithoutAccessMessage, demoteToMirrored, EDIT_STOPS_MIRROR_NOTE, EVERYTHING_DETAIL } from '@/lib/access-picker';
import {
  initialPersonForm, mixedRoles, planSave, withRole, type AccessChoice, type PersonForm, type SaveStep,
} from '@/lib/person-form';
import { cn } from '@/lib/utils';
import { LinkedAccountFields } from './mirrored-access-form';
import { MirroredDetail } from './mirrored-detail';
import { ScopePicker } from './scope-picker';


export const LAST_ADMIN_NOTE = 'This is the only admin. Promote someone else to admin first.';

const ACCESS_CHOICES: { value: AccessChoice; label: string; detail: string }[] = [
  { value: 'everything', label: 'Everything', detail: EVERYTHING_DETAIL },
  {
    value: 'scopes', label: 'Selected Scopes',
    detail: 'Management groups, subscriptions, resource groups or the Directory, picked in the tree. They see only the findings inside them.',
  },
  {
    value: 'mirrored', label: 'Mirrored from Azure',
    detail: 'Scopes that follow the role assignments of a Linked account in Azure, read again every hour.',
  },
];

/** One radio of a choice: the option in bold, what it means under it. */
function Choice({ name, checked, disabled, label, detail, onSelect }: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  detail: ReactNode;
  onSelect: () => void;
}) {
  return (
    <label className={cn('flex items-start gap-2.5 px-3 py-2.5', checked ? 'bg-surface-sunken' : 'hover:bg-surface-hover', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} className="mt-0.5 size-4 shrink-0 accent-ink" />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="block text-xs text-ink-2">{detail}</span>
      </span>
    </label>
  );
}

/** What a call answered: the person as it left them, or why it failed. */
async function send(step: SaveStep): Promise<{ ok: true; user: AppUserWithAccess } | { ok: false; error: string }> {
  try {
    const res = await fetch(step.url, {
      method: step.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(step.body),
    });
    const body = await res.json() as AppUserWithAccess & { error?: string };
    return res.ok ? { ok: true, user: body } : { ok: false, error: body.error ?? 'Could not save this person.' };
  } catch {
    return { ok: false, error: 'Could not reach the RuleBeat server.' };
  }
}

/**
 * One person's page (#311): their Role, then what they can access, saved together. `user` is null to add someone.
 * The Role is one choice of three; an Admin holds everything, so the access choice is only there for a Viewer or
 * an Editor: Everything, Selected Scopes picked in the tree, or Mirrored from a Linked account. Every Scope takes
 * the person's Role. Save makes whichever calls the change needs, in order, and goes back to the list.
 */
export function PersonClient({ user: initialUser, isLastAdmin, isSelf, signInTenantIsAzureTenant, demo }: {
  user: AppUserWithAccess | null;
  isLastAdmin: boolean;
  isSelf: boolean;
  signInTenantIsAzureTenant: boolean;
  demo: boolean;
}) {
  const router = useRouter();
  // The person as the server last answered: a mirror that failed after its demote leaves them demoted.
  const [user, setUser] = useState<AppUserWithAccess | null>(initialUser);
  const [form, setForm] = useState<PersonForm>(() => initialPersonForm(initialUser));
  const [email, setEmail] = useState('');
  const [relinking, setRelinking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = planSave(user, form, email);
  const grantRole = form.role === 'admin' ? 'viewer' : form.role as GrantRole;
  const mirrored = user?.accessSource === 'mirrored' && user.role !== 'admin';
  const update = (change: Partial<PersonForm>) => setForm(f => ({ ...f, ...change }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (plan.kind === 'demote-mirrored' && user) {
        // A first try that demoted them but could not link the account left them no Admin: only the link runs again.
        const demoted = user.role === 'admin' ? undefined : user;
        const result = await demoteToMirrored({ userId: user.id, role: plan.role, objectId: plan.objectId, demoted }, (url, init) => fetch(url, init));
        if (!result.ok) {
          if (result.stage === 'mirror') {
            setUser(result.user);
            setError(demotedWithoutAccessMessage(user.email, plan.role, result.error));
          } else setError(result.error);
          return;
        }
      } else if (plan.kind === 'steps') {
        for (const step of plan.steps) {
          const answer = await send(step);
          if (!answer.ok) { setError(answer.error); return; }
          if (user) setUser(answer.user);
        }
      } else return;
      router.push('/access');
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const canSave = plan.kind === 'steps' || plan.kind === 'demote-mirrored';

  return (
    <LockedSurface demo={demo} action="users:manage">
      <div className="max-w-3xl space-y-6">
        <Link href="/access" className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
          <ArrowLeft className="size-3.5" />
          All users
        </Link>

        {user ? (
          <p className="text-sm text-ink-2">
            {user.email}{isSelf ? ' (you)' : ''}
          </p>
        ) : (
          <Card>
            <CardHeader><CardTitle>Person</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              <Label htmlFor="invite-email">Work email</Label>
              <Input id="invite-email" value={email} onChange={e => setEmail(e.target.value)} placeholder="person@company.com" autoFocus />
              <FieldHint>
                They keep this access when they first sign in. No invitation email is sent, since RuleBeat never sends mail.
              </FieldHint>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>Role</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div role="radiogroup" aria-label="Role" className="divide-y divide-border bg-surface">
              {ROLES.map(r => (
                <Choice
                  key={r}
                  name="role"
                  checked={form.role === r}
                  disabled={saving || (isLastAdmin && r !== 'admin')}
                  label={ROLE_LABELS[r]}
                  detail={ROLE_DESCRIPTIONS[r]}
                  onSelect={() => setForm(f => withRole(f, r as Role, user))}
                />
              ))}
            </div>
            {isLastAdmin && <FieldHint>{LAST_ADMIN_NOTE}</FieldHint>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Access</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {form.role === 'admin' ? (
              <p className="text-sm text-ink-2">An Admin has access to everything, so there is no access to choose.</p>
            ) : (
              <>
                <div role="radiogroup" aria-label="Access" className="divide-y divide-border bg-surface">
                  {ACCESS_CHOICES.map(c => (
                    <Choice
                      key={c.value}
                      name="access"
                      checked={form.choice === c.value}
                      disabled={saving}
                      label={c.label}
                      detail={c.detail}
                      onSelect={() => update({ choice: c.value })}
                    />
                  ))}
                </div>
                {form.choice === null && <FieldHint>Choose one. Until you do, this person is given nothing.</FieldHint>}
                {mirrored && form.choice !== 'mirrored' && form.choice !== null && <Callout tone="warn">{EDIT_STOPS_MIRROR_NOTE}</Callout>}

                {form.choice === 'scopes' && (
                  <div className="space-y-2">
                    {mixedRoles(form.grants) && (
                      <Callout tone="warn">
                        This person holds Scopes at different Roles. Saving gives every Scope the Role above, {ROLE_LABELS[grantRole]}.
                      </Callout>
                    )}
                    <ScopePicker value={form.grants} onChange={grants => update({ grants })} role={grantRole} disabled={saving} />
                    {form.grants.length === 0 && user && (
                      <FieldHint>Nothing is chosen, so this person will see no findings until an Admin gives them access.</FieldHint>
                    )}
                  </div>
                )}

                {form.choice === 'mirrored' && (
                  <div className="space-y-3">
                    {mirrored && user && (
                      <MirroredDetail user={user} disabled={saving} onChanged={setUser} />
                    )}
                    {mirrored && !relinking ? (
                      <Button size="sm" variant="outline" disabled={saving} onClick={() => setRelinking(true)}>
                        Link a different account
                      </Button>
                    ) : (
                      <LinkedAccountFields
                        user={user}
                        email={user?.email ?? email}
                        role={grantRole}
                        objectId={form.objectId}
                        previewedId={form.previewedId}
                        signInTenantIsAzureTenant={signInTenantIsAzureTenant}
                        disabled={saving}
                        onObjectId={objectId => update({ objectId, previewedId: null })}
                        onPreviewed={previewedId => update({ previewedId })}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {error && <Callout tone="error">{error}</Callout>}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={saving || !canSave} onClick={() => void save()}>
            <Check className="size-3.5" />
            {saving ? 'Saving' : user ? 'Save' : 'Add user'}
          </Button>
          <Link href="/access" className={buttonVariants({ variant: 'outline' })}>Cancel</Link>
          {plan.kind === 'blocked' && <span className="text-sm text-ink-2">{plan.reason}</span>}
          {plan.kind === 'nothing' && user && <span className="text-sm text-ink-2">Nothing has changed.</span>}
        </div>
      </div>
    </LockedSurface>
  );
}
