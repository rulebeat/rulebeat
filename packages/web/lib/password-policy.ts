// Password strength policy for local accounts — spec 020.

export const MIN_PASSWORD_LENGTH = 15;

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
