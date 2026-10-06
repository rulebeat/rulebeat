// Password strength policy for local accounts — spec 020.

export const MIN_PASSWORD_LENGTH = 15;

/**
 * Sign-in-input bound only, not a policy on what a password can be *set* to. The hashing
 * algorithm's cost is independent of input length, so an attacker submitting a multi-megabyte
 * "password" at sign-in would make every gated verification (the real one and the dummy one) hash
 * that much extra data for free. Checked once, at the top of `authorizeLocalAccount`, before any
 * lookup or hashing.
 */
export const MAX_SIGNIN_PASSWORD_LENGTH = 1024;

// Full strings, not fragments meant to be "padded" — every entry here is already 15+ characters,
// so it actually proves the minimum length rather than depending on a caller adding padding that
// might not happen. Comparison is case-insensitive (both sides lowercased before comparing).
const BLOCKED_PASSWORDS = [
  'password12345678',
  'qwertyuiopasdfgh',
  'letmein123456789',
  'iloveyou12345678',
  '123456789012345',
  'administrator123',
  'changeme12345678',
  'welcome123456789',
  'trustno1trustno1',
  'passwordpassword',
];

export function validatePasswordStrength(password: string): { ok: true } | { ok: false; error: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (BLOCKED_PASSWORDS.includes(password.toLowerCase())) {
    return { ok: false, error: 'That password is too common. Choose another.' };
  }
  return { ok: true };
}
