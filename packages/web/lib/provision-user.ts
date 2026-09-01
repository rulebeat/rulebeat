import {
  getUser, getUserByOid, getUserByEmail, linkOid, touchLastSeen, type AppUser,
} from './db/users';
import { writeAudit, logAuthEvent } from './db/audit';

export interface SignInIdentity {
  /** Entra object id — stable for this person within the tenant. */
  oid: string;
  email: string;
  name?: string | null;
}

/**
 * Resolves the local `users` row for someone who has just authenticated, binding it as needed,
 * and records the sign-in. Called from the `signIn` callback, so it runs exactly once per
 * sign-in rather than on every token refresh.
 *
 * Two paths:
 *  1. Known oid — normal returning user.
 *  2. Unknown oid but a row exists for their email — an admin assigned them a role before they
 *     ever signed in (via the invite flow, or `RULEBEAT_INITIAL_ADMIN` at restart); bind the oid
 *     to that row so the waiting role applies.
 *
 * Tenant membership alone is never enough — an oid RuleBeat has never seen, with no row waiting
 * for its email, is denied. There is deliberately no "nobody knows them, create an account"
 * fallback: a fresh install already has the seeded local owner as admin, and recovering from
 * every admin being removed is `RULEBEAT_INITIAL_ADMIN` + restart, which pre-creates the row so
 * that person's sign-in lands in path 2 above, not here.
 */
export async function provisionUser(identity: SignInIdentity): Promise<AppUser | null> {
  const email = identity.email.trim().toLowerCase();

  let user = await getUserByOid(identity.oid);

  if (user) {
    await touchLastSeen(user.id, identity.name);
  } else {
    const invited = email ? await getUserByEmail(email) : null;
    if (invited) {
      await linkOid(invited.id, identity.oid, identity.name);
      user = await getUser(invited.id);
      if (user) {
        // Distinguishable from the generic auth.sign_in line written below — a pre-created row's
        // first claim is exactly the moment P4-2's binding race can go wrong, so it gets its own
        // notable audit entry rather than blending into every other sign-in.
        await writeAudit({
          actor: user,
          action: 'user.invite_claimed',
          entityType: 'user',
          entityId: user.id,
          summary: `${user.email} claimed a pre-invited role via Entra sign-in`,
          details: { oid: identity.oid },
        });
      }
    } else {
      // Unbounded and reachable by anyone who can complete an Entra sign-in against the tenant,
      // provisioned or not — logged, not persisted, same reasoning as the local-sign-in flood
      // vectors (spec 022).
      logAuthEvent(`Denied Entra sign-in for ${email} — not provisioned`, {
        reason: 'not-provisioned', oid: identity.oid,
      });
      return null;
    }
  }

  if (!user) return null;

  await writeSignInAudit(user);
  return user;
}

/** Records a successful sign-in. Shared by the Entra path above and the local-account path. */
export async function writeSignInAudit(user: Pick<AppUser, 'id' | 'email'>): Promise<void> {
  await writeAudit({
    actor: user,
    action: 'auth.sign_in',
    entityType: 'auth',
    summary: `${user.email} signed in`,
  });
}
