# What's next

This page answers: what is RuleBeat not doing yet that you might expect it to, and what is the
state of each item. No dates. Anything listed here is absent from the product today; nothing on
the other pages describes a feature that is only planned.

| Item | Status | What you get today instead |
|---|---|---|
| **Logs & activity rules** (a third kind of check, over Log Analytics: sign-in and activity logs, diagnostic data, anything a KQL query against a workspace can count) | Designed, in build. The "What does this rule check?" picker already shows the option as not yet available. | Resource configuration rules (Resource Graph) and Directory rules (Microsoft Graph). |
| **Generated fix steps** on a finding, derived from the rule's own detection logic, for custom rules as much as built-in ones | Not started. A finding shows "Guided fix coming soon" where they will go. | The rule's recommendation text, a portal link to the resource, and for APRL pack rules a "Read the official guidance" link to Microsoft's page. Fix steps, when they arrive, will be steps you run; RuleBeat will not execute them. |
| **Hosted demo** at a public URL | Not done. | Demo mode on your own machine or container: [`demo-mode.md`](demo-mode.md). |
| **Community rules**: a way to share and pull in rules others wrote | Not started. The `community` rule type exists in the data model and nothing populates it. | Built-in rules, the APRL pack, and rules you write or duplicate. |
| **Rule import and export** (bundles, versioning, a published JSON schema for rules) | Not started. | Findings export to CSV and JSON; the audit log exports to CSV. Rules are edited in the product. |
| **More than one replica** against one database | Not supported; one container, one volume, one scheduler. | Vertical scaling. A second replica with `RULEBEAT_DISABLE_SCHEDULER=1` avoids double-firing but is not a tested configuration. |
| **Azure Government and Azure China** | Not supported; public cloud endpoints only. | Azure public cloud. |
| **Entra group to role mapping**, custom roles, scoped roles | Later. A `scope` column is reserved and unused. | Three roles (viewer, editor, admin) assigned per user in RuleBeat: [`rbac.md`](rbac.md). |
| **Notification mute windows**, digests across runs, per-rule routing | Later. | One message per channel per scheduled run, filtered by severity, category and subscription: [`notifications.md`](notifications.md). |
| **Directory rules beyond one collection**: joins across object types, relationship filters, Graph paths outside the allowlisted seven | Not planned as such; adding an object type is a code change. | The <!-- count:graph-resource-types -->seven object types and OData `$filter`: [`directory-rules.md`](directory-rules.md). |

If something you need is missing from this list,
[open an issue](https://github.com/rulebeat/rulebeat/issues); the list is meant to be the whole
honest answer, not a teaser.
