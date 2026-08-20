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

function clearStoredWorkspaces(): void {
  for (const w of listLogAnalyticsWorkspaces()) deleteLogAnalyticsWorkspace(w.id);
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  clearStoredWorkspaces();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  clearStoredWorkspaces();
});

describe('stored workspace · single-active-row invariant', () => {
  it('creates a new active row when none exists', () => {
    const saved = saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(saved.isActive).toBe(true);
    expect(saved.workspaceId).toBe(WORKSPACE_A);
    expect(getActiveLogAnalyticsWorkspace()?.id).toBe(saved.id);
  });

  it('replaces the active row rather than adding a second one', () => {
    saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_B });

    expect(listLogAnalyticsWorkspaces()).toHaveLength(1);
    expect(listLogAnalyticsWorkspaces().filter(w => w.isActive)).toHaveLength(1);
    expect(getActiveLogAnalyticsWorkspace()?.workspaceId).toBe(WORKSPACE_B);
  });

  it('clears lastVerifiedAt when the workspace id is replaced', () => {
    const first = saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    markLogAnalyticsWorkspaceVerified(first.id);
    expect(getActiveLogAnalyticsWorkspace()?.lastVerifiedAt).not.toBeNull();

    // A verification against the old workspace id proves nothing about the new one.
    const second = saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_B });
    expect(second.lastVerifiedAt).toBeNull();
  });

  it('markLogAnalyticsWorkspaceVerified records a timestamp on the right row', () => {
    const saved = saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(saved.lastVerifiedAt).toBeNull();
    markLogAnalyticsWorkspaceVerified(saved.id);
    expect(getActiveLogAnalyticsWorkspace()?.lastVerifiedAt).not.toBeNull();
  });

  it('deletes the stored row, leaving nothing active', () => {
    const saved = saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(deleteLogAnalyticsWorkspace(saved.id)).toBe(true);
    expect(getActiveLogAnalyticsWorkspace()).toBeNull();
    expect(listLogAnalyticsWorkspaces()).toHaveLength(0);
  });

  it('reports false deleting a row that does not exist', () => {
    expect(deleteLogAnalyticsWorkspace('not-a-real-id')).toBe(false);
  });

  it('defaults the name from the workspace id when none is given', () => {
    const saved = saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(saved.name).toContain(WORKSPACE_A);
  });
});

describe('resolveLogAnalyticsWorkspaceId · resolution order', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveLogAnalyticsWorkspaceId()).toBeNull();
  });

  it('uses the stored workspace when the environment has none', () => {
    saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    const resolved = resolveLogAnalyticsWorkspaceId();
    expect(resolved?.source).toBe('stored');
    expect(resolved?.workspaceId).toBe(WORKSPACE_A);
    expect(resolved?.storedWorkspaceRowId).toBeDefined();
  });

  it('prefers the environment variable over a stored workspace', () => {
    // The load-bearing case, same as the Azure credential: a template deployment that names a
    // workspace in its environment must not be silently overridden by something typed into Settings.
    saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    process.env[ENV_KEY] = ENV_WORKSPACE;

    const resolved = resolveLogAnalyticsWorkspaceId();
    expect(resolved?.source).toBe('env');
    expect(resolved?.workspaceId).toBe(ENV_WORKSPACE);
    expect(resolved?.storedWorkspaceRowId).toBeUndefined();
  });

  it('ignores an empty environment variable rather than treating it as configured', () => {
    process.env[ENV_KEY] = '';
    saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    expect(resolveLogAnalyticsWorkspaceId()?.source).toBe('stored');
  });

  it('has no ambient chain fallback — unconfigured stays unconfigured', () => {
    // Unlike resolveAzureCredential(), there is no DefaultAzureCredential-style discovery for a
    // workspace id: either one is named, or the caller gets null, never a guess.
    expect(resolveLogAnalyticsWorkspaceId()).toBeNull();
  });
});

describe('getLogAnalyticsWorkspaceStatus', () => {
  it('reports not configured when nothing is set', () => {
    const status = getLogAnalyticsWorkspaceStatus();
    expect(status.configured).toBe(false);
    expect(status.source).toBeNull();
    expect(status.managedByEnv).toBe(false);
    expect(status.stored).toBeNull();
  });

  it('marks the workspace as environment-managed so the UI can lock the form', () => {
    process.env[ENV_KEY] = ENV_WORKSPACE;
    const status = getLogAnalyticsWorkspaceStatus();
    expect(status.configured).toBe(true);
    expect(status.managedByEnv).toBe(true);
    expect(status.source).toBe('env');
    expect(status.workspaceId).toBe(ENV_WORKSPACE);
  });

  it('reports a stored workspace as configured and not environment-managed', () => {
    saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    const status = getLogAnalyticsWorkspaceStatus();
    expect(status.configured).toBe(true);
    expect(status.managedByEnv).toBe(false);
    expect(status.source).toBe('stored');
    expect(status.workspaceId).toBe(WORKSPACE_A);
    expect(status.stored?.workspaceId).toBe(WORKSPACE_A);
  });

  it('still surfaces the stored row even when the environment is what is actually active', () => {
    // managedByEnv means "env wins at resolution time", not "nothing is stored" — the settings
    // screen still needs to show what would take over if the env var were removed.
    saveLogAnalyticsWorkspace({ workspaceId: WORKSPACE_A });
    process.env[ENV_KEY] = ENV_WORKSPACE;
    const status = getLogAnalyticsWorkspaceStatus();
    expect(status.managedByEnv).toBe(true);
    expect(status.stored?.workspaceId).toBe(WORKSPACE_A);
  });
});
