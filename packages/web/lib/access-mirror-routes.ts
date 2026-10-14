import { NextResponse } from 'next/server';
import { parseScope, type ScopeKind } from '@/lib/access-model';
import type { MirrorError, MirroredScope, ScopeOrigin } from '@/lib/access-mirror-model';
import { NO_AZURE_CONNECTION_MESSAGE } from '@/lib/manual-access';
import { getUser, type AppUser } from '@/lib/db/users';

export const MIRROR_ADMIN_MESSAGE = 'An Admin has access to everything and is never mirrored. Demote them first to choose their access.';
export const MIRROR_BAD_OBJECT_ID_MESSAGE = 'The Linked account must be an Azure object id, which is a GUID.';
export const MIRROR_BAD_ROLE_MESSAGE = 'Choose Viewer or Editor for mirrored access.';
export const INVITE_BOTH_SOURCES_MESSAGE = 'Mirrored access takes a Linked account, not a list of Scopes. Choose one.';
export const NOT_MIRRORED_MESSAGE =
  'This person has Manual access, so there is no Linked account to refresh. Give them Mirrored access first.';
export const REFRESH_RACE_MESSAGE =
  'This access changed while the refresh ran, so its result was not stored. Open the page again to see it.';

/** One Scope of a preview, as the page shows it: its path and kind, and the Azure roles that gave it. No tenant id. */
export interface PreviewScope {
  scope: string;
  kind: ScopeKind;
  origins: ScopeOrigin[];
}

export function previewScopes(scopes: readonly MirroredScope[]): PreviewScope[] {
  return scopes.flatMap(s => {
    const parsed = parseScope(s.scope);
    return parsed ? [{ scope: s.scope, kind: parsed.kind, origins: s.origins }] : [];
  });
}

/** The person a mirror route acts on, or the response that refuses it: unknown (404) or an Admin (400). */
export async function mirrorTarget(id: string): Promise<AppUser | NextResponse> {
  const user = await getUser(id);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (user.role === 'admin') return NextResponse.json({ error: MIRROR_ADMIN_MESSAGE }, { status: 400 });
  return user;
}

/**
 * The answer for a read that failed: 503 when Azure is not connected, 502 otherwise. The body holds a stable
 * message and the code behind it, never the error Azure threw.
 */
export function mirrorFailureResponse(error: MirrorError, extra: object = {}): NextResponse {
  const notConnected = error.code === 'azure_not_configured';
  return NextResponse.json(
    { ...extra, error: notConnected ? NO_AZURE_CONNECTION_MESSAGE : error.message, code: error.code },
    { status: notConnected ? 503 : 502 },
  );
}
