import { Suspense } from 'react';
import { getSignInStatus } from '@/lib/sign-in-config';
import { SignInClient } from './signin-client';

export default function SignInPage() {
  const status = getSignInStatus();
  // RULEBEAT_FORCE_LOCAL_SIGNIN is the host-level escape when SSO breaks under a `disabled`
  // policy — it has to make the form *visible* here, not just accepted by authorize(), or the
  // escape hatch is unreachable from the one page anyone locked out can actually get to.
  const forced = process.env.RULEBEAT_FORCE_LOCAL_SIGNIN === 'true';
  // 'break-glass' hides the local form once Microsoft sign-in is verified — it still works
  // (auth.ts's authorize() isn't gated on this), it just isn't the first thing offered.
  const showLocalForm = forced
    || status.localSignInPolicy === 'always'
    || (status.localSignInPolicy === 'break-glass' && !status.isActive);

  return (
    <Suspense>
      <SignInClient
        ssoConfigured={status.configured}
        ssoVerified={status.isActive}
        showLocalForm={showLocalForm}
      />
    </Suspense>
  );
}
