'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { CodeBlock } from '@/components/ui/code-block';
import { FieldHint, Input, Label } from '@/components/ui/input';
import type { AzureConnectionStatus, AzureCredentialSource } from '@/lib/azure-credential';
import { redirectUriFor, isLoopbackIpOrigin, normalizeLoopbackOrigin } from '@/lib/redirect-uri';
import { Cloud, Loader2, Lock, Plug } from 'lucide-react';

/**
 * Onboarding step 1 — connect Azure.
 *
 * Two shapes, decided in the plan for this feature:
 *  - `managedByEnv`: the credential comes from environment variables. Rather than skipping this step
 *    entirely (the launch plan's original wording), it renders a read-only confirmation with a
 *    Verify button — a template deployment whose service principal was never granted Reader
 *    authenticates fine and sees zero subscriptions, and skipping the step means that install only
 *    discovers the problem at 3am on its first scheduled scan. One round trip, one button.
 *  - otherwise: the same tenant/client/secret form as Settings → Azure connection, saved through the
 *    same verify-before-persist endpoint.
 */

const SETUP_COMMANDS = `# 1. Create the service principal
az ad sp create-for-rbac --name "RuleBeat" --role Reader \\
  --scopes /subscriptions/<subscription-id>

# 2. Note the appId, password and tenant it prints — those are the
#    client ID, client secret and tenant ID below. The password is
#    shown only once.

# 3. Optional, for identity checks in step 2: grant Microsoft Graph
#    Application.Read.All to the same app registration and grant
#    admin consent.

# See docs/public/permissions.md for the full guide, including the
# Azure Portal equivalent of every command above.`;

export function ConnectStep({
  status, onVerified, onNext,
}: {
  status: AzureConnectionStatus;
  onVerified: (status: AzureConnectionStatus) => void;
  onNext: () => void;
}) {
  const [tenantId, setTenantId] = useState(status.stored?.tenantId ?? '');
  const [clientId, setClientId] = useState(status.stored?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'continue' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [verifiedSubs, setVerifiedSubs] = useState<number | null>(null);
  const [enableSignIn, setEnableSignIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  // Deferred to an effect rather than read directly in render: a `typeof window` branch in render
  // renders '' on the server and the real origin on the client's very first (pre-hydration) pass,
  // a guaranteed hydration mismatch. Starting at '' and filling it in after mount keeps the first
  // client render identical to the server's.
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  // Entra refuses a redirect URI on an IP literal, and install.md tells people to bind
  // 127.0.0.1, so show the localhost form and say why rather than an unregisterable value.
  const originIsLoopbackIp = isLoopbackIpOrigin(origin);
  const redirectUri = origin ? redirectUriFor(normalizeLoopbackOrigin(origin)) : '';

  async function handleContinue() {
    if (!enableSignIn) { onNext(); return; }
    setBusy('continue'); setSignInError(null);
    try {
      const res = await fetch('/api/settings/sign-in', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reuseAzureConnection: true }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) { setSignInError(body.error ?? 'Could not enable Microsoft sign-in.'); return; }
      onNext();
    } catch {
      setSignInError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  async function handleTestLive() {
    setBusy('test'); setError(null);
    try {
      const res = await fetch('/api/settings/azure-connection/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json() as { ok?: boolean; subscriptionCount?: number; error?: string };
      if (body.ok) {
        setVerified(true);
        setVerifiedSubs(body.subscriptionCount ?? null);
      } else {
        setVerified(false);
        setError(body.error ?? 'The connection test failed.');
      }
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  async function handleSave() {
    setBusy('save'); setError(null);
    try {
      const res = await fetch('/api/settings/azure-connection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret }),
      });
      const body = await res.json() as AzureConnectionStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not save the connection.'); return; }
      setVerified(true);
      setVerifiedSubs(body.stored?.lastVerifiedSubscriptions ?? null);
      onVerified(body);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="size-4 text-ink-muted" />
          Connect Azure
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-2">
          RuleBeat reads Azure with a service principal that only needs the{' '}
          <strong className="font-medium text-ink">Reader</strong> role. It never creates that
          service principal and never requests write access.{' '}
          <button
            type="button"
            onClick={() => setShowHelp(h => !h)}
            className="font-medium text-ink underline underline-offset-2 hover:no-underline"
          >
            {showHelp ? 'Hide the commands' : 'Show me how'}
          </button>
        </p>

        {showHelp && <CodeBlock code={SETUP_COMMANDS} title="Create the service principal" />}

        {error && <Callout tone="error">{error}</Callout>}
        {verified && (
          <Callout tone="success">
            Reached Azure.{verifiedSubs != null ? ` ${verifiedSubs} subscription${verifiedSubs === 1 ? '' : 's'} visible.` : ''}
          </Callout>
        )}

        {status.managedByEnv ? (
          <>
            {/* Not a warning: a credential coming from the environment is the
                recommended shape, so it states the fact on a plain ground. */}
            <div className="space-y-1.5 border border-border bg-surface-sunken px-3.5 py-3 text-xs">
              <div className="flex items-start gap-2 text-ink-2">
                <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-muted" />
                <span>{ENV_SOURCE_LABEL[status.source ?? 'chain']} is supplying this credential from the environment.</span>
              </div>
              {status.tenantId && (
                <p className="break-all font-mono text-ink">
                  Tenant {status.tenantId}{status.clientId ? ` · App ${status.clientId}` : ''}
                </p>
              )}
            </div>
            <Button size="sm" onClick={handleTestLive} disabled={busy !== null}>
              {busy === 'test' ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
              Verify
            </Button>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="onboarding-tenant-id">Tenant ID</Label>
                <Input
                  id="onboarding-tenant-id"
                  value={tenantId}
                  onChange={e => setTenantId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="onboarding-client-id">Client ID (application ID)</Label>
                <Input
                  id="onboarding-client-id"
                  value={clientId}
                  onChange={e => setClientId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="onboarding-client-secret">Client secret</Label>
                <Input
                  id="onboarding-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={e => setClientSecret(e.target.value)}
                  autoComplete="off"
                  placeholder="Paste the secret Value, not its Secret ID"
                />
                <FieldHint className="leading-relaxed">
                  Encrypted before it is written to disk, and verified against Azure before it is saved.
                </FieldHint>
              </div>
            </div>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={busy !== null || !tenantId.trim() || !clientId.trim() || !clientSecret}
            >
              {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
              Connect Azure
            </Button>
          </>
        )}

        {verified && (
          <div className="flex items-start gap-2.5 border border-border bg-surface-sunken px-3.5 py-2.5">
            <input
              type="checkbox"
              id="onboarding-enable-signin"
              checked={enableSignIn}
              onChange={e => setEnableSignIn(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-ink"
            />
            <label htmlFor="onboarding-enable-signin" className="min-w-0 flex-1 space-y-1 text-xs leading-relaxed text-ink-2">
              <span className="block text-[13px] font-medium text-ink">
                Also use this app registration for Microsoft sign-in
              </span>
              <span className="block">
                Lets people sign in with Microsoft instead of a local password, using this same
                credential. That app registration then both signs users in and holds Azure Reader
                access, rather than keeping the two separate. You can undo this anytime from
                Settings → Sign-in, or set it up there later with a different app registration
                instead.
              </span>
              {enableSignIn && (
                <span className="block">
                  Add this redirect URI to the app registration’s Authentication settings in Entra
                  ID:{' '}
                  <code className="break-all font-mono text-ink">{redirectUri || '…'}</code>
                </span>
              )}
              {enableSignIn && originIsLoopbackIp && (
                <span className="block text-destructive">
                  Microsoft rejects a redirect URI on an IP address, so the one above uses
                  localhost. Reach RuleBeat at{' '}
                  <code className="font-mono">{normalizeLoopbackOrigin(origin)}</code> so sign-in
                  sends the same address, or set Public URL in Settings → Sign-in to match.
                </span>
              )}
            </label>
          </div>
        )}

        {signInError && <Callout tone="error">{signInError}</Callout>}

        <div className="flex justify-end border-t border-border pt-2">
          <Button onClick={handleContinue} disabled={!verified || busy !== null}>
            {busy === 'continue' ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Continue
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const ENV_SOURCE_LABEL: Record<AzureCredentialSource, string> = {
  'env-federated': 'Workload identity federation',
  'env-certificate': 'A service principal certificate',
  'env-secret-file': 'A service principal secret (mounted file)',
  'env-secret': 'A service principal secret (environment variable)',
  stored: 'A credential stored in RuleBeat',
  chain: 'Managed identity or Azure CLI sign-in',
};
