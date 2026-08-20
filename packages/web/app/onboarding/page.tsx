import { redirect, notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/api-auth';
import { getLocalAccount } from '@/lib/db/local-accounts';
import { can } from '@/lib/rbac';
import { getAzureConnectionStatus } from '@/lib/azure-credential';
import { listCategories } from '@/lib/db/categories';
import { listRuleSummaries } from '@/lib/rules';
import { getOnboardingState } from '@/lib/onboarding';
import { isDemoMode } from '@/lib/demo';
import { OnboardingClient } from './onboarding-client';

// Deliberately outside the (app) route group, same reasoning as /change-password: that layout's own
// onboarding redirect would loop back here, and /onboarding must stay directly addressable (a
// returning admin who skipped it can navigate straight back) even after the marker moves off 'pending'.
export default async function OnboardingPage() {
  // A demo visitor's viewer role already fails the can(azure:manage) check below and would land on
  // /dashboard, but this route wires a real Azure connect step to a credential that
  // resolveAzureCredential() throws on in demo mode — 404 outright rather than lean on a redirect
  // that exists for an unrelated reason to also cover this case.
  if (isDemoMode()) notFound();

  const user = await getCurrentUser();
  if (!user) redirect('/signin');
  if (getLocalAccount(user.id)?.mustChangePassword) redirect('/change-password');
  if (!can(user.role, 'azure:manage')) redirect('/dashboard');

  return (
    <OnboardingClient
      azureStatus={getAzureConnectionStatus()}
      categories={listCategories()}
      ruleSummaries={listRuleSummaries()}
      onboarding={getOnboardingState()}
    />
  );
}
