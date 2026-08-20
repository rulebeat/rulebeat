import { describe, expect, it } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import { hashPassword, hashPasswordSync, verifyDummyPassword, verifyPassword } from '@/lib/password';

describe('hashPassword / verifyPassword', () => {
  it('round-trips: a hash verifies against the password that produced it', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('hashes the same password differently on every call (random salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('the-real-password');
    expect(await verifyPassword('not-the-real-password', hash)).toBe(false);
  });

  it('rejects a tampered hash string without throwing', async () => {
    const hash = await hashPassword('some-password');
    const tampered = hash.slice(0, -4) + 'xxxx';
    await expect(verifyPassword('some-password', tampered)).resolves.toBe(false);
  });

  it('rejects a malformed stored value without throwing', async () => {
    for (const bad of ['', 'not-a-hash-at-all', 'scrypt$garbage', 'bcrypt$N=1,r=1,p=1$aa$bb']) {
      await expect(verifyPassword('anything', bad)).resolves.toBe(false);
    }
  });

  it('verifies a hash written under lower cost parameters than today\'s default', async () => {
    // Simulates an old hash from before N was raised: the encoded params (not a hardcoded
    // constant) must drive verification, or raising the cost factor later would lock every
    // existing local account out.
    const N = 16384, r = 8, p = 1;
    const salt = randomBytes(16);
    const derived = scryptSync('an-old-password', salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
    const oldStyleHash = `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${derived.toString('base64')}`;

    expect(await verifyPassword('an-old-password', oldStyleHash)).toBe(true);
    expect(await verifyPassword('wrong-password', oldStyleHash)).toBe(false);
  });

  it('sync and async hashing produce mutually verifiable results', async () => {
    const syncHash = hashPasswordSync('bootstrap-password');
    expect(await verifyPassword('bootstrap-password', syncHash)).toBe(true);

    const asyncHash = await hashPassword('bootstrap-password');
    expect(await verifyPassword('bootstrap-password', asyncHash)).toBe(true);
  });
});

describe('verifyDummyPassword', () => {
  it('never throws and always resolves (used to burn timing on an unknown account)', async () => {
    await expect(verifyDummyPassword('anything')).resolves.toBeUndefined();
  });
});
