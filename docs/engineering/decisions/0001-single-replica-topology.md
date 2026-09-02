# ADR 0001: Single-replica topology, multi-replica deferred

Status: accepted, 2026-09-02.

## Decision

RuleBeat supports exactly one running instance. SQLite mode is single-instance by construction:
the database lives on local disk and the container refuses a network file share. Postgres mode is
stateless and restartable, but still one instance, because scheduling, startup recovery and manual
"Run now" are coordinated in process memory (`packages/web/lib/scheduler.ts`'s `busy` flag and
tick, `packages/web/lib/startup-recovery.ts`).

We will not add a worker tier, leader election or an external queue until one of the triggers
below is met. Option D in the assessment, an external queue such as Service Bus or Redis, is
rejected outright: it adds an operated dependency, contradicts the single-container install
positioning, and does not remove at-least-once semantics anyway.

## Context

Scans are batch jobs on a schedule and the console is opened a few times a day. A container
restart costs roughly a minute of console downtime and delays one scan by that plus at most one
30-second tick; `next_run_at` is only advanced after a run completes, so an interrupted run is
re-run late, not missed. Nothing in a customer's workflow blocks on RuleBeat being up at a given
second, and it never gates a deployment by design. Throughput is bounded by Azure Resource Graph
and Microsoft Graph quota per tenant, which extra workers would share, so more processes buy far
less than they appear to.

The failure that actually hurts is a silent crash-loop that stops scans for days. That is a
monitoring problem, and a "no successful run in X" signal is cheaper and more valuable than any
replica work. It comes first.

The one multi-instance situation users reach without asking for it is a rolling deploy: on Azure
Container Apps, Kubernetes, or Compose with a healthcheck, the old and new container overlap for
up to a minute. Today that overlap runs the same due schedule twice, sends duplicate
notifications, and lets the new container's startup recovery mark the old container's live run as
crashed. That is fixed by small atomic claims (conditional `UPDATE`s on `next_run_at` and
`notify_status`, a heartbeat on `schedule_runs`, an advisory lock around Postgres bootstrap), not
by a topology change. Those claims are tracked as their own issue and are the primitives any later
lease-based design would reuse, so nothing is thrown away.

## If a trigger fires

The chosen design is identical replicas with one lease row deciding which instance runs the
scheduler tick and startup recovery, renewed each tick and expiring after about 90 seconds, with
manual runs inserted as queued rows the leader picks up. A `leases` table with a conditional
`UPDATE` works on SQLite and Postgres alike; Postgres advisory locks would be an optimisation, not
the primitive. Multi-instance stays Postgres-only. Per-category job claiming across replicas comes
after that, and only if scan wall time demands it. All of it is at-least-once with idempotent
effects; exactly-once is never promised.

## Triggers to revisit, any one of

- Two or more customer or design-partner requests citing an availability requirement for scans,
  or a security questionnaire failing on "single point of failure".
- Azure Container Apps or Kubernetes becomes a documented install target with a Helm chart or
  Bicep module, and that request appears at least twice in issues or Discord.
- A duplicate scheduled run is reported from the field after the overlap-safety claims ship.
- Postgres installs are a visible share of adoption rather than the exception.
- A tenant's full scan wall time exceeds half of its shortest schedule interval. That is a
  throughput trigger and points at in-process category parallelism first.

## Consequences

- `docs/public/install.md`, `configure.md` and `faq.md` keep stating one replica as the supported
  shape, and the Container Apps guidance says to keep min and max replicas at 1 in single-revision
  mode until the overlap-safety claims ship.
- Any new coordination write is one conditional `UPDATE` (or `BEGIN IMMEDIATE` on SQLite), never
  read-then-write, and never relies on the in-process `busy` flag.
- "Single container install" remains a claim the product can keep making.
