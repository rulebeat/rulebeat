import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialsSignin } from 'next-auth';
import { SignInBusyError } from '@/lib/sign-in-config';

const mockSignIn = vi.fn();

vi.mock('@/auth', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
  signOut: vi.fn(),
}));

const { signInWithPassword } = await import('@/lib/actions');

function formData(email: string, password: string): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  return data;
}

afterEach(() => {
  mockSignIn.mockReset();
});

describe('signInWithPassword', () => {
  it('maps the busy CredentialsSignin code to a distinct, non-generic message', async () => {
    mockSignIn.mockRejectedValue(new SignInBusyError());

    const result = await signInWithPassword(null, formData('someone@example.com', 'whatever'));
    expect(result).toBe('Too many sign-in attempts right now. Try again in a minute.');
  });

  it('maps every other CredentialsSignin code (wrong email/password) to the generic message', async () => {
    mockSignIn.mockRejectedValue(new CredentialsSignin());

    const result = await signInWithPassword(null, formData('someone@example.com', 'wrong'));
    expect(result).toBe('Incorrect email or password.');
  });

  it('rethrows anything that is not an AuthError (e.g. the NEXT_REDIRECT a success throws)', async () => {
    const redirectError = new Error('NEXT_REDIRECT');
    mockSignIn.mockRejectedValue(redirectError);

    await expect(
      signInWithPassword(null, formData('someone@example.com', 'whatever')),
    ).rejects.toBe(redirectError);
  });

  it('returns null on success', async () => {
    mockSignIn.mockResolvedValue(undefined);
    const result = await signInWithPassword(null, formData('someone@example.com', 'CorrectPassword1!'));
    expect(result).toBeNull();
  });
});
