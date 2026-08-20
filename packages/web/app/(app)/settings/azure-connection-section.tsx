'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { CodeBlock } from '@/components/ui/code-block';
import { FieldHint, Input, Label } from '@/components/ui/input';
import type { AzureConnectionStatus, AzureCredentialSource } from '@/lib/azure-credential';
import { Check, Cloud, ExternalLink, Lock, Loader2, Plug, Trash2 } from 'lucide-react';

/**
 * Settings → Azure connection.
 *
 * Mirrors what Prowler and CloudQuery do: the tool's own sign-in is deployment configuration, but
 * the credential it reads the cloud with is entered here, after login. RuleBeat never creates the
 * service principal — creating an app registration and assigning roles are write operations, and
 * a governance tool that could grant itself permissions is a privilege-escalation primitive.
 */

/**
 * Which variables are actually supplying the credential, so the lock message can name the exact
 * lines to edit instead of gesturing at "your configuration". `AZURE_TENANT_ID` is deliberately
 * left out — removing it would break sign-in too, which is not what anyone wants here.
 */
const ENV_VARS_BY_SOURCE: Partial<Record<AzureCredentialSource, string[]>> = {
  'env-federated': ['AZURE_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE'],
  'env-certificate': ['AZURE_CLIENT_ID', 'AZURE_CLIENT_CERTIFICATE_PATH'],
  'env-secret-file': ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET_FILE'],
  'env-secret': ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
};

/** Where those variables live, per deployment. Listing all three beats guessing wrong. */
const ENV_LOCATIONS: [string, string][] = [
  ['Docker', '.env beside docker-compose.yml, then: docker compose up -d'],
  ['Local development', 'packages/web/.env.local, then restart the dev server'],
  ['Azure App Service / Container Apps', 'the application settings in the portal'],
];

const SETUP_COMMANDS = `# 1. Create the service principal (an Application Administrator can do this)
az ad sp create-for-rbac --name "RuleBeat" --role Reader \\
  --scopes /subscriptions/<subscription-id>

# 2. Note the appId, password and tenant it prints. Those are the client ID,
#    client secret and tenant ID below. The password is shown only once.

# 3. Optional, for the identity checks: grant Microsoft Graph
#    Application.Read.All to the same app registration and grant admin consent.`;

/* Connected is the ordinary state, so it gets a quiet chip with a single green tick
 * rather than a filled green pill. A permanently-lit success panel on a card that has
 * done nothing noteworthy is exactly the noise this pass is removing. */
function StatusBadge({ status }: { status: AzureConnectionStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-2">
      <Check className="size-3 shrink-0 text-status-ok" />
      {status.sourceLabel ?? 'Connected'}
    </span>
  );
}

function StatusDetail({ status }: { status: AzureConnectionStatus }) {
  if (!status.tenantId && !status.stored?.lastVerifiedAt) return null;
  return (
    <p className="text-xs text-ink-muted">
      {status.tenantId && (
        <span className="break-all font-mono">
          Tenant {status.tenantId}
          {status.clientId ? ` · App ${status.clientId}` : ''}
        </span>
      )}
      {status.stored?.lastVerifiedAt && (
        <span>
          {status.tenantId && ' · '}
          Last verified {new Date(status.stored.lastVerifiedAt).toLocaleString()}
          {status.stored.lastVerifiedSubscriptions != null
            && ` · ${status.stored.lastVerifiedSubscriptions} subscriptions visible`}
        </span>
      )}
    </p>
  );
}

export function AzureConnectionSection({ initialStatus }: { initialStatus: AzureConnectionStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [tenantId, setTenantId] = useState(initialStatus.stored?.tenantId ?? '');
  const [clientId, setClientId] = useState(initialStatus.stored?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const locked = status.managedByEnv;

  function reset(next: AzureConnectionStatus) {
    setStatus(next);
    setTenantId(next.stored?.tenantId ?? '');
    setClientId(next.stored?.clientId ?? '');
    setClientSecret('');
  }

  async function handleSave() {
    setBusy('save'); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/settings/azure-connection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret }),
      });
      const body = await res.json() as AzureConnectionStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not save the connection.'); return; }
      reset(body);
      setSuccess('Saved. RuleBeat verified this credential against Azure before storing it.');
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  async function handleRemove() {
    if (!confirm('Remove the stored Azure connection? Scans will stop until another credential is available.')) return;
    setBusy('remove'); setError(null); setSuccess(null);
    try {
      const res = await fetch('/api/settings/azure-connection', { method: 'DELETE' });
      const body = await res.json() as AzureConnectionStatus & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not remove the connection.'); return; }
      reset(body);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setBusy(null); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cloud className="size-4 text-ink-muted" />
          Azure connection
          {status.configured && <StatusBadge status={status} />}
        </CardTitle>
        {status.configured && (
          <Link href="/diagnostics" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <ExternalLink className="size-3.5" />
            View diagnostics
          </Link>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {status.configured ? (
          <StatusDetail status={status} />
        ) : (
          <Callout tone="warn" title="Azure is not connected">
            {status.message}
          </Callout>
        )}

        {error && <Callout tone="error">{error}</Callout>}
        {success && <Callout tone="success">{success}</Callout>}

        {locked ? (
          <div className="space-y-3 text-xs leading-relaxed text-ink-2">
            <div className="flex items-start gap-2">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Environment variables always win over anything entered here. That&apos;s why there&apos;s no
                form on this card, and why a template or automated deployment never has to be
                configured twice.
              </span>
            </div>

            <div className="space-y-2 pl-5.5">
              <p className="font-medium text-ink">To change the credential</p>
              <p>
                Edit{' '}
                {(ENV_VARS_BY_SOURCE[status.source!] ?? ['the Azure variables']).map((v, i, all) => (
                  <span key={v}>
                    <code className="font-mono text-ink">{v}</code>
                    {i < all.length - 2 ? ', ' : i === all.length - 2 ? ' and ' : ''}
                  </span>
                ))}{' '}
                where this deployment defines them, then restart:
              </p>
              <ul className="space-y-1">
                {ENV_LOCATIONS.map(([where, how]) => (
                  <li key={where} className="flex gap-2">
                    <span className="shrink-0 text-ink">{where}:</span>
                    <span className="break-all font-mono">{how}</span>
                  </li>
                ))}
              </ul>
              <p className="pt-1">
                <span className="font-medium text-ink">To manage it here instead</span>,
                remove those variables and restart. RuleBeat will then fall back to a managed
                identity or your <code className="font-mono">az login</code> session, and this card
                becomes editable.
              </p>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-ink-2">
              RuleBeat reads Azure with a service principal that only needs the <strong className="font-medium text-ink">Reader</strong>{' '}
              role. It never creates that service principal and never requests write access. You
              create it, and you can verify what it can do in Azure RBAC at any time.{' '}
              <button
                type="button"
                onClick={() => setShowHelp(h => !h)}
                className="font-medium text-ink underline underline-offset-2 hover:no-underline"
              >
                {showHelp ? 'Hide the commands' : 'Show me how'}
              </button>
            </p>

            {showHelp && <CodeBlock code={SETUP_COMMANDS} title="Create the service principal" />}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="azure-tenant-id">Tenant ID</Label>
                <Input
                  id="azure-tenant-id"
                  value={tenantId}
                  onChange={e => setTenantId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="azure-client-id">Client ID (application ID)</Label>
                <Input
                  id="azure-client-id"
                  value={clientId}
                  onChange={e => setClientId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="azure-client-secret">Client secret</Label>
                <Input
                  id="azure-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={e => setClientSecret(e.target.value)}
                  autoComplete="off"
                  placeholder={status.stored?.secretSet ? 'Already stored. Enter a new secret to replace it.' : 'Paste the secret Value, not its Secret ID'}
                />
                <FieldHint className="leading-relaxed">
                  Encrypted before it is written to disk, and never sent back to the browser. A
                  managed identity or workload identity federation is a stronger option where the
                  deployment supports it. See <code className="font-mono text-ink-2">.env.example</code>.
                </FieldHint>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={busy !== null || !tenantId.trim() || !clientId.trim() || !clientSecret}
              >
                {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                {status.stored ? 'Update connection' : 'Connect Azure'}
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
      </CardContent>
    </Card>
  );
}
