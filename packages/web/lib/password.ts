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

/**
 * In-process concurrency gate for scrypt. A single scrypt call costs ~64MB and tens of ms of
 * threadpool CPU; with no limit, a burst of unauthenticated sign-in requests (real users or
 * unknown emails, both run one verification each) can exhaust the process. "In-process" rather
 * than a shared/external limiter is correct here because a single replica is a documented
 * deployment decision (see CLAUDE.md), so there is no second process to coordinate with.
 *
 * Two call shapes share the same two concurrent slots and one bounded (20-deep) wait queue:
 *  - "wait in line" (`failFast: false`, the default): used by `hashPassword`, for an already-
 *    authenticated caller (password change, user create, admin reset). These must never be
 *    rejected — the request is already trusted, so the only question is how long it waits.
 *  - "fail fast" (`failFast: true`): used by the unauthenticated sign-in path (`verifyPassword`/
 *    `verifyDummyPassword` as called from `authorizeLocalAccount`). If the queue is already at
 *    its cap, the call throws `PasswordGateBusyError` immediately, before touching scrypt at all.
 *
 * The limits are `let`, not `const`, so tests can shrink them (`setPasswordGateLimitsForTests`)
 * to exercise the gate's full-queue behaviour without spinning up 20+ real scrypt calls.
 */
export const PASSWORD_GATE_MAX_CONCURRENT = 2;
export const PASSWORD_GATE_MAX_QUEUE = 20;

let gateMaxConcurrent = PASSWORD_GATE_MAX_CONCURRENT;
let gateMaxQueue = PASSWORD_GATE_MAX_QUEUE;
let gateRunning = 0;
const gateQueue: Array<() => void> = [];

/** Thrown by a fail-fast gated call when the wait queue is already at capacity. */
export class PasswordGateBusyError extends Error {
  constructor() {
    super('Too many password verifications are already in flight.');
    this.name = 'PasswordGateBusyError';
  }
}

function acquireGateSlot(): Promise<void> {
  if (gateRunning < gateMaxConcurrent) {
    gateRunning++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    gateQueue.push(() => { gateRunning++; resolve(); });
  });
}

function releaseGateSlot(): void {
  gateRunning--;
  const next = gateQueue.shift();
  if (next) next();
}

/**
 * True while the gate has no room left to accept another fail-fast caller (every slot running
 * and the wait queue already full). A cheap, side-effect-free peek — checked before any DB lookup
 * in `authorizeLocalAccount` so a saturated gate costs neither a password claim nor a dummy hash.
 */
export function isPasswordGateSaturated(): boolean {
  return gateRunning >= gateMaxConcurrent && gateQueue.length >= gateMaxQueue;
}

/**
 * Runs `fn` behind the gate. `failFast: true` throws `PasswordGateBusyError` synchronously-ish
 * (no scrypt, no queueing) when every slot is running and the queue is already at its cap;
 * `failFast: false` (default) always waits for a slot, however long that takes.
 *
 * Exported so tests can exercise the gate's concurrency/queueing behaviour with injected fake
 * work instead of real scrypt (slow, and not what's actually under test).
 */
export async function withPasswordGate<T>(fn: () => Promise<T>, opts: { failFast?: boolean } = {}): Promise<T> {
  if (opts.failFast && isPasswordGateSaturated()) throw new PasswordGateBusyError();
  await acquireGateSlot();
  try {
    return await fn();
  } finally {
    releaseGateSlot();
  }
}

/** Test-only seam — shrink the gate so full-queue behaviour doesn't need 20+ real callers. */
export function setPasswordGateLimitsForTests(maxConcurrent: number, maxQueue: number): void {
  gateMaxConcurrent = maxConcurrent;
  gateMaxQueue = maxQueue;
}

/** Test-only seam — restores the real limits and clears any state a test left behind. */
export function resetPasswordGateForTests(): void {
  gateMaxConcurrent = PASSWORD_GATE_MAX_CONCURRENT;
  gateMaxQueue = PASSWORD_GATE_MAX_QUEUE;
  gateRunning = 0;
  gateQueue.length = 0;
}

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

/** Always waits for a gate slot rather than rejecting — every caller is already authenticated. */
export async function hashPassword(password: string): Promise<string> {
  return withPasswordGate(async () => {
    const salt = randomBytes(SALT_LEN);
    const hash = await scryptAsync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
    return encode(paramsFor(N, r, p), salt, hash);
  });
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
 *
 * `opts.failFast` is for the unauthenticated sign-in path only (see `withPasswordGate`): pass it
 * when calling from `authorizeLocalAccount`, leave it unset everywhere else (e.g. the
 * authenticated "confirm current password" check in the account password-change route).
 */
export async function verifyPassword(
  password: string, stored: string, opts: { failFast?: boolean } = {},
): Promise<boolean> {
  realVerificationCallCount++;
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

  const actual = await withPasswordGate(() => scryptAsync(password, salt, expected.length, {
    N: params.N, r: params.r, p: params.p,
    maxmem: Math.max(MAXMEM, 128 * params.N * params.r * 2),
  }), opts);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

let realVerificationCallCount = 0;

/** Test-only seam — proves `verifyPassword` itself was never reached, not by timing. */
export function getRealVerificationCallCountForTests(): number {
  return realVerificationCallCount;
}

export function resetRealVerificationCallCountForTests(): void {
  realVerificationCallCount = 0;
}

let dummyVerificationCallCount = 0;

/** Test-only seam — proves a code path really did run the dummy verification, not by timing. */
export function getDummyVerificationCallCountForTests(): number {
  return dummyVerificationCallCount;
}

export function resetDummyVerificationCallCountForTests(): void {
  dummyVerificationCallCount = 0;
}

/**
 * A verification against no real account — burns the same async scrypt cost as a genuine failed
 * login, so "no such account" and "wrong password" take the same time and an attacker can't use
 * response timing to enumerate which emails exist. Also used on the *locked-account* branch for
 * the same reason: returning early there is its own timing oracle confirming the email exists.
 */
export async function verifyDummyPassword(password: string, opts: { failFast?: boolean } = {}): Promise<void> {
  dummyVerificationCallCount++;
  await verifyPassword(password, encode(paramsFor(N, r, p), randomBytes(SALT_LEN), randomBytes(KEYLEN)), opts);
}
