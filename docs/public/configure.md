# Configuring RuleBeat

Every setting in RuleBeat can be configured from the console after your first sign-in. Environment
variables exist for deployments that need to arrive already configured, with no setup screen at
all, such as an IaC template or a Marketplace listing. Where both exist, **the environment variable
always wins**, and the equivalent card in Settings shows as locked so nobody edits a value that has
no effect.

A genuinely empty environment is a fully supported install: start the container, read the
generated admin password from `data/initial-password.txt` inside the data volume (the startup
log points at the file; it never prints the password itself), sign in, and configure everything
else from Settings. Nothing in this page is required to reach that first screen.

Two variables that are not part of a normal production install are documented with the features
they belong to: `RULEBEAT_DEMO=1` (see [`demo-mode.md`](demo-mode.md)) and
`RULEBEAT_DISABLE_SCHEDULER=1`, which stops the in-process scheduler from polling at all. The
only reason to set the latter is running more than one replica, which is not a supported
topology; see [`install.md`](install.md#deployment-topology) and
[`troubleshooting.md`](troubleshooting.md).

## Azure tenant

`AZURE_TENANT_ID` names the tenant RuleBeat scans, once a scanning credential is configured (see
below). Leave it unset and set it from Settings → Azure connection instead.

## Sign-in

`AUTH_SECRET` is the NextAuth session secret. Leave it unset and RuleBeat generates one on first
boot, stored at `data/auth.key` beside the database. That's fine for the supported single-replica
topology (see [`install.md`](install.md#deployment-topology)); set it explicitly, the same value
everywhere, if you're experimenting with more than one instance sharing sessions. Generate one with
`npx auth secret` or `openssl rand -base64 32`. Or mount it as a file and point
`AUTH_SECRET_FILE` at the path; it wins over `AUTH_SECRET` when both are set, same `*_FILE`
convention as `AZURE_CLIENT_SECRET_FILE` below. Unlike that one, this is read once and cached for
the life of the process, so replacing the mounted file needs a restart to take effect.

`AUTH_URL` is this deployment's public URL, used to build the Microsoft sign-in redirect. Leave it
unset and either set it from Settings → Sign-in, or rely on RuleBeat inferring it from the
incoming request, which works for a typical single-tenant self-host. There is no
`AUTH_TRUST_HOST` variable: RuleBeat always trusts the forwarded host. That's safe specifically
because the OAuth callback URL is pinned inside the Entra app registration itself, so a forged
Host header can't redirect a real sign-in anywhere Entra wasn't told to allow.

### Microsoft Entra ID sign-in (optional)

Setting `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, and
`AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` together makes Microsoft sign-in work from first boot. Leave
them unset and configure Microsoft sign-in from Settings → Sign-in after your first local sign-in
instead; that path also verifies the redirect URI actually works, which setting these variables
does not.

This can be the same app registration used to connect Azure, or a separate one; either way it needs
the redirect URI `<your AUTH_URL>/api/auth/callback/microsoft-entra-id` added in Entra ID → App
registrations → Authentication, and no Azure API permissions. Entra ID accepts that URI only
over HTTPS or on `http://localhost`, and refuses an IP address, so an `AUTH_URL` of
`http://127.0.0.1:3000` can never be registered. Locally, use `http://localhost:3000` for both the
`AUTH_URL` and the registered redirect URI, and reach RuleBeat at that same address: the sign-in
request is built from `AUTH_URL` when it is set and from the incoming request otherwise, and Entra
rejects the sign-in unless the two match exactly. From the onboarding Connect Azure
step or Settings → Sign-in you can check "reuse this app registration for Microsoft sign-in" to
point sign-in at the same credential already used to connect Azure, without re-entering it; that
app registration then both signs users in and holds Azure Reader access. To keep the two
separate instead, register a new app and enter its tenant, client ID, and secret manually in either
of those two places.

`AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE` mounts the client secret as a file instead and wins over
`AUTH_MICROSOFT_ENTRA_ID_SECRET` when both are set. Unlike `AUTH_SECRET_FILE` above, this one is
read fresh on every sign-in, so replacing the mounted file's contents takes effect immediately,
with no restart needed.

### Local sign-in

A local sign-in policy of `always`, `break-glass`, or `disabled` controls whether the local
password form stays visible once Microsoft sign-in works, configured from Settings → Sign-in. It's
guarded so it can never be restricted while zero admins hold a local password. If Microsoft
sign-in ever breaks while local sign-in is set to `disabled`, `RULEBEAT_FORCE_LOCAL_SIGNIN=true` is
the host-level escape hatch: it requires access to the host to set, so it can't be triggered from
inside the app itself.

### First admin

Signing into the tenant Microsoft sign-in is configured for proves who someone is, not that they
should have access: a Microsoft account with no matching RuleBeat user is refused. `RULEBEAT_INITIAL_ADMIN`
names the work email that should become an admin: set it and restart, and that person becomes an
admin the moment they sign in. Add everyone after that from Settings → Users, by email, ahead of
their first sign-in. `RULEBEAT_INITIAL_ADMIN` also doubles as the lockout recovery path: if every
admin is ever removed, set this and restart.

`RULEBEAT_INITIAL_PASSWORD` sets the generated local owner account's password instead of a random
one. It still forces a password change on first sign-in, same as the generated password does.

## Exposing it beyond localhost

The published Docker Compose file binds RuleBeat to `127.0.0.1:3000` on the host, not
`0.0.0.0:3000`, so it is reachable from the machine running it, not from your network. That's deliberate:
RuleBeat holds a live Azure read credential and does its own authentication, but it has no TLS
story of its own, so an unencrypted port open to the network is the wrong default.

To reach it from elsewhere:

1. Put a reverse proxy in front that terminates TLS (nginx, Caddy, Traefik, or your cloud's load
   balancer all work) and point it at `127.0.0.1:3000` on the host. Do not widen the Docker port
   binding itself.
2. Set `AUTH_URL` to the proxy's public HTTPS URL, so the Microsoft sign-in redirect and cookie
   settings are correct.
3. If Microsoft sign-in is configured, make sure the redirect URI registered in Entra ID uses that
   same public URL (see [Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in-optional) above).

If you're running on a host with no reverse proxy at all and need direct network access anyway (a
trusted internal network, for example), you can widen the binding by changing
`docker-compose.yml`'s `ports:` entry to `"3000:3000"`, but that's an explicit choice to make, not
the shipped default.

### Example: Azure Container Instances behind Application Gateway

One concrete way to run this in Azure itself, if you'd rather the reverse proxy be a managed
Azure resource than a process on the same host as RuleBeat:

- **Two subnets in one VNet.** One delegated to `Microsoft.ContainerInstance/containerGroups` for
  RuleBeat's container group, one dedicated to Application Gateway. Azure requires both: a
  VNet-injected container group needs a subnet of its own, and Application Gateway needs a
  dedicated subnet too, they can't share.
- **RuleBeat's container group gets no public IP.** Deploying it into that subnet is what plays
  the role `127.0.0.1` plays above: the container is reachable only from inside the VNet, not the
  internet, the same "only the proxy can reach it directly" posture as the local case, achieved
  with network isolation instead of a loopback bind. An NSG on that subnet that only allows inbound
  TCP 3000 from Application Gateway's subnet locks it down further.
- **Persistent storage.** A container instance's local disk does not survive a restart, and the
  SQLite database, the generated admin password, the auth secret, and the encryption key all live
  under `/app/packages/web/data` (the path `docker-compose.yml` mounts a volume at). Mount an Azure
  Files share at that same path as the container group's volume, or every restart looks like a
  brand-new install.
- **Application Gateway v2** terminates TLS (a certificate from Key Vault, or uploaded directly) on
  its public frontend, with a backend pool pointing at the container group's private IP, backend
  port 3000 over plain HTTP (fine here, that hop never leaves the VNet), and a custom health probe
  on `/api/health`, the same unauthenticated liveness route the image's own `HEALTHCHECK` polls.
- **`AUTH_URL`** is Application Gateway's public HTTPS address (a custom domain pointed at its
  public IP, with a matching certificate). Set it as a container environment variable, and register
  `<AUTH_URL>/api/auth/callback/microsoft-entra-id` in Entra ID exactly as described above.

Illustrative rather than copy-paste-ready.

bash or zsh:

```bash
# Container group: VNet-injected, no public IP, data volume on Azure Files
az container create -g rulebeat-rg -n rulebeat \
  --image ghcr.io/rulebeat/rulebeat:0.2.4 \
  --vnet rulebeat-vnet --subnet aci-subnet \
  --ports 3000 \
  --azure-file-volume-account-name <storage-account> \
  --azure-file-volume-account-key <key> \
  --azure-file-volume-share-name rulebeat-data \
  --azure-file-volume-mount-path /app/packages/web/data \
  --environment-variables AUTH_URL=https://rulebeat.example.com AZURE_TENANT_ID=<tenant-id> \
  --restart-policy Always

# Application Gateway's backend pool points at the container group's private IP
az network application-gateway address-pool create -g rulebeat-rg \
  --gateway-name rulebeat-appgw --name rulebeat-backend \
  --servers <container-group-private-ip>
```

PowerShell:

```powershell
# Container group: VNet-injected, no public IP, data volume on Azure Files
az container create -g rulebeat-rg -n rulebeat `
  --image ghcr.io/rulebeat/rulebeat:0.2.4 `
  --vnet rulebeat-vnet --subnet aci-subnet `
  --ports 3000 `
  --azure-file-volume-account-name <storage-account> `
  --azure-file-volume-account-key <key> `
  --azure-file-volume-share-name rulebeat-data `
  --azure-file-volume-mount-path /app/packages/web/data `
  --environment-variables AUTH_URL=https://rulebeat.example.com AZURE_TENANT_ID=<tenant-id> `
  --restart-policy Always

# Application Gateway's backend pool points at the container group's private IP
az network application-gateway address-pool create -g rulebeat-rg `
  --gateway-name rulebeat-appgw --name rulebeat-backend `
  --servers <container-group-private-ip>
```

Worth knowing before choosing this over a plain VM running Caddy or nginx: a classic container
instance has no probe-based restart of its own. Application Gateway's health probe only stops
routing to a dead container, it does not restart it, and `--restart-policy Always` restarts on
crash, not on a hung process. If you want a managed ingress layer with less to wire up by hand,
Azure Container Apps' built-in ingress (automatic TLS on a custom domain, no separate gateway
resource to run) is the lighter-weight alternative.

## Azure scanning credential

RuleBeat only ever needs the **Reader** role, and you can verify that yourself in Azure RBAC.
RuleBeat never creates a service principal and never assigns itself a role: you create the
identity, RuleBeat only uses it. See [`permissions.md`](permissions.md) for how to create one.

There are five ways to supply a credential, ranked best first. Pick one; env always wins over a
credential entered in Settings → Azure connection.

1. **Managed identity** (best). Running on Azure (App Service, Container Apps, a VM)? Enable a
   managed identity, grant it Reader, and set nothing beyond `AZURE_TENANT_ID`. No secret exists to
   leak, rotate, or expire.
2. **Workload identity federation** (keyless, works off-Azure). Running somewhere that can produce
   an OIDC token (AKS workload identity, GitHub Actions, another cloud), federate it to an Entra app
   registration: `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE`. This is Microsoft's current
   recommendation for workloads running outside Azure.
3. **Certificate.** `AZURE_CLIENT_ID` and `AZURE_CLIENT_CERTIFICATE_PATH`. If the certificate
   file is password-protected, `AZURE_CLIENT_CERTIFICATE_PASSWORD` as well; that one is read by
   the Azure SDK itself, not by RuleBeat.
4. **Client secret, mounted as a file.** `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET_FILE`. This is
   the same `*_FILE` convention the official Postgres and MySQL images use, and what Docker
   secrets, Kubernetes secrets, and the Key Vault CSI driver all mount into. An environment
   variable holding a secret is visible in `docker inspect` to anyone in the docker group,
   inherited by every child process, and can turn up in crash dumps; a mounted file avoids all of
   that and can be rotated without a restart, since RuleBeat re-reads the file on each use.
5. **Client secret, plain variable** (last resort). `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`.
   Works everywhere and needs no orchestration, but a long-lived bearer secret in cleartext is the
   weakest option here. On Azure App Service you can set this variable's value to a Key Vault
   reference (`@Microsoft.KeyVault(SecretUri=...)`), which resolves before RuleBeat ever sees it.

Or leave all five unset and enter a client ID and secret in Settings → Azure connection after
signing in. For local development, `az login` on your own machine is picked up automatically with
nothing to set.

Whichever path you use, granting the same identity the optional Microsoft Graph
`Application.Read.All` permission enables Directory rules, including the two built-in identity
checks. See [`permissions.md`](permissions.md).

## Encryption key for stored secrets

`RULEBEAT_ENCRYPTION_KEY` encrypts every secret entered through the console (Azure client secret,
SSO client secret, notification webhook URLs, SMTP password) with AES-256-GCM before it's written
to the database. Leave it unset and RuleBeat generates one on first boot, stored at
`data/encryption.key` beside the database. That's fine for a normal self-host, but note it means a
copy of the whole data volume (a backup, a cloned disk) carries the key alongside the ciphertext it
opens. Set the variable explicitly, from a secret store outside the data volume, if you need a
backup to actually be safe without it. Back it up either way: losing it means every one of those
stored secrets has to be re-entered. Findings, rules, and history are never encrypted and are
unaffected if the key is lost.

`RULEBEAT_ENCRYPTION_KEY_FILE` mounts the key as a file instead and wins over
`RULEBEAT_ENCRYPTION_KEY` when both are set, same convention as the other `*_FILE` variables on
this page. Like `AUTH_SECRET_FILE`, it's read once and cached for the life of the process, so
rotating it needs a restart. See below before rotating this one specifically.

## Rotating secrets

Whether rotating a `*_FILE`-mounted secret takes effect immediately or needs a restart depends on
which one:

- **`AZURE_CLIENT_SECRET_FILE`**: picked up immediately. `lib/azure-credential.ts` re-reads the
  file on every Azure call, so replacing its contents (or what it points at) affects the very next
  scan, no restart.
- **`AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE`**: picked up immediately, for the same reason: resolved
  fresh on every sign-in.
- **`AUTH_SECRET_FILE`** and **`RULEBEAT_ENCRYPTION_KEY_FILE`**: cached in memory after the first
  read. Editing the file or repointing the variable at a new one has no effect until the process
  restarts. Rotating `AUTH_SECRET` this way invalidates every live session (everyone signs in
  again); that's expected.

**Rotating `RULEBEAT_ENCRYPTION_KEY`(`_FILE`) specifically** takes a sequence, because every
secret stored through the console becomes unreadable the moment the key that encrypted it changes:

1. Confirm local sign-in is actually reachable before touching the key: check Settings → Sign-in,
   or sign in with a local account once. A stored SSO provider's client secret is among the
   secrets the rotation makes unreadable, and if the local sign-in policy is also set to
   `disabled` at that moment, every admin is locked out at once with no way back in short of
   `RULEBEAT_FORCE_LOCAL_SIGNIN` on the host itself.
2. Change the key and restart the process.
3. Re-save each stored credential (Azure connection, SSO client secret, webhook URLs, SMTP
   password). None of them are silently lost, they just need to be entered again once they read
   back as unreadable.

## Scan history retention

`SCAN_HISTORY_LIMIT` caps how many scan runs are kept per category in Run History; the default is
90, and older runs are pruned as new ones complete. The findings lifecycle is unaffected: a
finding's first-seen, last-seen, and fixed state live in their own table, so pruning old run
records never changes the posture number or a finding's age.
