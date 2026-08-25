# Security and privacy

RuleBeat only ever needs the **Reader** role, and every call it makes to Azure is a read. The setup
guide walks you through creating a dedicated identity and granting it Reader, and nothing more, on
the subscriptions or management groups you want scanned. That identity's actual permissions are
whatever Azure RBAC says they are, not whatever RuleBeat claims: RuleBeat does not inspect or
enforce the role of the credential you give it, so if you hand it a credential with broader access
(a shared Owner or Contributor account, for example), it will work but you've granted more than it
needs. Follow the setup guide and give it a credential scoped to Reader alone; that's the guarantee,
and you can confirm it yourself in Azure RBAC.

## What RuleBeat reads

- **Azure Resource Graph**, to run rule queries against your resource inventory.
- **The ARM provider aliases API**, to know what fields exist on each resource type (the same
  source Azure Policy itself uses for this).
- **Microsoft Graph**, only if you've granted it a Graph read permission, only to power Directory
  rules: checks about the directory itself (app registrations, service principals, and whichever
  other object types your grant allows) rather than Azure resources, including the
  <!-- count:credential-expiry-rules -->two built-in checks for expiring app credentials. The
  documented grant, `Application.Read.All`, is a tenant-wide application permission, not scoped by
  Azure subscription RBAC, so grant it deliberately. RuleBeat also enforces its own allowlist of
  <!-- count:graph-resource-types -->seven Graph resource types a rule can read, independent of
  what the permission itself would allow. Skip the grant and everything else works normally;
  Directory rules are simply skipped.

All three are read operations. None of them can modify anything in your tenant. This list is the
complete set of Azure-side surfaces RuleBeat reads today; when a new rule backend ships (Log
Analytics is the one designed next), it will be added here rather than folded into an existing
line, so this page stays an exact inventory.

## What RuleBeat stores, and where

Everything lives in a SQLite database inside your own deployment: rules, findings, scan history,
dashboards, users, and any Azure credential or notification webhook URL you enter through the
console. Nothing is synced to a service RuleBeat operates. If you're running the Docker image, all
of it sits in the single named volume the compose file mounts; back that volume up and you have
everything.

Secrets specifically (an Azure client secret entered through the console, an SSO client secret, and
notification channel URLs or SMTP passwords) are encrypted at rest with AES-256-GCM before being
written to that database. By default the key that decrypts them lives right next to the database,
in the same data volume, so a copy of the whole volume (a backup, a cloned disk) carries both the
ciphertext and the key that opens it, and is not protected. To actually get the backup-safety
property, set `RULEBEAT_ENCRYPTION_KEY` explicitly from a secret store outside the data volume; see
[`configure.md`](configure.md). Either way, encryption does not protect a secret from a process that
already has access to the running container, which is a different threat model. That is also why
the credential paths that need no secret at all (managed identity, workload identity federation) are
ranked above the ones that do.

## What's plaintext, and what's encrypted

Only three kinds of field in the database are AES-256-GCM ciphertext rather than plaintext:

- The Azure client secret stored under Settings → Azure connection.
- The Microsoft Entra ID (SSO) client secret stored under Settings → Sign-in.
- Every notification channel's destination detail: webhook URLs and SMTP passwords.

Everything else is plaintext: rule definitions and their KQL, every finding (resource IDs,
subscription IDs, resource group names, severity, evidence), scan and schedule history, dashboard
layouts, the audit log, user accounts and role assignments, and the Azure client ID / tenant ID /
SSO client ID sitting next to their encrypted secrets (the identifiers aren't secret on their own).
Local account passwords are hashed, not encrypted and not plaintext: they can be checked against a
sign-in attempt but never recovered.

## File permissions and who can read it

On Linux, RuleBeat sets the database file, its `-wal`/`-shm` sidecars, and the generated
`data/auth.key`, `data/encryption.key`, and `data/initial-password.txt` files to `0600` on every
startup, readable only by the user the process runs as. This is a no-op on Windows, which has no
equivalent permission bit.

That's a floor, not a full answer to "who can read this." Root on the host, anyone with a shell in
the container, and anyone with access to the Docker volume or a bind-mounted host directory can read
the database file directly, encrypted fields included, the same way RuleBeat itself does. Encryption
at rest covers the case described above: the database travelling somewhere without its key (a
support bundle, a copied backup, a leaked volume snapshot). It does not protect against someone who
already has access to the running container or its host. That is a different threat model, and part
of why the credential-free Azure connection paths (managed identity, workload identity federation)
outrank anything that stores a secret at all. See
[`configure.md`](configure.md#azure-scanning-credential).

## Backup and restore

There's no published or tested backup/restore procedure yet. Until there is, the practical guidance
is: whatever copies the data volume (the `data/` directory, or the Docker named volume) copies the
exact plaintext/encrypted split described above along with it. If you've pointed
`RULEBEAT_ENCRYPTION_KEY` or `RULEBEAT_ENCRYPTION_KEY_FILE` outside the volume specifically so a
backup of the volume alone isn't enough to decrypt it, back up the key the same way you back up the
volume, or every stored secret has to be re-entered on restore. See
[`configure.md`](configure.md#rotating-secrets) for the exact behaviour when that key is lost or
changes.

## Verifying a published image

Every image published to `ghcr.io/rulebeat/rulebeat` is signed with [Sigstore's keyless
signing](https://docs.sigstore.dev/cosign/signing/overview/): no private key exists to leak or
rotate, and the signature is tied to the exact GitHub Actions workflow run, in this exact repo, that
built the image, recorded publicly in Sigstore's Rekor transparency log. Verify a pulled image with
[`cosign`](https://docs.sigstore.dev/cosign/installation/):

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/rulebeat/rulebeat/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/rulebeat/rulebeat:latest
```

A successful verification prints the signing certificate's identity and the Rekor log entry. Every
image also carries a software bill of materials and a build provenance attestation, generated at
build time by Docker Buildx and attached to the same digest as the signature. Inspect either with:

```bash
docker buildx imagetools inspect ghcr.io/rulebeat/rulebeat:latest --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/rulebeat/rulebeat:latest --format '{{ json .Provenance }}'
```

The CI pipeline that builds and scans every image is public: see
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) and
[`.github/workflows/publish-image.yml`](../../.github/workflows/publish-image.yml). Every
third-party GitHub Action either workflow uses is pinned to a commit SHA rather than a mutable
version tag, so a compromised or force-moved action tag cannot silently change what runs in either
pipeline.

## What RuleBeat never does

- Never issues an Azure write call. Its code only ever performs read operations, regardless of
  what the credential you supply is capable of.
- Never creates its own service principal, and never assigns itself a role. You create the
  identity; RuleBeat only uses it.
- Never uses your own sign-in token to call Azure. The identity you sign into RuleBeat with and
  the identity RuleBeat scans Azure with are two separate, independently configured things.
- Never blocks a deployment or enforces anything. RuleBeat reports; it does not gate.
- Never performs PIM or PAM role elevation. A governance tool that could escalate its own
  privileges would be a bigger risk than the misconfigurations it exists to catch.

## No telemetry

RuleBeat makes no calls to any service it operates, and collects no usage analytics. The only
outbound network calls it ever makes are: Azure and Microsoft Graph (using the credential you
configured, scoped to exactly what that credential can reach), and notification deliveries to the
webhook or SMTP endpoint you configured yourself in Settings → Notifications. This is verifiable,
not just asserted: since RuleBeat is self-hosted, you control the network egress of the container
it runs in and can confirm this directly.

## Authentication and sessions

You sign in either with a local account (a password stored, hashed, in your own database) or with
Microsoft Entra ID, if you've configured it. A session lasts 12 hours with an hourly refresh. Your
role (viewer, editor, or admin) is looked up from the database on every request rather than stored
in the session itself, so a change to your permissions takes effect on your very next request
instead of waiting for the session to expire. See [`rbac.md`](rbac.md) for the full permission
model.

## Reporting a vulnerability

See [`SECURITY.md`](../../SECURITY.md) in the repository root.

## What this page doesn't cover

This is a description of how RuleBeat is built, not a legal privacy policy or a signed agreement.
If your organization needs a formal document for procurement or compliance purposes, reach out
directly rather than relying on this page as one.
