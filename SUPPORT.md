# Support

RuleBeat is self-hosted and community-supported. RuleBeat is open source (Apache-2.0) and free,
permanently. Paid expertise (install help, custom rules, support) is available separately; the
software itself is never what is sold.

## Before asking

1. [`docs/public/troubleshooting.md`](docs/public/troubleshooting.md) covers the most common
   self-host issues, and [`docs/public/README.md`](docs/public/README.md) indexes every other page.
2. The admin-only `/diagnostics` page (linked from Settings → Azure connection, once signed in)
   checks Azure connectivity, scheduler liveness, and schema-cache health directly against your own
   install, often faster than describing the symptom to someone else.
3. [Existing issues](https://github.com/rulebeat/rulebeat/issues): someone may have already hit
   the same thing.

## Getting help

- **Bug or something not working as documented:**
  [open an issue](https://github.com/rulebeat/rulebeat/issues). Include what you expected, what
  happened instead, your RuleBeat version (Diagnostics → System), and the relevant lines from
  `docker compose logs` if it's a self-host problem.
- **Question about configuration, rules, or how something works:**
  [open a discussion or issue](https://github.com/rulebeat/rulebeat/issues). There's no separate
  chat or forum today.
- **Security vulnerability:** don't open a public issue. See [`SECURITY.md`](SECURITY.md) for how
  to report privately.
- **Something else entirely** (partnership, paid engagement, press): see the contact listed on
  rulebeat.com.

## What to expect

This is a solo-maintained open-source project in public beta. Response time varies. There's no SLA.
If you need guaranteed response times or hands-on help standing up a deployment, that's the kind of
paid engagement described above, not something the free issue tracker commits to.
