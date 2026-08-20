/**
 * Architecture test: password hashing happens in exactly one file.
 *
 * Same shape as `azure-credential-chokepoint.test.ts`. `lib/secret-box.ts` is allowlisted too — it
 * calls `scryptSync` against a fixed, non-secret salt to derive a symmetric encryption key
 * deterministically, which is a different job from hardening a user's password against guessing
 * and is documented as such in that file. Nothing else should be reaching for any of these primitives at all.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALLOWED = new Set([
  join('lib', 'password.ts'),
  join('lib', 'secret-box.ts'),
]);

const SCANNED_DIRS = ['app', 'lib'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function findSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
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

const PASSWORD_PRIMITIVES = /\b(scrypt|scryptSync|bcrypt|argon2|pbkdf2|pbkdf2Sync)\b/;

describe('Password hashing has exactly one construction site', () => {
  it('found the source files at all (guards against this suite silently testing nothing)', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
    expect(sourceFiles.some(f => f.rel === join('lib', 'password.ts'))).toBe(true);
  });

  it('no file outside lib/password.ts or lib/secret-box.ts touches a password/KDF primitive', () => {
    const offenders = sourceFiles
      .filter(f => !ALLOWED.has(f.rel) && PASSWORD_PRIMITIVES.test(f.source))
      .map(f => f.rel.split(sep).join('/'));

    expect(offenders, [
      'These files reference a password-hashing primitive directly. Password hashing belongs',
      'only in lib/password.ts (hashPassword/verifyPassword) — a second implementation is a second',
      'place to get the cost parameters or salt handling wrong.',
    ].join(' ')).toEqual([]);
  });

  it('lib/password.ts really does use scrypt, so the ban above is not vacuous', () => {
    const source = sourceFiles.find(f => f.rel === join('lib', 'password.ts'))!.source;
    expect(source).toMatch(/\bscrypt\b/);
    expect(source).toMatch(/\bscryptSync\b/);
  });

  it('lib/secret-box.ts really does use scryptSync too, so its allowlisting is not vacuous', () => {
    const source = sourceFiles.find(f => f.rel === join('lib', 'secret-box.ts'))!.source;
    expect(source).toMatch(/\bscryptSync\b/);
  });
});
