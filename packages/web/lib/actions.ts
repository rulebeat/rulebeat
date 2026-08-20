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
      return 'Incorrect email or password.';
    }
    throw err;
  }
}
