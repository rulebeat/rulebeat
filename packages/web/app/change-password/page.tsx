import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/api-auth';
import { getLocalAccount } from '@/lib/db/local-accounts';
import { isDemoMode } from '@/lib/demo';
import { ChangePasswordClient } from './change-password-client';

// Deliberately outside the (app) route group: that layout would redirect back here for anyone
// with mustChangePassword set, which is exactly the loop this page exists to break out of.
export default async function ChangePasswordPage() {
  // The demo visitor has no local_accounts row, so `!account` below already redirects away — this
  // is the same explicit belt-and-suspenders as onboarding's guard, not load-bearing on its own.
  if (await isDemoMode()) notFound();

  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  const account = await getLocalAccount(user.id);
  if (!account) redirect('/dashboard'); // nothing to change — this user has no local password

  return <ChangePasswordClient email={user.email} mustChangePassword={account.mustChangePassword} />;
}
