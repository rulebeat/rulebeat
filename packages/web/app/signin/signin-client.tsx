'use client';

import { useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signInWithMicrosoft, signInWithPassword } from '@/lib/actions';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input, Label } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';

/** `?error=` values Auth.js redirects with — read from source, not observed, since there is no
 * live tenant here to trigger them against. Anything else falls back to a generic message. */
const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: 'That Microsoft account can\'t sign in here. It may not be in the right tenant, or an admin hasn\'t added it yet. Ask an admin to add you.',
  Configuration: 'Sign-in is not configured correctly. Contact your RuleBeat admin.',
  CredentialsSignin: 'Incorrect email or password.',
};

export function SignInClient({
  ssoConfigured, showLocalForm,
}: {
  ssoConfigured: boolean;
  showLocalForm: boolean;
}) {
  const searchParams = useSearchParams();
  const oauthError = searchParams.get('error');
  const passwordChanged = searchParams.get('passwordChanged') === '1';
  // The button appears as soon as something is configured, whether or not it has been proven by a
  // real sign-in yet. A misconfigured tenant, client id or secret surfaces as `?error=` on this
  // same page once someone tries it, so there is nothing extra a "verified" gate would catch.
  const showMicrosoft = ssoConfigured;
  const [formError, formAction, pending] = useActionState(signInWithPassword, null);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
      <div className="w-full max-w-sm px-6">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/brand/lockup.png" alt="RuleBeat" className="mb-5 h-10 w-auto shrink-0 dark:hidden" />
          <img src="/brand/lockup-dark.png" alt="RuleBeat" className="mb-5 hidden h-10 w-auto shrink-0 dark:block" />
          <h1 className="mt-1.5 text-sm font-normal text-ink-2">Sign in to RuleBeat</h1>
        </div>

        <div className="space-y-4 bg-surface p-6">
          {oauthError && (
            <Callout tone="error">
              {ERROR_MESSAGES[oauthError] ?? 'Sign-in failed. Try again.'}
            </Callout>
          )}

          {!oauthError && passwordChanged && (
            <Callout tone="success">
              Your password was changed. Sign in with your new password.
            </Callout>
          )}

          {showMicrosoft && (
            <form action={signInWithMicrosoft}>
              <Button type="submit" className="w-full" size="lg">
                <MicrosoftIcon />
                Sign in with Microsoft
              </Button>
            </form>
          )}

          {showMicrosoft && showLocalForm && (
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="label-grid">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}

          {showLocalForm && (
            <form action={formAction} className="space-y-3">
              {formError && <Callout tone="error">{formError}</Callout>}
              <div className="space-y-1.5">
                <Label htmlFor="signin-email">Email</Label>
                <Input
                  id="signin-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="username"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signin-password">Password</Label>
                <Input
                  id="signin-password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </div>
              <Button type="submit" variant={showMicrosoft ? 'outline' : 'default'} size={showMicrosoft ? 'default' : 'lg'} className="w-full" disabled={pending}>
                {pending && <Loader2 className="size-3.5 animate-spin" />}
                Sign in{showMicrosoft ? ' with a local account' : ''}
              </Button>
            </form>
          )}

          {!showMicrosoft && !showLocalForm && (
            <Callout tone="error">
              No sign-in method is available. Contact whoever administers this RuleBeat install.
            </Callout>
          )}

          <p className="text-center text-xs leading-relaxed text-ink-muted">
            Everything stays in your own deployment.
            <br />Nothing is synced to a service RuleBeat operates.
          </p>
        </div>
      </div>
    </div>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" fill="none">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
