import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { countAdminsWithPassword } from '@/lib/db/local-accounts';
import { deleteSsoProvider, saveSsoProvider } from '@/lib/db/sso-providers';
import { getActiveAzureCredential } from '@/lib/db/azure-credentials';
import {
  getSignInStatus, probeTenant, setLocalSignInPolicy, setPublicUrl, syncAuthUrlMirror,
  type LocalSignInPolicy,
} from '@/lib/sign-in-config';

/**
 * Settings → Sign-in (B1b). Admin-only on every verb, reads included — the response names the
 * tenant and app registration RuleBeat signs people in with, which is deployment configuration
 * rather than findings data, matching Settings → Azure connection.
 *
 * The client secret travels in exactly one direction, same discipline as the Azure connection
 * route: accepted here, encrypted before it touches the database, never returned by any handler.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLocalSignInPolicy(value: unknown): value is LocalSignInPolicy {
  return value === 'always' || value === 'break-glass' || value === 'disabled';
}

export async function GET() {
  const actor = await requireRole('auth:manage');
  if (actor instanceof NextResponse) return actor;

  return NextResponse.json(await getSignInStatus());
}

export async function PUT(req: Request) {
  const actor = await requireRole('auth:manage');
  if (actor instanceof NextResponse) return actor;

  let body: {
    tenantId?: string; clientId?: string; clientSecret?: string; localSignInPolicy?: string;
    publicUrl?: string; reuseAzureConnection?: boolean;
  };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  if (body.publicUrl !== undefined) {
    const trimmed = body.publicUrl.trim();
    if (trimmed) {
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        return NextResponse.json({ error: 'Enter a full URL, including http:// or https://.' }, { status: 400 });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return NextResponse.json({ error: 'The public URL must use http or https.' }, { status: 400 });
      }
      const normalized = `${parsed.protocol}//${parsed.host}`;
      await setPublicUrl(normalized);
      // Same call instrumentation.ts makes at boot, so the new value takes effect immediately
      // rather than on the next restart, which is what the Settings copy promises. It is a no-op
      // when the operator set AUTH_URL in the environment themselves.
      syncAuthUrlMirror(normalized);
      await writeAudit({
        actor,
        action: 'sign_in_config.public_url_set',
        entityType: 'sign_in_config',
        summary: `${actor.email} set the public URL to ${normalized}`,
        details: { publicUrl: normalized },
      });
    } else {
      await setPublicUrl(null);
      syncAuthUrlMirror(null);
      await writeAudit({
        actor,
        action: 'sign_in_config.public_url_clear',
        entityType: 'sign_in_config',
        summary: `${actor.email} cleared the configured public URL`,
      });
    }
  }

  if (body.localSignInPolicy !== undefined) {
    if (!isLocalSignInPolicy(body.localSignInPolicy)) {
      return NextResponse.json({ error: 'Unknown local sign-in policy.' }, { status: 400 });
    }
    // The lockout guard that matters most on this screen: restricting local sign-in while no
    // admin can actually use it would lock the install out of its own console, with no recovery
    // short of RULEBEAT_FORCE_LOCAL_SIGNIN or editing SQLite by hand.
    if (body.localSignInPolicy !== 'always' && await countAdminsWithPassword() === 0) {
      return NextResponse.json({
        error: 'At least one admin needs a local password before local sign-in can be restricted. '
          + 'Set one for yourself or another admin in the Users table first.',
      }, { status: 409 });
    }

    await setLocalSignInPolicy(body.localSignInPolicy);
    await writeAudit({
      actor,
      action: 'sign_in_config.policy_change',
      entityType: 'sign_in_config',
      summary: `${actor.email} set the local sign-in policy to ${body.localSignInPolicy}`,
      details: { localSignInPolicy: body.localSignInPolicy },
    });
  }

  const reuseAzureConnection = body.reuseAzureConnection === true;
  const changingProvider = reuseAzureConnection
    || body.tenantId !== undefined || body.clientId !== undefined || body.clientSecret !== undefined;
  if (changingProvider) {
    const status = await getSignInStatus();
    if (status.managedByEnv) {
      // Saving would appear to work and then change nothing, since env wins at resolution time.
      return NextResponse.json({
        error: 'Microsoft sign-in is set by this deployment’s environment variables. '
          + 'Change them there, or remove them to manage sign-in here.',
      }, { status: 409 });
    }

    let tenantId: string;
    let clientId: string;
    let clientSecret: string;

    if (reuseAzureConnection) {
      // Copies the already-encrypted Azure connection credential straight through, server-side —
      // the secret never travels to the browser for this path, unlike the manual-entry one below.
      const azureCred = await getActiveAzureCredential();
      if (!azureCred) {
        return NextResponse.json({
          error: 'No Azure connection is configured to reuse. Connect Azure first, or enter '
            + 'Microsoft sign-in details manually below.',
        }, { status: 409 });
      }
      tenantId = azureCred.tenantId;
      clientId = azureCred.clientId;
      clientSecret = azureCred.clientSecret;
    } else {
      tenantId = body.tenantId?.trim() ?? '';
      clientId = body.clientId?.trim() ?? '';
      clientSecret = body.clientSecret ?? '';

      if (!GUID.test(tenantId)) {
        return NextResponse.json({ error: 'Tenant ID must be a GUID.' }, { status: 400 });
      }
      if (!GUID.test(clientId)) {
        return NextResponse.json({ error: 'Client ID (application ID) must be a GUID.' }, { status: 400 });
      }
      if (!clientSecret.trim()) {
        return NextResponse.json({ error: 'Client secret is required.' }, { status: 400 });
      }
    }

    // A cheap, honest check — catches a typo'd tenant instantly, but doesn't prove the client id,
    // secret or redirect URI are right. It saves inactive regardless; only a real sign-in flips it.
    const probe = await probeTenant(tenantId);
    if (!probe.ok) {
      return NextResponse.json({ error: probe.error }, { status: 400 });
    }

    try {
      await saveSsoProvider({
        provider: 'microsoft-entra-id',
        tenantId,
        clientId,
        clientSecret,
        createdBy: actor.email,
      });

      await writeAudit({
        actor,
        action: 'sign_in_config.save',
        entityType: 'sign_in_config',
        summary: reuseAzureConnection
          ? `Configured Microsoft sign-in for tenant ${tenantId}, reusing the Azure connection app registration (not yet verified)`
          : `Configured Microsoft sign-in for tenant ${tenantId} (not yet verified)`,
        // Field names only — the secret and its length are both absent by design.
        details: { fields: ['tenantId', 'clientId', 'clientSecret'], reusedAzureConnection: reuseAzureConnection },
      });
    } catch (err) {
      return serverError('Failed to save sign-in configuration', err);
    }
  }

  return NextResponse.json(await getSignInStatus());
}

export async function DELETE() {
  const actor = await requireRole('auth:manage');
  if (actor instanceof NextResponse) return actor;

  const status = await getSignInStatus();
  if (!status.stored) {
    return NextResponse.json({ error: 'There is no stored sign-in configuration to remove.' }, { status: 404 });
  }

  try {
    await deleteSsoProvider(status.stored.id);
    await writeAudit({
      actor,
      action: 'sign_in_config.delete',
      entityType: 'sign_in_config',
      entityId: status.stored.id,
      summary: `Removed the stored Microsoft sign-in configuration for tenant ${status.stored.tenantId}`,
    });
    return NextResponse.json(await getSignInStatus());
  } catch (err) {
    return serverError('Failed to remove sign-in configuration', err);
  }
}
