import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * The only file that hashes or verifies a password.
 *
 * scrypt via `node:crypto` rather than argon2/bcrypt: both would add a platform-specific native
 * dependency at exactly the moment B2 wants to *remove* one (`python3 make g++`) from the runner
 * image, and scrypt with a reasonable cost factor is an accepted choice (OWASP lists it alongside
 * argon2/bcrypt/PBKDF2).
 *
 * Two traps this file exists to avoid re-introducing at every call site:
 *  - `scryptSync` blocks the single JS thread for 100ms-1s per call — every real login must use
 *    the async `scrypt`. `hashPasswordSync` exists only for the startup seed, which runs before
 *    the server is accepting requests.
 *  - `N=2^16` throws unless `maxmem` is raised to match; the default 32MB budget is sized for
 *    `N=2^14`.
 *
 * The cost parameters are stored inside the hash string (`scrypt$N=65536,r=8,p=1$<salt>$<hash>`)
 * rather than assumed from a constant, so they can be raised later for new hashes without
 * invalidating passwords hashed under the old cost.
 */

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 65536; // 2^16
const r = 8;
const p = 1;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024; // comfortably above scrypt's own 128*N*r bytes for N=2^16, r=8
const SALT_LEN = 16;

function encode(params: string, salt: Buffer, hash: Buffer): string {
  return `scrypt$${params}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function paramsFor(N: number, r: number, p: number): string {
  return `N=${N},r=${r},p=${p}`;
}

function parseParams(params: string): { N: number; r: number; p: number } | null {
  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(params);
  if (!match) return null;
  return { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return encode(paramsFor(N, r, p), salt, hash);
}

/** Synchronous — for the startup seed only, which runs before the server accepts requests. */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return encode(paramsFor(N, r, p), salt, hash);
}

/**
 * Verifies a password against a stored hash. Returns `false` for any malformed hash rather than
 * throwing — a tampered or corrupted stored value should read as "wrong password", not crash the
 * request.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const params = parseParams(parts[1]!);
  if (!params) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2]!, 'base64');
    expected = Buffer.from(parts[3]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await scryptAsync(password, salt, expected.length, {
    N: params.N, r: params.r, p: params.p,
    maxmem: Math.max(MAXMEM, 128 * params.N * params.r * 2),
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * A verification against no real account — burns the same async scrypt cost as a genuine failed
 * login, so "no such account" and "wrong password" take the same time and an attacker can't use
 * response timing to enumerate which emails exist.
 */
export async function verifyDummyPassword(password: string): Promise<void> {
  await verifyPassword(password, encode(paramsFor(N, r, p), randomBytes(SALT_LEN), randomBytes(KEYLEN)));
}
