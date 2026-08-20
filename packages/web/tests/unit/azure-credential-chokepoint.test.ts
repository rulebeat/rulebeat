/**
 * Architecture test: Azure credentials are constructed in exactly one file.
 *
 * Same shape as `route-guards.test.ts`, and for the same reason — this is a convention the type
 * system can't express, so without a test it holds only while whoever adds the next Azure call
 * remembers.
 *
 * It matters more than it looks. Before this rule existed, nine call sites each built their own
 * `DefaultAzureCredential`, which was harmless while there was only one way to authenticate. The
 * moment a credential could also come from the UI, every one of those sites became a place that
 * silently ignores it — producing the worst class of bug, where scans work and the schema cache is
 * mysteriously empty, or vice versa.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The one module allowed to construct a credential. Everything else asks it. */
const RESOLVER = join('lib', 'azure-credential.ts');

const SCANNED_DIRS = ['app', 'lib'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function findSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // `readdirSync` walks Next.js's literal `[id]` directories correctly; a PowerShell or glob-based
    // sweep would treat the brackets as a wildcard and skip every dynamic route.
    if (statSync(full).isDirectory()) found.push(...findSourceFiles(full));
    else if (SOURCE_EXTENSIONS.some(ext => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

const sourceFiles = SCANNED_DIRS
  .flatMap(d => findSourceFiles(join(WEB_ROOT, d)))
  .map(full => ({
    rel: relative(WEB_ROOT, full),
    source: readFileSync(full, 'utf8'),
  }));

const CREDENTIAL_CLASSES = [
  'DefaultAzureCredential',
  'ClientSecretCredential',
  'ClientCertificateCredential',
  'EnvironmentCredential',
  'WorkloadIdentityCredential',
  'ManagedIdentityCredential',
  'AzureCliCredential',
];

describe('Azure credentials have exactly one construction site', () => {
  it('found the source files at all (guards against this suite silently testing nothing)', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
    expect(sourceFiles.some(f => f.rel === RESOLVER)).toBe(true);
  });

  it('no file outside lib/azure-credential.ts constructs an Azure credential', () => {
    const pattern = new RegExp(`new\\s+(${CREDENTIAL_CLASSES.join('|')})\\s*\\(`);

    const offenders = sourceFiles
      .filter(f => f.rel !== RESOLVER && pattern.test(f.source))
      .map(f => f.rel.split(sep).join('/'));

    expect(offenders, [
      'These files build an Azure credential directly, which bypasses credential resolution —',
      'so a credential set in the environment or entered in Settings → Azure connection would be',
      'ignored here while working everywhere else. Use resolveAzureCredential(),',
      'getAzureCredential() or createTenantContext() from lib/azure-credential.ts instead.',
    ].join(' ')).toEqual([]);
  });

  it('the resolver really does construct the credentials, so the ban is not vacuous', () => {
    // Without this, deleting every `new ...Credential(` in the codebase would make the test above
    // pass while the product could no longer authenticate at all.
    const resolver = sourceFiles.find(f => f.rel === RESOLVER)!.source;
    expect(resolver).toMatch(/new\s+DefaultAzureCredential\s*\(/);
    expect(resolver).toMatch(/new\s+ClientSecretCredential\s*\(/);
    expect(resolver).toMatch(/new\s+WorkloadIdentityCredential\s*\(/);
  });

  it('nothing calls buildTenantContext() with no arguments', () => {
    // The subtler bypass: core's `buildTenantContext()` builds its *own* DefaultAzureCredential when
    // given none, so this compiles, runs, and quietly ignores both the environment and the stored
    // credential. `createTenantContext()` is the web app's entry point.
    const offenders = sourceFiles
      .filter(f => f.rel !== RESOLVER && /buildTenantContext\s*\(\s*\)/.test(f.source))
      .map(f => f.rel.split(sep).join('/'));

    expect(offenders, [
      'These files call buildTenantContext() with no credential, which makes core build its own',
      'and ignore RuleBeat’s configured one. Call createTenantContext() from',
      'lib/azure-credential.ts instead.',
    ].join(' ')).toEqual([]);
  });

  it('no file reads a credential secret from the environment outside the resolver', () => {
    // A second reader of the secret is a second place it can be logged or returned.
    //
    // Matches an actual `process.env` read, not the bare name: the settings card legitimately
    // *displays* "AZURE_CLIENT_SECRET" to tell an admin which line to edit, and a substring match
    // flagged that as a violation. A test that can't tell a read from a label trains you to add
    // allowlist entries, which is how this kind of rule quietly stops meaning anything.
    const readsSecret = /process\.env\s*[.[]\s*['"`]?AZURE_CLIENT_(SECRET|CERTIFICATE_PASSWORD)/;

    const offenders = sourceFiles
      .filter(f => f.rel !== RESOLVER && readsSecret.test(f.source))
      .map(f => f.rel.split(sep).join('/'));

    expect(offenders, 'These files read a credential secret directly. Only the resolver should.')
      .toEqual([]);
  });
});
