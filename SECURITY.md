# Security

RuleBeat is a read-only tool: it only ever issues read calls to Azure, never creates its own
service principal, and never assigns itself a role. See
[`docs/public/security.md`](docs/public/security.md) for the full detail of what RuleBeat reads,
what it stores, and what it never does.

## Reporting a vulnerability

If you find a security issue in RuleBeat, please report it privately rather than opening a public
GitHub issue: email **security@rulebeat.com** with a description of the issue and, if you can,
steps to reproduce it.

You should expect an acknowledgment within a few days. RuleBeat is currently maintained by one
person, so please be patient with response time; a fix will be prioritized based on severity and
you'll be credited (if you'd like) once it ships.

Please don't test against anyone else's live deployment, and don't access or modify data that
isn't yours while investigating an issue.

## Supported versions

RuleBeat is in public beta and does not yet have a formal versioned release schedule. Security
fixes land on the `main` branch and are the version you get by pulling the latest image or
container build.
