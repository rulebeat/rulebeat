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

## Environment variable reference

Every variable RuleBeat reads, in one table. The column that matters for an install is
**Required when**: for a Docker install with its data volume, the answer is never. The sections
after the table explain each variable in full. Options 1 to 5 under Azure scanning are the ranked
credential choices described in [Azure scanning credential](#azure-scanning-credential).

| Variable | Required when | What it does | Value |
|---|---|---|---|
| **Database** | | | |
| `RULEBEAT_DATABASE_URL` | Postgres mode | Stores everything in the PostgreSQL database named here instead of the built-in SQLite file. The one setting with no console equivalent. | `postgres://user:password@host:5432/rulebeat`, plus `?sslmode=require` when the server enforces TLS. [Details](#database-backend) |
| `RULEBEAT_DATABASE_URL_FILE` | Never | The same connection string read from a mounted file, keeping the password out of the environment. | A file path |
| **Session and encryption** | | | |
| `AUTH_SECRET` | No volume (Container Apps, App Service, Container Instances) | Signs the session cookie. Generated into `data/auth.key` when unset, which a volume-less container loses on every restart, signing everyone out. | Any 32 or more random characters. [Making a random value](#making-a-random-value) |
| `AUTH_SECRET_FILE` | Never | The same value from a mounted file. Wins over `AUTH_SECRET`. | A file path |
| `RULEBEAT_ENCRYPTION_KEY` | No volume | Encrypts every credential entered through the console. Generated into `data/encryption.key` when unset; lose it and every stored credential becomes unreadable. | Any 32 or more random characters. [Details](#encryption-key-for-stored-secrets) |
| `RULEBEAT_ENCRYPTION_KEY_FILE` | Never | The same value from a mounted file. Wins over `RULEBEAT_ENCRYPTION_KEY`. | A file path |
| **First admin** | | | |
| `RULEBEAT_INITIAL_PASSWORD` | No volume | Password for the seeded local admin, `admin@rulebeat.local`, instead of a generated one written to `data/initial-password.txt`. Changed on first sign-in either way. | At least 15 characters |
| `RULEBEAT_INITIAL_ADMIN` | Never | Work email that becomes an admin on first Microsoft sign-in, and the recovery path if every admin is removed. | An email address. [Details](#local-sign-in-and-the-first-admin) |
| `RULEBEAT_FORCE_LOCAL_SIGNIN` | Never | Brings the local password form back when Microsoft sign-in breaks under a local sign-in policy of `disabled`. | `true` |
| **Public URL** | | | |
| `AUTH_URL` | Microsoft sign-in behind a proxy or on a platform hostname | The address people reach RuleBeat at, used to build the Microsoft sign-in redirect. Can be set from Settings → Sign-in instead. | `https://rulebeat.example.com`. [Details](#sign-in) |
| **Azure scanning** (pick one option, or connect from Settings → Azure connection) | | | |
| `AZURE_TENANT_ID` | Option 1, and any pre-configured deploy | The tenant to scan. With a managed identity it is the only variable to set. | A tenant id (GUID). [Details](#azure-scanning-credential) |
| `AZURE_CLIENT_ID` | Options 2 to 5 | The app registration RuleBeat scans as. | A client id (GUID) |
| `AZURE_FEDERATED_TOKEN_FILE` | Option 2 | Token file for workload identity federation. | A file path |
| `AZURE_CLIENT_CERTIFICATE_PATH` | Option 3 | Certificate for the app registration. | A file path |
| `AZURE_CLIENT_CERTIFICATE_PASSWORD` | Option 3, protected certificate | Password for that certificate. | The password |
| `AZURE_CLIENT_SECRET_FILE` | Option 4 | Client secret read from a mounted file, re-read on every use. | A file path |
| `AZURE_CLIENT_SECRET` | Option 5, last resort | Client secret in plain text. | The secret value |
| **Microsoft sign-in** (all three together, or configure from Settings → Sign-in) | | | |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Pre-configured deploy | Client id of the sign-in app registration. | A client id (GUID). [Details](#microsoft-entra-id-sign-in-optional) |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Pre-configured deploy | Its client secret. | The secret value |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE` | Never | The same secret from a mounted file. Wins over the plain variable. | A file path |
| `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` | Pre-configured deploy | The tenant people sign in from. | A tenant id (GUID) |
| **Behaviour** | | | |
| `SCAN_HISTORY_LIMIT` | Never, default 90 | How many runs per category Run History keeps. | A whole number. [Details](#scan-history-retention) |
| `RULEBEAT_DISABLE_SCHEDULER` | Multi-replica only | Stops the in-process scheduler on this replica. | `1` |
| `RULEBEAT_DEMO` | Never | Demo mode: anonymous, read-only, synthetic data. | `1`. [Details](demo-mode.md) |

### Running with no persistent volume

On Azure Container Apps, App Service and Container Instances there is no data volume, so the
files RuleBeat would otherwise generate on first boot do not survive a restart. Four variables
replace them:

- `RULEBEAT_DATABASE_URL`, because SQLite needs a local disk and a file share is not one.
- `AUTH_SECRET`, or every restart signs everyone out.
- `RULEBEAT_ENCRYPTION_KEY`, or every restart makes every credential stored through the console
  unreadable.
- `RULEBEAT_INITIAL_PASSWORD`, or the generated first password is written to a file inside a
  container you may never get a shell on.

With those four set the container is stateless and can restart, move hosts or redeploy freely.
The portal walkthrough is [Azure Container Apps](install.md#azure-container-apps).

### Making a random value

`AUTH_SECRET` and `RULEBEAT_ENCRYPTION_KEY` accept any string. The working key is derived from
whatever you supply, so length is what matters, not format: use 32 or more random characters. Any
of these produce one:

```
openssl rand -base64 32
```

in bash, zsh, or the Azure Cloud Shell opened from the portal's top bar, so no local terminal is
needed. `npx auth secret` works where Node is installed, and a password manager's generator set to
40 characters is just as good. Store both values somewhere durable, such as a Key Vault secret or
the password manager itself. Losing the auth secret only signs everyone out; losing the encryption
key is covered under [Rotating secrets](#rotating-secrets).

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

Any string is a valid key. RuleBeat derives the working 32-byte key from the value you supply, so
there is no required format or encoding; pick 32 or more random characters
([Making a random value](#making-a-random-value)). On a platform with no data volume the
variable is required rather than optional, because the generated file is lost on the first
restart ([Running with no persistent volume](#running-with-no-persistent-volume)).

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
deployment needs `AUTH_SECRET`, `RULEBEAT_ENCRYPTION_KEY` and `RULEBEAT_INITIAL_PASSWORD` set
alongside the URL ([Running with no persistent volume](#running-with-no-persistent-volume)). See
[`install.md`](install.md#deployment-topology).

## Scan history retention

`SCAN_HISTORY_LIMIT` caps how many runs are kept per category in Run History, defaulting to 90, with
older runs pruned as new ones complete. The findings lifecycle is unaffected: first-seen, last-seen
and fixed state live in their own table, so pruning run records never changes the posture number or a
finding's age.
