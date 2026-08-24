# Notifications

This page answers: how do I get told about new findings, through which channels, with what payload,
and what RuleBeat does when a delivery fails. The short version: channels are an address book,
schedules decide who gets notified about what, only *new* findings from *scheduled* runs are sent,
and every attempt is recorded.

## The model

1. **Channels** live under Settings → Notifications: a name, a type and a destination. A channel
   knows nothing about schedules or severities; it is an address.
2. **Schedules** pick channels. When editing a schedule, choose which channels should notify for it,
   the minimum severity that should trigger one, and optionally which categories and subscriptions
   that channel should hear about from this schedule. The same channel can serve several schedules
   at different thresholds and scopes.
3. **A scheduled run finishes**, its findings are synced, and RuleBeat computes which findings are
   *new* in that run (first seen now, not "still there"). For each assigned channel it applies that
   assignment's category and subscription scope first, then its minimum severity, and sends one
   message per channel if anything is left.

Manual runs never notify, whatever they cover. A run that produced no new findings sends nothing.
A finding that was already active does not get re-sent on the next run.

## Channel types

<!-- count:channel-types -->Four types:

![Settings, the new channel form with a name, a type dropdown and a destination URL](img/settings-notifications.png)

### Microsoft Teams

Teams no longer accepts the old Office 365 connector webhooks; RuleBeat posts an Adaptive Card to a
**Power Automate Workflow** URL. In the Teams channel, open Workflows and use the template "Post to
a channel when a webhook request is received"; the workflow gives you an HTTPS URL ending in a
signature. Paste that as the channel's destination.

The message is an Adaptive Card (schema 1.5) titled "RuleBeat: N new finding(s)", a summary line
by severity ("2 critical, 5 high"), a table of the top five findings (severity, title, resource),
"... and N more." when there are more, and an "Open in RuleBeat" button that lands on the Scans
page filtered to new findings.

### Slack

Create an Incoming Webhook in your Slack app and paste its URL. The message is Block Kit: a header
"RuleBeat: N new finding(s)", the severity summary, one section per finding for the top five, and a
"View findings" button.

### Generic webhook

Any HTTPS endpoint that accepts JSON. RuleBeat POSTs `application/json` with this stable shape:

```json
{
  "event": "scan.new_findings",
  "runId": "…",
  "triggeredBy": "schedule",
  "counts": { "critical": 1, "high": 3 },
  "totalNewFindings": 4,
  "findings": [
    {
      "fingerprint": "…",
      "title": "Storage Account Allows HTTP Traffic",
      "severity": "medium",
      "category": "security",
      "resourceId": "/subscriptions/…/providers/Microsoft.Storage/storageAccounts/…",
      "resourceName": "stportal8rganalyticsprod",
      "subscriptionId": "…"
    }
  ],
  "scansUrl": "https://rulebeat.example.com/scans?…"
}
```

`findings` carries at most the first 20; `totalNewFindings` is the real count. `counts` has a key
only for severities that occurred. This is the payload to point an Azure Logic App, a ticketing
webhook, or your own function at.

### Email

SMTP, configured on the channel: host, port, TLS mode (none, STARTTLS, or implicit TLS), username,
password, from address, and one or more recipient addresses separated by commas. The password is
stored encrypted like a webhook URL. The message is plain text with the subject "RuleBeat: N new
finding(s)", the summary line, the top ten findings (severity, title, resource, category), and a
link into RuleBeat. There is no HTML variant.

## Scope and severity

- **Scope** (categories, subscriptions): set where the channel is assigned to the schedule. A
  security-team channel assigned with the security category only never hears about a cost finding
  from that schedule. Empty scope means everything the schedule covers.
- **Minimum severity**: set in the same place. Findings below it are dropped for that channel on
  that schedule only.

Both filters apply to the new findings of that run. Neither changes what the scan records; the
findings are all still on the Scans page.

## Links in messages

Every message links back into RuleBeat at `<public URL>/scans`, filtered to new findings over the
last seven days. The public URL is the one under Settings → Sign-in (or `AUTH_URL` in the
environment); if it is wrong, the links will be wrong, so set it before wiring channels. See
[`configure.md`](configure.md).

## Test send

Settings → Notifications has a test action per channel that sends one sample finding ("Test finding
from RuleBeat") through the real delivery path, to a saved channel or to the values in the form
before you save. It needs the admin role (`notifications:manage`), same as editing channels.

## Retries and delivery history

Webhook-type channels (Teams, Slack, generic) get up to **three attempts** with waits of 2 seconds
and then 8 seconds between them. An attempt times out after 10 seconds. A network error, a timeout,
an HTTP 429 or any 5xx is retried; any other 4xx is **not**, because a rejected request repeated is
the same rejection. Email is a single attempt.

Every attempt sequence, success or failure, is recorded per channel with its status and the
response detail, and is viewable from Settings → Notifications. The history keeps the most recent
50 entries per channel and prunes the rest. A notification that did not arrive is something you can
look up, not something you have to guess about.

## Where a destination is allowed to point

Before any webhook request, RuleBeat resolves the destination hostname and refuses to send if it
points anywhere private: loopback, RFC 1918 ranges, link-local (including the cloud metadata
address 169.254.169.254), carrier-grade NAT, reserved and multicast ranges, and their IPv6
equivalents, plus any scheme other than `http` or `https`. DNS resolution has a five-second limit
and every returned address must be public. Redirects are not followed; a destination that answers
with a redirect is treated as a refusal and is not retried. This is a guard against the server
being used to probe its own network, and it applies to test sends as well as real ones. A corporate
webhook receiver on a private address is therefore not reachable by design; put it behind a public
hostname or use email.

## What happens across a restart

Sending is an outbox, not a fire-and-forget. A run records that it has notifications pending, the
dispatch happens, and the run is marked sent. If the process restarts in between, startup recovery
finds runs with pending notifications and dispatches them, and marks any run that was still
"running" when the process died as an error ("Run did not complete. The server restarted or
crashed while this scan was in progress."). So a restart delays a notification; it does not lose
it, and it does not produce a silently half-finished run.

## What is not here

- No digest or batching across runs: one message per channel per run.
- No mute windows or quiet hours.
- No per-rule routing; scope is by category and subscription.
- No HTML email.
- Notifications are about new findings only: a fixed finding, a failed run or a stale schedule does
  not send anything today. The Scan Coverage dashboard widget is where a stopped schedule shows.
