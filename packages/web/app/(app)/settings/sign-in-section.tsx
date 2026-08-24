'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { FieldHint, Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { SignInStatus, LocalSignInPolicy } from '@/lib/sign-in-config';
import { redirectUriFor } from '@/lib/redirect-uri';
import {
  Check, Copy, KeyRound, Loader2, Lock, RefreshCw, ShieldAlert, Trash2,
} from 'lucide-react';

/**
 * Settings → Sign-in (B1b). Mirrors `azure-connection-section.tsx` deliberately — same card
 * shape, same locked-by-env branch, same "test before you trust it" posture — because it is the
 * same kind of screen: deployment configuration that must never appear to work when it doesn't.
 */

const POLICY_LABELS: Record<LocalSignInPolicy, string> = {
  always: 'Always available',
  'break-glass': 'Hidden once Microsoft sign-in works',
  disabled: 'Disabled. Microsoft sign-in only',
};

const POLICY_DESCRIPTIONS: Record<LocalSignInPolicy, string> = {
  always: 'The local sign-in form always appears on the sign-in page, alongside Microsoft.',
  'break-glass': 'The local form is hidden from the sign-in page once Microsoft sign-in is verified, '
    + 'but local accounts keep working. It stays there as a fallback nobody has to think about day to day.',
  disabled: 'Nobody can sign in with a local password. Only do this once Microsoft sign-in is '
    + 'verified and at least one admin trusts it completely.',
};

const POLICY_OPTIONS = (Object.keys(POLICY_LABELS) as LocalSignInPolicy[])
  .map(p => ({ value: p, label: POLICY_LABELS[p] }));

function StatusBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-2">
      <Check className="size-3 shrink-0 text-status-ok" />
      Verified
    </span>
  );
}

function StatusDetail({ status }: { status: SignInStatus }) {
  if (!status.tenantId) return null;
  return (
    <p className="break-all font-mono text-xs text-ink-muted">
      Tenant {status.tenantId}
      {status.clientId ? ` · App ${status.clientId}` : ''}
    </p>
  );
}

/* Two different states share this slot, and only one of them is a problem.
 * Configuration saved but never proven by a real sign-in is a warning. Having no
 * Microsoft configuration at all is just how a fresh install arrives, so it gets a
 * plain panel rather than a coloured one. */
function StatusLine({ status }: { status: SignInStatus }) {
  const body = (
    <>
      <p>{status.message}</p>
      {status.tenantId && (
        <p className="break-all font-mono">
          Tenant {status.tenantId}
          {status.clientId ? ` · App ${status.clientId}` : ''}
        </p>
      )}
    </>
  );

  if (status.configured) {
    return (
      <Callout tone="warn" title="Not yet verified">
        {body}
        <p>
          The Microsoft sign-in button already appears on the sign-in page. Nobody has used it
          yet, so it is not confirmed working end to end; if something is misconfigured, the
          sign-in page will show the error the first time someone tries.
        </p>
      </Callout>
    );
  }

  return (
    <div className="flex items-start gap-2.5 border border-border bg-surface-sunken px-3.5 py-2.5">
      <KeyRound className="mt-px size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5 text-xs leading-relaxed text-ink-2">
        <p className="text-[13px] font-medium text-ink">Local accounts only</p>
        {body}
      </div>
    </div>
  );
}

// True once the stored sign-in provider's tenant and client id are literally the ones
// `reuseAzureConnection: true` copied over (see api/settings/sign-in/route.ts) -- there's no
// separate "was this a reuse" flag persisted, so a match on both ids is what reuse looks like.
function reusesAzureConnection(status: SignInStatus): boolean {
  return status.azureConnection !== null
    && status.tenantId === status.azureConnection.tenantId
    && status.clientId === status.azureConnection.clientId;
}

export function SignInSection({ initialStatus }: { initialStatus: SignInStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [tenantId, setTenantId] = useState(initialStatus.stored?.tenantId ?? '');
  const [clientId, setClientId] = useState(initialStatus.stored?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [publicUrl, setPublicUrlInput] = useState(initialStatus.publicUrl ?? '');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | 'policy' | 'publicUrl' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reuseAzure, setReuseAzure] = useState(() => reusesAzureConnection(initialStatus));

  const locked = status.managedByEnv;
  // Deferred to an effect rather than read directly in render: the server has no `window`, so a
  // `typeof window` branch in render renders '' on the server and the real origin on the client's
  // very first (pre-hydration) pass -- a guaranteed hydration mismatch. Starting both at '' and
  // filling it in after mount keeps the first client render identical to the server's.
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  // The saved Public URL wins when set, same resolution order `resolveMetadataBase()` uses
  // server-side -- otherwise this fell back to whatever address the browser happens to be on,
  // which is wrong the moment Settings is reached through anything other than the public URL
  // (an internal port-forward, a VPN address, localhost while testing).
  const redirectUri = status.publicUrl
    ? redirectUriFor(status.publicUrl)
    : origin ? redirectUriFor(origin) : '';

  function reset(next: SignInStatus) {
    setStatus(next);
    setTenantId(next.stored?.tenantId ?? '');
    setClientId(next.stored?.clientId ?? '');
    setClientSecret('');
    setPublicUrlInput(next.publicUrl ?? '');
    setReuseAzure(reusesAzureConnection(next));
  }

  async function handlePublicUrlSave() {
    setBusy('publicUrl'); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/settings/sign-in', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicUrl: publicUrl.trim() }),
      });
      const body = await res.json() as SignInStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not save the public URL.'); return; }
      reset(body);
      setSuccess('Saved. Redirects after sign-in now use this address.');
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  async function handleSave() {
    setBusy('save'); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/settings/sign-in', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          reuseAzure
            ? { reuseAzureConnection: true }
            : { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret },
        ),
      });
      const body = await res.json() as SignInStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not save sign-in configuration.'); return; }
      reset(body);
      setSuccess('Saved.');
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  async function handleTest() {
    setBusy('test'); setError(null); setSuccess(null);
    try {
      const typed = tenantId.trim();
      const res = await fetch('/api/settings/sign-in/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(typed ? { tenantId: typed } : {}),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (body.ok) setSuccess('Tenant reachable. This only checks the tenant ID. Sign in with Microsoft to verify the rest.');
      else setError(body.error ?? 'The tenant check failed.');
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  async function handleRemove() {
    if (!confirm('Remove the stored Microsoft sign-in configuration? Only local accounts will work until it’s reconfigured.')) return;
    setBusy('remove'); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/settings/sign-in', { method: 'DELETE' });
      const body = await res.json() as SignInStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not remove sign-in configuration.'); return; }
      reset(body);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  async function handlePolicyChange(policy: LocalSignInPolicy) {
    setBusy('policy'); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/settings/sign-in', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localSignInPolicy: policy }),
      });
      const body = await res.json() as SignInStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not change the local sign-in policy.'); return; }
      reset(body);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  function copyRedirectUri() {
    if (!redirectUri) return;
    void navigator.clipboard.writeText(redirectUri);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-ink-muted" />
          Sign-in
          {status.isActive && <StatusBadge />}
        </CardTitle>
        <Button size="sm" variant="outline" onClick={handleTest} disabled={busy !== null}>
          {busy === 'test' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Test tenant
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {status.isActive ? <StatusDetail status={status} /> : <StatusLine status={status} />}

        {error && <Callout tone="error">{error}</Callout>}
        {success && <Callout tone="success">{success}</Callout>}

        {locked ? (
          <div className="space-y-2 text-xs leading-relaxed text-ink-2">
            <div className="flex items-start gap-2">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Set by <code className="font-mono text-ink">AUTH_MICROSOFT_ENTRA_ID_TENANT_ID</code>,{' '}
                <code className="font-mono text-ink">AUTH_MICROSOFT_ENTRA_ID_ID</code> and{' '}
                <code className="font-mono text-ink">AUTH_MICROSOFT_ENTRA_ID_SECRET</code> in this
                deployment’s environment. Remove them to manage sign-in here instead.
              </span>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-ink-2">
              Microsoft sign-in uses its own app registration, separate from the one used to connect
              Azure. Either reuse that app registration here, or register a new one. Neither choice
              needs Azure API permissions, only the redirect URI below.
            </p>

            {status.azureConnection && !status.azureConnection.secretUnreadable && (
              <div className="flex items-start gap-2.5 border border-border bg-surface-sunken px-3.5 py-2.5">
                <input
                  type="checkbox"
                  id="signin-reuse-azure"
                  checked={reuseAzure}
                  onChange={e => setReuseAzure(e.target.checked)}
                  className="mt-0.5 size-3.5 shrink-0 accent-ink"
                />
                <label htmlFor="signin-reuse-azure" className="min-w-0 flex-1 space-y-0.5 text-xs leading-relaxed text-ink-2">
                  <span className="block text-[13px] font-medium text-ink">
                    Reuse the Azure connection’s app registration
                  </span>
                  <span className="block break-all font-mono">
                    Tenant {status.azureConnection.tenantId} · App {status.azureConnection.clientId}
                  </span>
                  <span className="block">
                    Its stored secret is reused too, nothing to type here. You still need to add the
                    redirect URI below to that same app registration in Entra ID. Doing this means
                    that app registration both signs users in and holds Azure Reader access, rather
                    than keeping the two credentials separate.
                  </span>
                </label>
              </div>
            )}

            {!reuseAzure && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="signin-tenant-id">Tenant ID</Label>
                  <Input
                    id="signin-tenant-id"
                    value={tenantId}
                    onChange={e => setTenantId(e.target.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signin-client-id">Client ID (application ID)</Label>
                  <Input
                    id="signin-client-id"
                    value={clientId}
                    onChange={e => setClientId(e.target.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="signin-client-secret">Client secret</Label>
                  <Input
                    id="signin-client-secret"
                    type="password"
                    value={clientSecret}
                    onChange={e => setClientSecret(e.target.value)}
                    autoComplete="off"
                    placeholder={status.stored?.secretSet ? 'Already stored. Enter a new secret to replace it.' : 'Paste the secret Value, not its Secret ID'}
                  />
                  <FieldHint className="leading-relaxed">
                    Encrypted before it is written to disk, and never sent back to the browser.
                  </FieldHint>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Redirect URI (add this to the app registration’s Authentication settings)</Label>
              <div className="flex items-center gap-2">
                {/* scroll-x, not overflow-x-auto: CSS turns the other axis into `auto`
                    too, which gives a one-line code field a vertical scrollbar. */}
                <code className="scroll-x flex h-9 flex-1 items-center bg-surface-sunken px-3 font-mono text-xs whitespace-nowrap text-ink">
                  {redirectUri || '…'}
                </code>
                <Button size="icon-sm" variant="outline" onClick={copyRedirectUri} title="Copy redirect URI">
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={busy !== null || (reuseAzure ? false : !tenantId.trim() || !clientId.trim() || !clientSecret)}
              >
                {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                {status.stored ? 'Update sign-in' : 'Connect Microsoft'}
              </Button>
              {status.stored && (
                <Button size="sm" variant="destructive" onClick={handleRemove} disabled={busy !== null}>
                  <Trash2 className="size-3.5" />
                  Remove
                </Button>
              )}
            </div>
          </>
        )}

        <div className="space-y-2 border-t border-border pt-3">
          <Label htmlFor="signin-public-url">Public URL</Label>
          <p className="text-xs leading-relaxed text-ink-2">
            The address people actually reach RuleBeat at. Only needed behind a reverse proxy or a
            port mapping other than 3000, since RuleBeat otherwise detects it from the request.
            Setting it here takes effect immediately, with no restart needed.
          </p>
          <div className="flex items-center gap-2">
            <Input
              id="signin-public-url"
              value={publicUrl}
              onChange={e => setPublicUrlInput(e.target.value)}
              placeholder="https://rulebeat.example.com"
              className="flex-1 font-mono"
            />
            <Button size="sm" variant="outline" onClick={handlePublicUrlSave} disabled={busy !== null}>
              {busy === 'publicUrl' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>

        <div className="space-y-2 border-t border-border pt-3">
          <Label>Local sign-in</Label>
          <Select
            value={status.localSignInPolicy}
            disabled={busy !== null}
            onValueChange={v => { void handlePolicyChange(v as LocalSignInPolicy); }}
            options={POLICY_OPTIONS}
            aria-label="Local sign-in policy"
          />
          <p className="text-xs leading-relaxed text-ink-2">{POLICY_DESCRIPTIONS[status.localSignInPolicy]}</p>
          {status.localSignInPolicy !== 'always' && (
            <Callout tone="warn" icon={ShieldAlert}>
              If Microsoft sign-in ever breaks, set <code className="font-mono text-ink">RULEBEAT_FORCE_LOCAL_SIGNIN=true</code>{' '}
              on this deployment to restore the local form as an escape hatch.
            </Callout>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
