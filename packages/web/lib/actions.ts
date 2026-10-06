'use server';

import { AuthError } from 'next-auth';
import { signIn, signOut } from '@/auth';

export async function signInWithMicrosoft() {
  await signIn('microsoft-entra-id', { redirectTo: '/dashboard' });
}

export async function signOutUser() {
  await signOut({ redirectTo: '/signin' });
}

/**
 * `useActionState`-shaped so the sign-in form can show an inline error without a full page
 * navigation. A successful `signIn()` throws Next.js's internal `NEXT_REDIRECT` — that must
 * propagate, not be caught here, which is why only `AuthError` gets a friendly message and
 * everything else rethrows.
 */
export async function signInWithPassword(
  _prevState: string | null,
  formData: FormData,
): Promise<string | null> {
  try {
    await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      redirectTo: '/dashboard',
    });
    return null;
  } catch (err) {
    if (err instanceof AuthError) {
      // `SignInBusyError` (lib/sign-in-config.ts) is the only `code` authorizeLocalAccount sets
      // itself; everything else (including the default `'credentials'` code) stays generic so a
      // wrong email and a wrong password still read identically.
      if ('code' in err && err.code === 'busy') {
        return 'Too many sign-in attempts right now. Try again in a minute.';
      }
      return 'Incorrect email or password.';
    }
    throw err;
  }
}
