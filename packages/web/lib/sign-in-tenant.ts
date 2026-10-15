import { getArmTenantId } from '@/lib/arm';
import { resolveSignInConfig } from '@/lib/sign-in-config';

/**
 * Whether people sign in through the same tenant the Azure connection reads. Only then does the object id RuleBeat
 * holds for someone who signed in with Entra name the same account in Azure, so "Use their sign-in account" is
 * offered. No sign-in configuration, or no Azure connection, is no.
 */
export async function signInTenantIsAzureTenant(): Promise<boolean> {
  try {
    const [signIn, azureTenantId] = await Promise.all([resolveSignInConfig(), getArmTenantId()]);
    return signIn !== null && signIn.tenantId.toLowerCase() === azureTenantId.toLowerCase();
  } catch {
    return false;
  }
}
