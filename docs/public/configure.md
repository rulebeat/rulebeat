# Configuring RuleBeat

Every setting can be configured from the console after your first sign-in. Environment variables
exist for deployments that need to arrive already configured, such as an IaC template or a
Marketplace listing. Where both exist **the environment variable always wins**, and the equivalent
card in Settings shows as locked so nobody edits a value that has no effect. A completely empty
environment is a fully supported install.

Two variables are not part of a normal production install: `RULEBEAT_DEMO=1`
([`demo-mode.md`](demo-mode.md)) and `RULEBEAT_DISABLE_SCHEDULER=1`, which stops the in-process
scheduler polling. The only reason to set the latter is running more than one replica, which is not a
supported topology ([`install.md`](install.md#deployment-topology)).

## Sign-in

`AZURE_TENANT_ID` names the tenant RuleBeat scans, or set it from Settings → Azure connection.

`AUTH_SECRET` is the NextAuth session secret. Left unset, RuleBeat generates one on first boot at
`data/auth.key`, which is fine for the supported single-replica topology. Generate one with
`npx auth secret` or `openssl rand -base64 32`. `AUTH_SECRET_FILE` mounts it as a file and wins when
both are set; unlike the other `*_FILE` variables it is read once and cached, so replacing the file
needs a restart.

`AUTH_URL` is this deployment's public URL, used to build the Microsoft sign-in redirect. Left unset,
set it from Settings → Sign-in or let RuleBeat infer it from the incoming request, which works for a
typical single-tenant self-host. There is no `AUTH_TRUST_HOST` variable: RuleBeat always trusts the
forwarded host, which is safe specifically because the OAuth callback URL is pinned inside the Entra
app registration, so a forged Host header cannot redirect a real sign-in anywhere Entra was not told
to allow.

### Microsoft Entra ID sign-in (optional)

Setting `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET` and
`AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` together makes Microsoft sign-in work from first boot.
Configuring it from Settings → Sign-in instead also verifies the redirect URI actually works, which
setting the variables does not. `AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE` mounts the secret as a file and
is read fresh on every sign-in, so replacing it takes effect immediately.

This can be the same app registration that connects Azure or a separate one. Either way it needs the
redirect URI `<your AUTH_URL>/api/auth/callback/microsoft-entra-id` under Entra ID → App
registrations → Authentication, and no Azure API permissions. Entra accepts that URI only over HTTPS
or on `http://localhost` and refuses an IP address, so an `AUTH_URL` of `http://127.0.0.1:3000` can
never be registered. Locally, use `http://localhost:3000` for both and reach RuleBeat at that same
address, because Entra rejects the sign-in unless the two match exactly.

### Local sign-in and the first admin

A local sign-in policy of `always`, `break-glass` or `disabled` controls whether the local password
form stays visible once Microsoft sign-in works. It is guarded so it can never be restricted while
zero admins hold a local password. If Microsoft sign-in breaks while local sign-in is `disabled`,
`RULEBEAT_FORCE_LOCAL_SIGNIN=true` is the escape hatch, and it requires access to the host so it
cannot be triggered from inside the app.

Signing into the tenant proves who someone is, not that they should have access, so a Microsoft
account with no matching RuleBeat user is refused. `RULEBEAT_INITIAL_ADMIN` names the work email that
becomes an admin the moment they sign in, and doubles as the recovery path if every admin is removed.
Add everyone else from Settings → Users, by email, ahead of their first sign-in.
`RULEBEAT_INITIAL_PASSWORD` sets the seeded local account's password instead of a random one, and
still forces a change on first sign-in.

## Exposing it beyond localhost

The published Compose file binds RuleBeat to `127.0.0.1:3000`, not `0.0.0.0:3000`. RuleBeat holds a
live Azure read credential and does its own authentication, but has no TLS of its own, so an
unencrypted port open to the network is the wrong default.

To reach it from elsewhere, put a reverse proxy in front that terminates TLS (nginx, Caddy, Traefik,
or your cloud's load balancer), point it at `127.0.0.1:3000` without widening the Docker port
binding, set `AUTH_URL` to the proxy's public HTTPS URL, and register the redirect URI under that
same URL if Microsoft sign-in is configured. The same shape works inside Azure with managed pieces: a
VNet-injected container group with no public IP, its data volume on a disk rather than a file share
([`install.md`](install.md#deployment-topology)), and TLS terminated on an Application Gateway v2
probing `/api/health`.

With no reverse proxy at all, on a trusted internal network, you can widen the `ports:` entry to
`"3000:3000"`, but that is an explicit choice rather than the shipped default.

## Azure scanning credential

RuleBeat only ever needs the **Reader** role and never creates a service principal or assigns itself
one ([`permissions.md`](permissions.md)). Five ways to supply an identity, ranked best first.
Environment always wins over Settings → Azure connection.

1. **Managed identity** (best). On Azure, enable a managed identity, grant it Reader, and set nothing
   beyond `AZURE_TENANT_ID`. No secret exists to leak, rotate or expire.
2. **Workload identity federation** (keyless, works off-Azure). `AZURE_CLIENT_ID` and
   `AZURE_FEDERATED_TOKEN_FILE`, federated to an Entra app registration. Microsoft's current
   recommendation for workloads outside Azure.
3. **Certificate.** `AZURE_CLIENT_ID` and `AZURE_CLIENT_CERTIFICATE_PATH`, plus
   `AZURE_CLIENT_CERTIFICATE_PASSWORD` if the file is protected.
4. **Client secret, mounted as a file.** `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET_FILE`, the
   convention Docker secrets, Kubernetes secrets and the Key Vault CSI driver mount into. A secret in
   an environment variable is visible in `docker inspect`, inherited by every child process, and can
   turn up in crash dumps; a mounted file avoids that and rotates without a restart.
5. **Client secret, plain variable** (last resort). `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`. On
   App Service the value can be a Key Vault reference, which resolves before RuleBeat sees it.

Or leave all five unset and enter a client ID and secret in Settings → Azure connection. For local
development `az login` is picked up automatically. Granting the same identity the optional
`Application.Read.All` Graph permission enables Directory rules.

## Encryption key for stored secrets

`RULEBEAT_ENCRYPTION_KEY` encrypts every secret entered through the console with AES-256-GCM before
it is written. Left unset, RuleBeat generates one on first boot at `data/encryption.key` beside the
database, which is fine for a normal self-host but means a copy of the data volume carries the key
alongside the ciphertext it opens. Set the variable from a store outside the volume if you need a
backup to be safe on its own, and back it up either way, since losing it means re-entering every
stored secret. Findings, rules and history are never encrypted.
`RULEBEAT_ENCRYPTION_KEY_FILE` mounts it as a file, wins when both are set, and like `AUTH_SECRET_FILE`
is cached after the first read, so rotating it needs a restart.

## Rotating secrets

`AZURE_CLIENT_SECRET_FILE` and `AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE` are resolved fresh on every use,
so replacing their contents affects the next scan or sign-in with no restart. `AUTH_SECRET_FILE` and
`RULEBEAT_ENCRYPTION_KEY_FILE` are cached and need a restart. Rotating `AUTH_SECRET` invalidates every
live session, which is expected.

Rotating `RULEBEAT_ENCRYPTION_KEY` takes a sequence, because every secret stored through the console
becomes unreadable the moment the key changes. Confirm local sign-in is reachable first: a stored SSO
client secret is among those made unreadable, so if local sign-in is `disabled` at that moment every
admin is locked out at once with no way back short of `RULEBEAT_FORCE_LOCAL_SIGNIN` on the host. Then
change the key, restart, and re-save each stored credential. None are silently lost; they need
entering again once they read back as unreadable.

## Database backend

`RULEBEAT_DATABASE_URL` switches storage from the built-in SQLite file to a PostgreSQL database.
Leave it unset (the default) and everything lives in one SQLite file in the data volume, the right
choice for a typical single-host install. Set a `postgres://` connection string and RuleBeat
creates its schema and seed data there on first boot instead; the database only has to exist and
be reachable. This is the one setting with no console equivalent, because the app has to know
where its database is before it can read any settings.

`RULEBEAT_DATABASE_URL_FILE` mounts the connection string as a file, the same `*_FILE` convention
as the secrets above, since the string carries the database password. It is read once at startup,
so replacing the file needs a restart.

Switching backends is a fresh install: nothing is migrated between SQLite and Postgres in either
direction. The supported topology stays one replica either way, and a stateless no-volume
deployment needs `AUTH_SECRET` and `RULEBEAT_ENCRYPTION_KEY` set alongside the URL. See
[`install.md`](install.md#deployment-topology).

## Scan history retention

`SCAN_HISTORY_LIMIT` caps how many runs are kept per category in Run History, defaulting to 90, with
older runs pruned as new ones complete. The findings lifecycle is unaffected: first-seen, last-seen
and fixed state live in their own table, so pruning run records never changes the posture number or a
finding's age.
