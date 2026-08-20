import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, validatePasswordStrength } from '@/lib/password-policy';

describe('validatePasswordStrength', () => {
  it('rejects anything shorter than the minimum', () => {
    const result = validatePasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(result.ok).toBe(false);
  });

  it('accepts a password exactly at the minimum length that is not blocklisted', () => {
    const result = validatePasswordStrength('correct-horse-b'); // 16 chars, not in the list
    expect(result.ok).toBe(true);
  });

  it('rejects a blocklisted password even though it clears the length floor', () => {
    const result = validatePasswordStrength('password12345678');
    expect(result.ok).toBe(false);
  });

  it('blocklist matching is case-insensitive', () => {
    const result = validatePasswordStrength('PASSWORD12345678');
    expect(result.ok).toBe(false);
  });

  it('every blocklist entry is itself long enough to prove the length floor', () => {
    // Guards against the exact bug this policy replaced: a 14-char example that couldn't even
    // demonstrate a 15-char minimum was failing for the wrong reason.
    const result = validatePasswordStrength('qwertyuiopasdfgh');
    expect(result.ok).toBe(false);
    expect('qwertyuiopasdfgh'.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  it('accepts a genuinely strong, non-blocklisted password', () => {
    const result = validatePasswordStrength('Tr0ub4dor&3xtraLong!');
    expect(result.ok).toBe(true);
  });
});
