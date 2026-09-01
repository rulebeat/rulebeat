# Security and privacy

RuleBeat only ever needs the **Reader** role, and every call it makes to Azure is a read. That
identity's actual permissions are whatever Azure RBAC says they are, not whatever RuleBeat claims:
RuleBeat does not inspect or enforce the role of the credential you give it, so a broader credential
will work and will simply have granted more than it needs. Follow
[`permissions.md`](permissions.md), give it Reader alone, and confirm it in Azure RBAC.

## What RuleBeat reads

- **Azure Resource Graph**, to run rule queries against your resource inventory.
- **The ARM provider aliases API**, to know what fields exist on each resource type.
- **Microsoft Graph**, only if you granted a Graph read permission, only to power Directory rules,
  including the <!-- count:credential-expiry-rules -->two built-in checks for expiring app
  credentials. The documented grant, `Application.Read.All`, is a tenant-wide application permission
  not scoped by subscription RBAC, so grant it deliberately. RuleBeat also enforces its own allowlist
  of <!-- count:graph-resource-types -->seven Graph resource types a rule can read, independent of
  what the permission would allow. Skip the grant and Directory rules are skipped.

All three are read operations, and this is the complete set of Azure-side surfaces read today. A new
rule backend will be added here rather than folded into an existing line, so this stays an exact
inventory.

## What is stored, and what is encrypted

Everything lives inside your own deployment: by default in a SQLite database in the single named
volume the compose file mounts, or in the PostgreSQL database you point `RULEBEAT_DATABASE_URL` at
([`install.md`](install.md#deployment-topology)). Nothing is synced to a service RuleBeat
operates.

Exactly three kinds of field are AES-256-GCM ciphertext: the Azure client secret, the Entra ID (SSO)
client secret, and every notification channel's destination detail (webhook URLs, SMTP passwords).
Everything else is plaintext: rule definitions and their KQL, every finding, scan and schedule
history, dashboard layouts, the audit log, user accounts and roles, and the client and tenant IDs
sitting beside their encrypted secrets, which are not secret on their own. Local passwords are
hashed, so they can be checked against a sign-in attempt but never recovered.

By default the key that decrypts those three lives next to the database in the same volume, so a copy
of the volume carries both the ciphertext and the key that opens it. To get the backup-safety
property, set `RULEBEAT_ENCRYPTION_KEY` from a secret store outside the volume
([`configure.md`](configure.md#azure-scanning-credential)), and back the key up the same way you back
up the volume, or every stored secret must be re-entered on restore. There is no published, tested
backup and restore procedure yet beyond copying the volume in SQLite mode, or your database
server's own dump tooling in Postgres mode.

Encryption at rest covers the database travelling somewhere without its key: a support bundle, a
copied backup, a leaked snapshot. It does not protect against someone who already has access to the
running container or its host. On Linux, RuleBeat sets the SQLite database, its `-wal`/`-shm` sidecars and
the generated `auth.key`, `encryption.key` and `initial-password.txt` to `0600` on every startup,
which is a floor rather than a full answer: root on the host, a shell in the container, or access to
the volume all read the file directly. That threat model is part of why the credential paths with no
secret at all are ranked above the ones with one.

## Verifying a published image

Every image published to `ghcr.io/rulebeat/rulebeat` is signed with [Sigstore's keyless
signing](https://docs.sigstore.dev/cosign/signing/overview/): no private key exists to leak or
rotate, and the signature is tied to the exact GitHub Actions workflow run, in this repo, that built
the image, recorded publicly in Sigstore's Rekor transparency log.

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/rulebeat/rulebeat/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/rulebeat/rulebeat:0.2.4
```

Every image also carries an SBOM and a build provenance attestation, attached to the same digest:

```bash
docker buildx imagetools inspect ghcr.io/rulebeat/rulebeat:0.2.4 --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/rulebeat/rulebeat:0.2.4 --format '{{ json .Provenance }}'
```

The pipelines that build and scan every image are public
([`ci.yml`](https://github.com/rulebeat/rulebeat/blob/main/.github/workflows/ci.yml),
[`publish-image.yml`](https://github.com/rulebeat/rulebeat/blob/main/.github/workflows/publish-image.yml)),
and every third-party Action either uses is pinned to a commit SHA, so a force-moved tag cannot
silently change what runs.

## What RuleBeat never does

Never issues an Azure write call, whatever the credential is capable of. Never creates its own
service principal or assigns itself a role. Never uses your sign-in token to call Azure: the identity
you sign in with and the identity RuleBeat scans with are two separate things. Never blocks a
deployment or enforces anything. Never performs PIM or PAM elevation.

## No telemetry

RuleBeat makes no calls to any service it operates and collects no usage analytics. Its only outbound
calls are to Azure and Microsoft Graph with the credential you configured, and to the notification
endpoints you configured yourself. Being self-hosted, you control the container's network egress and
can confirm this directly rather than take it on assertion.

## Authentication and sessions

You sign in with a local account (a password hashed in your own database) or with Microsoft Entra ID.
A session lasts 12 hours with an hourly refresh. Your role is looked up from the database on every
request rather than stored in the session, so a permission change takes effect on your next request
([`rbac.md`](rbac.md)).

Report a vulnerability through
[`SECURITY.md`](https://github.com/rulebeat/rulebeat/blob/main/SECURITY.md). This page describes how
RuleBeat is built; it is not a legal privacy policy.
