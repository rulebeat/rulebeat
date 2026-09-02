# Installing RuleBeat

You need Docker. Connecting real Azure data needs a subscription with at least Reader access, and you
can explore the UI without connecting anything.

## Run it

bash or zsh:

```bash
docker run -d --name rulebeat --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -v rulebeat-data:/app/packages/web/data \
  -e AUTH_URL=http://localhost:3000 \
  ghcr.io/rulebeat/rulebeat:0.4.0
```

PowerShell:

```powershell
docker run -d --name rulebeat --restart unless-stopped -p 127.0.0.1:3000:3000 `
  -v rulebeat-data:/app/packages/web/data `
  -e AUTH_URL=http://localhost:3000 `
  ghcr.io/rulebeat/rulebeat:0.4.0
```

Confirm it reports healthy (a few seconds to move past `starting`), then continue with
[First sign-in](#first-sign-in):

```
docker inspect rulebeat --format '{{.State.Health.Status}}'
```

Two things that command decides for you. The port binding is loopback-only, because RuleBeat holds a
live Azure read credential and has no TLS of its own, so it is reachable from this machine and
nowhere else until you put a reverse proxy in front
([`configure.md`](configure.md#exposing-it-beyond-localhost)). And `AUTH_URL` uses `localhost` rather
than `127.0.0.1` because Entra ID accepts a sign-in redirect URI only over HTTPS or on
`http://localhost` and refuses an IP address.

Everything (the SQLite database, the generated admin password, the auth secret, the encryption key)
lives in the `rulebeat-data` named volume. Back that up, not the container. To store everything in
your own PostgreSQL instead of the bundled SQLite, see
[Run it on PostgreSQL](#run-it-on-postgresql).

Prefer Compose? Save this as `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  rulebeat:
    image: ghcr.io/rulebeat/rulebeat:0.4.0
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      AUTH_URL: http://localhost:3000
      # To use PostgreSQL instead of the bundled SQLite, add the connection string here;
      # see "Run it on PostgreSQL" below.
      # RULEBEAT_DATABASE_URL: postgres://rulebeat:<password>@<host>:5432/rulebeat
    volumes:
      - rulebeat-data:/app/packages/web/data
volumes:
  rulebeat-data:
```

The repo's own
[`docker-compose.yml`](https://github.com/rulebeat/rulebeat/blob/main/docker-compose.yml) is the
long-form version: it builds from source and documents every environment variable RuleBeat reads,
each optional. To build from source instead of pulling:

```
git clone https://github.com/rulebeat/rulebeat.git
cd rulebeat
docker compose up -d --build
```

The commands here pin the newest release and are rewritten automatically when one ships, so a copied
command installs a known version and never goes stale. `:latest` tracks the same image, and every
release keeps its own version tag on the
[releases page](https://github.com/rulebeat/rulebeat/releases). Every published image is signed and
carries an SBOM and build provenance you can verify yourself; see
[Verifying a published image](security.md#verifying-a-published-image).

## Run it on PostgreSQL

The quick start above needs nothing from this section: SQLite is the default and the right choice
for a typical single-host install. Set `RULEBEAT_DATABASE_URL` to a `postgres://` connection string
and RuleBeat stores everything in a PostgreSQL database you provide instead. RuleBeat itself stays
one container either way; Postgres is a database it connects to, not a second RuleBeat.

### Prepare the database

RuleBeat needs an empty database and a user allowed to create tables in it, nothing more. On first
boot it creates its schema and seeds the same built-in content a fresh SQLite install gets, with no
extensions and no superuser involved. Any supported PostgreSQL release works; the examples here and
RuleBeat's own CI use PostgreSQL 17. The connection string always has the same shape:

```
postgres://user:password@host:5432/rulebeat
```

Where the database runs is up to you. Three common homes for it:

**Azure Database for PostgreSQL (managed).** The natural pairing when RuleBeat itself runs on Azure
Container Apps, App Service or Container Instances, where SQLite mode cannot mount its volume (see
[Deployment topology](#deployment-topology)). The smallest burstable tier is enough; RuleBeat
writes a scan summary per run plus finding updates, not a stream. Create a flexible server with a
database named `rulebeat`:

```bash
az postgres flexible-server create --resource-group <rg> --name <server-name> \
  --tier Burstable --sku-name Standard_B1ms --database-name rulebeat \
  --admin-user rulebeat --admin-password <password>
```

Then let RuleBeat reach it: private access on your VNet, or public access with a firewall rule for
the app's outbound IP. Azure enforces TLS, so append `?sslmode=require` to the connection string.
Those same platforms have no data volume, so alongside the URL set
`RULEBEAT_DATABASE_BACKEND=postgres`, `AUTH_SECRET`, `RULEBEAT_ENCRYPTION_KEY` and
`RULEBEAT_INITIAL_PASSWORD`, or the first restart signs everyone out and loses the generated keys
([Running with no persistent volume](configure.md#running-with-no-persistent-volume)).
[Azure Container Apps](#azure-container-apps) below walks through the whole thing in the portal.

**A Postgres container next to RuleBeat.** The single-machine self-host shape. One Compose file
describes both containers (two services in one file, never a file per container). The password
does not belong in that file: anyone who can read the file, or a commit of it, would have the
database password. Instead, create a `.env` file next to it holding the one secret, and keep
`.env` out of version control:

```
POSTGRES_PASSWORD=<something long and random>
```

Then save this as `docker-compose.yml` and run `docker compose up -d`. Compose reads `.env`
automatically and substitutes `${POSTGRES_PASSWORD}` in both places, so the compose file never
contains the password and is safe to share or commit:

```yaml
services:
  rulebeat:
    image: ghcr.io/rulebeat/rulebeat:0.4.0
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      AUTH_URL: http://localhost:3000
      RULEBEAT_DATABASE_URL: postgres://rulebeat:${POSTGRES_PASSWORD}@postgres:5432/rulebeat
    volumes:
      - rulebeat-data:/app/packages/web/data
    depends_on:
      postgres:
        condition: service_healthy
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: rulebeat
      POSTGRES_DB: rulebeat
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - rulebeat-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rulebeat -d rulebeat"]
      interval: 10s
      timeout: 5s
      retries: 5
volumes:
  rulebeat-data:
  rulebeat-pg-data:
```

Compose puts both containers on one network, so the app reaches the database at the hostname
`postgres`. Building from source instead? The repo's own
[`docker-compose.yml`](https://github.com/rulebeat/rulebeat/blob/main/docker-compose.yml) has the
same service behind an optional profile: set `POSTGRES_PASSWORD` and `RULEBEAT_DATABASE_URL` in
`.env` and start with `docker compose --profile postgres up -d`; a plain `docker compose up`
stays on SQLite.

Either way the password still reaches the containers as an environment value, which anyone who can
run `docker inspect` on the host can read. To keep it out of the environment entirely, mount it as
a Docker secret and use the file variants both sides support: `RULEBEAT_DATABASE_URL_FILE` for
RuleBeat ([configure.md](configure.md#database-backend)) and `POSTGRES_PASSWORD_FILE` for the
postgres image.

Without Compose, the same pair works with `docker run`, but the two containers must share a Docker
network and address each other by container name, because `localhost` inside the RuleBeat container
is the container itself, not your machine:

```bash
docker network create rulebeat-net

docker run -d --name rulebeat-postgres --restart unless-stopped --network rulebeat-net \
  -v rulebeat-pg-data:/var/lib/postgresql/data \
  -e POSTGRES_USER=rulebeat -e POSTGRES_DB=rulebeat -e POSTGRES_PASSWORD=<password> \
  postgres:17

docker run -d --name rulebeat --restart unless-stopped --network rulebeat-net \
  -p 127.0.0.1:3000:3000 \
  -v rulebeat-data:/app/packages/web/data \
  -e AUTH_URL=http://localhost:3000 \
  -e "RULEBEAT_DATABASE_URL=postgres://rulebeat:<password>@rulebeat-postgres:5432/rulebeat" \
  ghcr.io/rulebeat/rulebeat:0.4.0
```

These inline `-e` values also land the password in your shell history, so treat this pair as a
quick trial and prefer the Compose file with `.env`, or the `*_FILE` secrets, for anything that
stays running.

**A server you already run.** Any reachable PostgreSQL works: another VM, another cloud, a shared
cluster. Create an empty database and a user that owns it, and add `?sslmode=require` to the
connection string if the server enforces TLS.

### Point RuleBeat at it

For the managed and existing-server options, the install is the quick start command plus one
variable (in PowerShell, swap the trailing `\` for a backtick):

```bash
docker run -d --name rulebeat --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -v rulebeat-data:/app/packages/web/data \
  -e AUTH_URL=http://localhost:3000 \
  -e "RULEBEAT_DATABASE_URL=postgres://rulebeat:<password>@<host>:5432/rulebeat?sslmode=require" \
  ghcr.io/rulebeat/rulebeat:0.4.0
```

The data volume stays useful in Postgres mode: the auth secret, the encryption key and the
generated first password still live under `data/` unless you supply them by environment, so keep
it mounted, or go fully stateless with the three variables described in
[Deployment topology](#deployment-topology). Backup moves from copying one file to `pg_dump`
([How do I back it up?](faq.md#how-do-i-back-it-up)). Switching backends later is a fresh install:
nothing is migrated between SQLite and Postgres in either direction. Anywhere this command is saved rather
than typed once (a script, a unit file, a pipeline), prefer `RULEBEAT_DATABASE_URL_FILE`, which
mounts the connection string as a file instead of putting the password in the environment
([configure.md](configure.md#database-backend)).

### Azure Container Apps

The portal walkthrough for the managed pairing: RuleBeat on Container Apps, its database on Azure
Database for PostgreSQL, no volume, and no local terminal needed. The shape suits a dev or team
tenant; a production install would put the database on private access and TLS in front of the
app as described in [configure.md](configure.md#exposing-it-beyond-localhost).

1. **Create the database.** Azure Database for PostgreSQL flexible servers, Create. Workload type
   Development, PostgreSQL 17, compute Burstable `Standard_B1ms`, authentication PostgreSQL only,
   admin user `rulebeat` with a long password. Under Networking choose Public access and tick
   "Allow public access from any Azure service within Azure to this server". Once it deploys, open
   Settings, Databases, Add and create a database named `rulebeat`. The portal does not create it
   for you.

2. **Make three random values.** Open Cloud Shell from the portal's top bar, choose Bash, and run
   `openssl rand -base64 32` three times, or use a password manager's generator. They become
   `AUTH_SECRET`, `RULEBEAT_ENCRYPTION_KEY` and `RULEBEAT_INITIAL_PASSWORD`
   ([Making a random value](configure.md#making-a-random-value)). Keep the first two somewhere
   durable; losing the encryption key makes every credential saved through the console unreadable.

3. **Create the Container App.** Container Apps, Create; a new environment is fine. On the Container
   tab choose image source "Docker Hub or other registries", image type Public, and enter the image
   `ghcr.io/rulebeat/rulebeat:0.4.0`, which the portal splits into a registry login server of
   `ghcr.io` and the rest as image and tag. Give it 1 vCPU and 2 GiB. Add these environment
   variables, using "Reference a secret" for the connection string so the password is stored as a
   Container Apps secret rather than a plain value:

   | Name | Value |
   |---|---|
   | `RULEBEAT_DATABASE_BACKEND` | `postgres` |
   | `RULEBEAT_DATABASE_URL` | `postgres://rulebeat:<password>@<server-name>.postgres.database.azure.com:5432/rulebeat?sslmode=require` |
   | `AUTH_SECRET` | first value from step 2 |
   | `RULEBEAT_ENCRYPTION_KEY` | second value from step 2 |
   | `RULEBEAT_INITIAL_PASSWORD` | third value from step 2 |
   | `AZURE_TENANT_ID` | the tenant to scan |

   The first row is the guardrail: with it set, a container that cannot see the connection string
   refuses to start and says so in its log, instead of running on a SQLite file that the next
   restart deletes. Check the Log stream after the first boot for a line starting
   `[startup] storage: PostgreSQL`; the same appears on the Diagnostics page after sign-in.

   On the Ingress tab enable ingress, accept traffic from anywhere, HTTP, target port 3000. Create.

4. **Settings on the new app.** Under Scale set minimum and maximum replicas both to 1: RuleBeat
   runs exactly one replica, and scaling to zero would stop the scheduler. Under Identity turn on
   System assigned, then Azure role assignments, Add: scope Subscription, role Reader, once per
   subscription to scan. RuleBeat picks that identity up with nothing else set. When you want
   Microsoft sign-in, add `AUTH_URL` set to the application URL from the Overview page as a new
   revision, and register the redirect URI under it
   ([Microsoft Entra ID sign-in](configure.md#microsoft-entra-id-sign-in-optional)).

5. **First sign-in.** Open the application URL and sign in as `admin@rulebeat.local` with the third
   value from step 2; it forces a change. The wizard's Connect Azure step recognises the managed
   identity and shows it with a Verify button instead of a service principal form: press Verify
   to confirm it reaches your subscriptions, then Continue through the remaining steps to the
   first scan.

Directory rules need the Microsoft Graph `Application.Read.All` permission on that identity. The
portal cannot grant an application permission to a managed identity, and the `az ad app permission`
commands in [`permissions.md`](permissions.md) target an app registration, so on a managed
identity it takes a Graph app-role assignment through PowerShell or the Graph API. Skip Directory
rules until then; every Resource Graph rule works with Reader alone. The generated first password
is never involved here because step 2 chose one, so the `docker exec` step under
[First sign-in](#first-sign-in) does not apply.

## First sign-in

1. Read the generated admin password. It is written to `data/initial-password.txt` inside the data
   volume, never to the container logs, so it does not outlive the forced change in your log history:

   ```
   docker exec rulebeat cat data/initial-password.txt
   ```

2. Open `http://localhost:3000`, sign in with it, and change the password when prompted. The
   generated one is meant to be used exactly once.

   ![The sign-in page with the local email and password form](img/signin.png)

3. Follow the <!-- count:onboarding-steps -->four-step wizard that opens next: connect Azure, verify
   what the credential can reach, choose what to scan, and run a first scan. See
   [`permissions.md`](permissions.md) for the identity it asks for.

   ![Wizard step 1, Connect Azure, asking for a tenant id, client id and client secret](img/onboarding-connect.png)

   ![Wizard step 3, choosing which categories to scan](img/onboarding-scope.png)

   ![Wizard step 4, running the first scan or finishing later](img/onboarding-scan.png)

To show RuleBeat around before connecting a real tenant, run it in demo mode instead:
[`demo-mode.md`](demo-mode.md).

## Arriving pre-configured

All of the above works with a completely empty `.env`, and everything it sets up can be configured
later from the console. For a deployment that should arrive already configured, set the relevant
environment variables before the first boot. Environment variables always win over anything entered
in the console, so a template deployment never falls back to a setup screen. The full list is in
[`configure.md`](configure.md).

## Upgrading

A running instance shows its version in the sidebar footer and on the Diagnostics page; the
[releases page](https://github.com/rulebeat/rulebeat/releases) shows the newest and what changed.

1. `docker pull ghcr.io/rulebeat/rulebeat:0.4.0`
2. `docker stop rulebeat && docker rm rulebeat` (the data volume is untouched)
3. Start the new one with the same `docker run` command as the install above.

With Compose, update `image:` to the new tag, then `docker compose pull && docker compose up -d` does
both steps.

Migrations run automatically against the existing volume on startup. RuleBeat's test suite includes an
upgrade path test that synthesizes old database shapes and asserts rules, findings, dashboards, users
and suppressions all survive unchanged, specifically because migrations are where data loss tends to
hide.

## Deployment topology

The supported shape is **one replica**, with either of two storage backends. The default is SQLite
in the data volume: one container, one volume, no external database, exactly what the quick start
above runs. Setting `RULEBEAT_DATABASE_URL` to a `postgres://` connection string switches storage
to a PostgreSQL database you provide instead: Azure Database for PostgreSQL, any other server you
run, or a Postgres container next to RuleBeat for a single-machine self-host. The worked
commands for each are in [Run it on PostgreSQL](#run-it-on-postgresql). RuleBeat itself stays
one container in both modes; Postgres is a database it connects to, not a second RuleBeat.

On first boot against an empty Postgres database RuleBeat creates its schema and seeds the same
built-in content a fresh SQLite install gets; the database only has to exist and be reachable.
Switching backends later is a fresh install: nothing is migrated between SQLite and Postgres in
either direction. `RULEBEAT_DATABASE_URL_FILE` mounts the connection string as a file, the same
`*_FILE` convention as the other secrets, since the string carries the database password
([`configure.md`](configure.md#database-backend)).

**SQLite mode needs a local filesystem.** RuleBeat opens SQLite in WAL mode, which SQLite does not
support over a network filesystem, so a Docker named volume on the host's own disk works, and so
does a block device such as an Azure managed disk or a block-mode Kubernetes volume. A file share
does not. Mount Azure Files, or any other SMB or NFS share, at `/app/packages/web/data` and the
database cannot be opened at all, so the container fails on startup rather than running with less.
That rules SQLite mode out on the managed container platforms whose only persistent storage is a
file share, among them Azure Container Apps, Azure App Service and Azure Container Instances.

**Postgres mode is how RuleBeat runs on exactly those platforms**, because the database moves out
of the container. To run with no persistent volume at all, three values must come from the
environment rather than from generated files in `data/`: `RULEBEAT_DATABASE_URL`, `AUTH_SECRET`
and `RULEBEAT_ENCRYPTION_KEY`. With all three set the container is stateless and can restart, move
hosts or redeploy freely. With only the database URL set, RuleBeat still generates its auth secret
and encryption key as files under `data/`, and losing those files signs everyone out and makes
every stored secret unreadable, so either keep the volume mounted or set the two keys. One more
file matters on a truly volume-less deployment: the generated first admin password is written to
`data/initial-password.txt` inside the container, so read it with `docker exec` (or your platform's
console) before the container is replaced, or set `RULEBEAT_INITIAL_PASSWORD` so there is nothing
generated to lose. The four variables, what each one replaces, and how to produce the values are
in [Running with no persistent volume](configure.md#running-with-no-persistent-volume); the
portal steps are under [Azure Container Apps](#azure-container-apps).

**Both modes run a single replica.** Postgres removes SQLite's single-writer constraint, but the
background scheduler has no cross-instance coordination: each replica's 30-second poll loop and
busy flag are in-process, so two replicas both run the same due schedule and send duplicate
notifications and history. `RULEBEAT_DISABLE_SCHEDULER=1` on every replica but one avoids that,
but it is a manual workaround rather than a high-availability story. Multi-replica support with
real coordination is on the roadmap, not built.

## Local development

For contributing to RuleBeat itself, or running it outside Docker:

```bash
npm install
npm run build:core      # build packages/core before running or typechecking web
npm run dev             # http://localhost:3000
npm test                # everything, both packages
npm run typecheck       # typecheck both packages, from the repo root
```

Copy `.env.example` to `packages/web/.env.local` and fill in values. Run `az login` for local Azure
access: outside a container, `DefaultAzureCredential` falls back to your own CLI session.
`packages/web` imports `@rulebeat/core` from its compiled output rather than its source, so
`npm run build:core` has to re-run after a core change before `npm run dev` or a typecheck sees it.
