import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialsSignin } from 'next-auth';
import { SignInBusyError } from '@/lib/sign-in-config';

const mockSignIn = vi.fn();

vi.mock('@/auth', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
  signOut: vi.fn(),
}));

const mockHeaders = new Headers({ host: 'rulebeat.example.com', 'x-forwarded-proto': 'https' });
vi.mock('next/headers', () => ({
  headers: async () => mockHeaders,
}));

const { signInWithMicrosoft, signInWithPassword } = await import('@/lib/actions');

function formData(email: string, password: string, callbackUrl?: string): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  if (callbackUrl !== undefined) data.set('callbackUrl', callbackUrl);
  return data;
}

function callbackForm(callbackUrl?: string): FormData {
  const data = new FormData();
  if (callbackUrl !== undefined) data.set('callbackUrl', callbackUrl);
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

describe('signInWithPassword callbackUrl', () => {
  it('redirects to a relative callbackUrl, keeping search and hash', async () => {
    mockSignIn.mockResolvedValue(undefined);
    await signInWithPassword(null, formData('a@example.com', 'x', '/scans?tab=history#r1'));
    expect(mockSignIn).toHaveBeenCalledWith('credentials', expect.objectContaining({ redirectTo: '/scans?tab=history#r1' }));
  });

  it('redirects to the same-origin absolute form the proxy writes, as path, search and hash', async () => {
    mockSignIn.mockResolvedValue(undefined);
    await signInWithPassword(null, formData('a@example.com', 'x', 'https://rulebeat.example.com/scans?tab=history#r1'));
    expect(mockSignIn).toHaveBeenCalledWith('credentials', expect.objectContaining({ redirectTo: '/scans?tab=history#r1' }));
  });

  it.each([
    ['foreign absolute', 'https://evil.example.net/x'],
    ['protocol-relative', '//evil.example.net/x'],
    ['backslash', '/\\evil.example.net/x'],
  ])('falls back to /dashboard for a %s callbackUrl', async (_label, raw) => {
    mockSignIn.mockResolvedValue(undefined);
    await signInWithPassword(null, formData('a@example.com', 'x', raw));
    expect(mockSignIn).toHaveBeenCalledWith('credentials', expect.objectContaining({ redirectTo: '/dashboard' }));
  });

  it('falls back to /dashboard with no callbackUrl', async () => {
    mockSignIn.mockResolvedValue(undefined);
    await signInWithPassword(null, formData('a@example.com', 'x'));
    expect(mockSignIn).toHaveBeenCalledWith('credentials', expect.objectContaining({ redirectTo: '/dashboard' }));
  });
});

describe('signInWithMicrosoft callbackUrl', () => {
  it('redirects to a relative callbackUrl', async () => {
    mockSignIn.mockResolvedValue(undefined);
    await signInWithMicrosoft(callbackForm('/scans?tab=history#r1'));
    expect(mockSignIn).toHaveBeenCalledWith('microsoft-entra-id', { redirectTo: '/scans?tab=history#r1' });
  });

  it('redirects to the same-origin absolute form as path, search and hash', async () => {
    mockSignIn.mockResolvedValue(undefined);
    await signInWithMicrosoft(callbackForm('https://rulebeat.example.com/scans?tab=history#r1'));
    expect(mockSignIn).toHaveBeenCalledWith('microsoft-entra-id', { redirectTo: '/scans?tab=history#r1' });
  });

  it.each([
    ['foreign absolute', 'https://evil.example.net/x'],
    ['protocol-relative', '//evil.example.net/x'],
    ['backslash', '/\\evil.example.net/x'],
  ])('falls back to /dashboard for a %s callbackUrl', async (_label, raw) => {
    mockSignIn.mockResolvedValue(undefined);
    await signInWithMicrosoft(callbackForm(raw));
    expect(mockSignIn).toHaveBeenCalledWith('microsoft-entra-id', { redirectTo: '/dashboard' });
  });

  it('falls back to /dashboard with no callbackUrl', async () => {
    mockSignIn.mockResolvedValue(undefined);
    await signInWithMicrosoft(callbackForm());
    expect(mockSignIn).toHaveBeenCalledWith('microsoft-entra-id', { redirectTo: '/dashboard' });
  });
});
