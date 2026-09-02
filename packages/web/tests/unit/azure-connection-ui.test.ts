/**
 * The Connect step's "is there anything to type" decision (lib/azure-connection-ui.ts). Issue #89:
 * with only AZURE_TENANT_ID set and a managed identity on the host, the connection status is
 * `source: 'chain'`, `managedByEnv: false`, and keying the step on `managedByEnv` alone showed the
 * service principal form and left Continue disabled forever. Tested here rather than by rendering
 * the component, which this codebase deliberately has no layer for.
 */
import { describe, expect, it } from 'vitest';
import { ambientCredentialCopy, credentialIsAmbient } from '@/lib/azure-connection-ui';

describe('credentialIsAmbient', () => {
  it('is true for a credential supplied by the environment', () => {
    expect(credentialIsAmbient({ managedByEnv: true, source: 'env-secret' })).toBe(true);
    expect(credentialIsAmbient({ managedByEnv: true, source: 'env-federated' })).toBe(true);
  });

  it('is true for the host chain (managed identity or az login), which managedByEnv does not cover', () => {
    expect(credentialIsAmbient({ managedByEnv: false, source: 'chain' })).toBe(true);
  });

  it('is false for a stored credential and for nothing configured, where the form is the point', () => {
    expect(credentialIsAmbient({ managedByEnv: false, source: 'stored' })).toBe(false);
    expect(credentialIsAmbient({ managedByEnv: false, source: null })).toBe(false);
  });
});

describe('ambientCredentialCopy', () => {
  it('tells a managed-identity install there is nothing to enter and what Verify does', () => {
    const copy = ambientCredentialCopy({ managedByEnv: false, source: 'chain' });
    expect(copy).toMatch(/managed identity/);
    expect(copy).toMatch(/nothing to enter/i);
    expect(copy).toMatch(/Verify/);
    // The environment wording would be false here: nothing in the environment supplies it.
    expect(copy).not.toMatch(/from the environment/);
  });

  it('names the environment source for an env-supplied credential', () => {
    expect(ambientCredentialCopy({ managedByEnv: true, source: 'env-secret-file' }))
      .toBe('A service principal secret (mounted file) is supplying this credential from the environment.');
    expect(ambientCredentialCopy({ managedByEnv: true, source: 'env-federated' }))
      .toMatch(/^Workload identity federation is supplying/);
  });
});
