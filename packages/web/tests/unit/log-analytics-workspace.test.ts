/**
 * Spec 035 · the default Log Analytics workspace `queryBackend: 'log-analytics'` rules run against.
 *
 * Mirrors tests/unit/azure-credential.test.ts's shape, minus everything about secrets — there is
 * none here, since a workspace query is authorized by the Azure credential configured elsewhere.
 * Two promises to hold, same as the credential suite: the single-active-row invariant on the stored
 * table, and environment always winning over anything stored.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteLogAnalyticsWorkspace,
  getActiveLogAnalyticsWorkspace,
  listLogAnalyticsWorkspaces,
  markLogAnalyticsWorkspaceVerified,
  saveLogAnalyticsWorkspace,
} from '@/lib/db/log-analytics-workspace';
import {
  getLogAnalyticsWorkspaceStatus,
  resolveLogAnalyticsWorkspaceId,
} from '@/lib/log-analytics-workspace';

const WORKSPACE_A = '11111111-1111-1111-1111-111111111111';
const WORKSPACE_B = '22222222-2222-2222-2222-222222222222';
const ENV_WORKSPACE = '33333333-3333-3333-3333-333333333333';

const ENV_KEY = 'RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID';

let savedEnv: string | undefined;

async function clearStoredWorkspaces(): Promise<void> {
  for (const w of await listLogAnalyticsWorkspaces()) await deleteLogAnalyticsWorkspace(w.id);
}

beforeEach(async () => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  await clearStoredWorkspaces();
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  await clearStoredWorkspaces();
});

describe('stored workspace · single-active-row invariant', () => {
  it('creates a new active row when none exists', async () => {
    const saved = await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(saved.isActive).toBe(true);
    expect(saved.workspaceId).toBe(WORKSPACE_A);
    expect((await getActiveLogAnalyticsWorkspace())?.id).toBe(saved.id);
  });

  it('replaces the active row rather than adding a second one', async () => {
    await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_B });

    expect(await listLogAnalyticsWorkspaces()).toHaveLength(1);
    expect((await listLogAnalyticsWorkspaces()).filter(w => w.isActive)).toHaveLength(1);
    expect((await getActiveLogAnalyticsWorkspace())?.workspaceId).toBe(WORKSPACE_B);
  });

  it('clears lastVerifiedAt when the workspace id is replaced', async () => {
    const first = await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    await markLogAnalyticsWorkspaceVerified(first.id);
    expect((await getActiveLogAnalyticsWorkspace())?.lastVerifiedAt).not.toBeNull();

    // A verification against the old workspace id proves nothing about the new one.
    const second = await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_B });
    expect(second.lastVerifiedAt).toBeNull();
  });

  it('markLogAnalyticsWorkspaceVerified records a timestamp on the right row', async () => {
    const saved = await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(saved.lastVerifiedAt).toBeNull();
    await markLogAnalyticsWorkspaceVerified(saved.id);
    expect((await getActiveLogAnalyticsWorkspace())?.lastVerifiedAt).not.toBeNull();
  });

  it('deletes the stored row, leaving nothing active', async () => {
    const saved = await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(await deleteLogAnalyticsWorkspace(saved.id)).toBe(true);
    expect(await getActiveLogAnalyticsWorkspace()).toBeNull();
    expect(await listLogAnalyticsWorkspaces()).toHaveLength(0);
  });

  it('reports false deleting a row that does not exist', async () => {
    expect(await deleteLogAnalyticsWorkspace('not-a-real-id')).toBe(false);
  });

  it('defaults the name from the workspace id when none is given', async () => {
    const saved = await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(saved.name).toContain(WORKSPACE_A);
  });
});

describe('resolveLogAnalyticsWorkspaceId · resolution order', () => {
  it('returns null when nothing is configured', async () => {
    expect(await resolveLogAnalyticsWorkspaceId()).toBeNull();
  });

  it('uses the stored workspace when the environment has none', async () => {
    await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    const resolved = await resolveLogAnalyticsWorkspaceId();
    expect(resolved?.source).toBe('stored');
    expect(resolved?.workspaceId).toBe(WORKSPACE_A);
    expect(resolved?.storedWorkspaceRowId).toBeDefined();
  });

  it('prefers the environment variable over a stored workspace', async () => {
    // The load-bearing case, same as the Azure credential: a template deployment that names a
    // workspace in its environment must not be silently overridden by something typed into Settings.
    await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    process.env[ENV_KEY] = ENV_WORKSPACE;

    const resolved = await resolveLogAnalyticsWorkspaceId();
    expect(resolved?.source).toBe('env');
    expect(resolved?.workspaceId).toBe(ENV_WORKSPACE);
    expect(resolved?.storedWorkspaceRowId).toBeUndefined();
  });

  it('ignores an empty environment variable rather than treating it as configured', async () => {
    process.env[ENV_KEY] = '';
    await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect((await resolveLogAnalyticsWorkspaceId())?.source).toBe('stored');
  });

  it('has no ambient chain fallback — unconfigured stays unconfigured', async () => {
    // Unlike await resolveAzureCredential(), there is no DefaultAzureCredential-style discovery for a
    // workspace id: either one is named, or the caller gets null, never a guess.
    expect(await resolveLogAnalyticsWorkspaceId()).toBeNull();
  });
});

describe('getLogAnalyticsWorkspaceStatus', () => {
  it('reports not configured when nothing is set', async () => {
    const status = await getLogAnalyticsWorkspaceStatus();
    expect(status.configured).toBe(false);
    expect(status.source).toBeNull();
    expect(status.managedByEnv).toBe(false);
    expect(status.stored).toBeNull();
  });

  it('marks the workspace as environment-managed so the UI can lock the form', async () => {
    process.env[ENV_KEY] = ENV_WORKSPACE;
    const status = await getLogAnalyticsWorkspaceStatus();
    expect(status.configured).toBe(true);
    expect(status.managedByEnv).toBe(true);
    expect(status.source).toBe('env');
    expect(status.workspaceId).toBe(ENV_WORKSPACE);
  });

  it('reports a stored workspace as configured and not environment-managed', async () => {
    await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    const status = await getLogAnalyticsWorkspaceStatus();
    expect(status.configured).toBe(true);
    expect(status.managedByEnv).toBe(false);
    expect(status.source).toBe('stored');
    expect(status.workspaceId).toBe(WORKSPACE_A);
    expect(status.stored?.workspaceId).toBe(WORKSPACE_A);
  });

  it('still surfaces the stored row even when the environment is what is actually active', async () => {
    // managedByEnv means "env wins at resolution time", not "nothing is stored" — the settings
    // screen still needs to show what would take over if the env var were removed.
    await saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    process.env[ENV_KEY] = ENV_WORKSPACE;
    const status = await getLogAnalyticsWorkspaceStatus();
    expect(status.managedByEnv).toBe(true);
    expect(status.stored?.workspaceId).toBe(WORKSPACE_A);
  });
});
