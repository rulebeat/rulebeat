# Troubleshooting

![Diagnostics page showing Azure connectivity checks](img/diagnostics.png)

## Start with the diagnostics page

`/diagnostics` (admin-only, linked from Settings) answers the questions that would otherwise need
a server log, on two cards: **Azure connectivity** (is Azure reachable) and **System** (which
version is running, is the background scheduler ticking, and is the resource-type schema cache
healthy).

### The Azure connectivity card

These checks run only when you click Run, not automatically on page load, since they make live
calls and can take a few seconds. The last result is kept so it survives a page refresh. Four
checks, in order, since a later check can only fail meaningfully if the ones before it pass:

1. **Azure credential.** Can RuleBeat get a token at all? A failure here means the credential
   itself is wrong. See [`configure.md`](configure.md) for the five ways to supply one, and
   [`permissions.md`](permissions.md) for creating a service principal from scratch.
2. **Subscription access.** How many subscriptions can this identity see? Zero means Reader isn't
   assigned anywhere this credential can reach.
3. **Resource Graph.** Can RuleBeat actually query Azure Resource Graph, and does the subscription
   count it returns match what the previous check found? A mismatch usually means Reader is
   assigned somewhere Resource Graph hasn't indexed yet, which can lag a fresh role assignment by a
   few minutes.
4. **Microsoft Graph (Directory rules).** Optional. A warning here (not a failure) means Directory
   rules, including the two built-in identity checks, will be skipped; everything else still works
   normally. Grant `Application.Read.All` (see [`permissions.md`](permissions.md)) to fix it.

Every check's summary is a hand-written, plain-language sentence. The real underlying error, which
can contain tenant IDs and correlation IDs you wouldn't want in a screenshot, always goes to the
server log first.

### The System card

Local state, no Azure calls, so it loads on its own when the page opens. The card's title carries
the running version (the same one the sidebar footer shows), which is what to quote in a bug
report and what to compare against the
[releases page](https://github.com/rulebeat/rulebeat/releases) when deciding whether to upgrade.
Two rows below it:

- **Scheduled scans.** Whether the background scheduler is enabled and when it was last active. It
  ticks every 30 seconds when running; if the last activity time is stale, the process may need a
  restart. "Disabled at the server level" means `RULEBEAT_DISABLE_SCHEDULER` is set, which is the
  expected state if you set it deliberately. The one reason to set it today is running more than
  one replica, which isn't a supported topology; see
  [`install.md`](install.md#deployment-topology) for why.
- **Azure resource schemas.** Whether resource-type schemas (used by the rule builder to know what
  fields exist on a given resource type) are cached and how fresh the cache is. A stale individual
  entry is normal and self-heals on next use; the only state worth acting on is nothing cached at
  all, or the overall type list being outdated, and the card says what resolves each.

## Common issues

**Stuck on the sign-in page after entering credentials.** Confirm `AUTH_URL` (if set) matches how
you're actually accessing the instance, including scheme and port. A mismatch between the
configured URL and the request's actual origin is the most common cause of a sign-in that appears
to succeed but loops back.

**A fresh Docker install won't build or start.** Check `docker compose logs` first; most first-boot
failures show a clear error there. (The generated admin password is not in that log; it's written
only to `data/initial-password.txt` in the data volume; see [install.md](install.md#first-sign-in).)
Then ask Docker what its own liveness check (`/api/health`, unauthenticated) sees:

```
docker inspect rulebeat --format '{{.State.Health.Status}}'
```

It prints one of `starting`, `healthy`, or `unhealthy`. `starting` for the first few seconds is
normal; stuck on `starting` or flipped to `unhealthy` means the app process itself isn't answering
HTTP, which points at the log rather than at Azure. The install examples set
`--restart unless-stopped` (or `restart: unless-stopped` in Compose), so a crash recovers on its
own; `RestartCount` climbing in `docker inspect` without settling means it's crash looping, and
the log from just before each restart is where to look.

**A schedule shows as due but never seems to run.** Check the System card's Scheduled scans row
above.
Also confirm no other manual or scheduled run is currently in progress: RuleBeat runs are
serialized, so a long-running scan delays the next one rather than running it concurrently.

**A notification channel isn't firing.** Check its delivery history from Settings →
Notifications. A channel's assigned severity threshold on the specific schedule that should be
notifying is a common cause of "it's configured but nothing arrives": the schedule has to be
explicitly assigned to that channel.

## Logs

RuleBeat logs to stdout, so `docker compose logs -f` (or your platform's log viewer) is where
startup errors and scan failures show up (the generated admin password never is; see above). RuleBeat never
returns a raw internal error to the browser; it logs the real error server-side and returns a
stable, safe message instead. If something in the UI shows a generic error message, the log is
where the specific cause is.
