# Azure permissions guide

RuleBeat reads your Azure tenant with a service principal that **you** create. It never creates one
itself, never assigns itself roles, and never requests write access. That is a design principle, not
a launch shortcut: a governance tool that could escalate its own privileges would be a bigger risk
than the misconfigurations it exists to catch.

Four steps, in order. Steps 1 and 2 are required; without them RuleBeat can authenticate but see
nothing. Steps 3 and 4 are optional and independent of each other, so skipping either leaves
everything else working normally.

**Supported environment:** Azure public cloud only. Resource Graph, Microsoft Graph and Entra ID
endpoints are fixed to their public-cloud hosts (`management.azure.com`, `graph.microsoft.com`,
`login.microsoftonline.com`), and generated portal links point at `portal.azure.com`. Azure
Government and Azure China are not supported yet;
[open an issue](https://github.com/rulebeat/rulebeat/issues) if that is blocking you.

## 1. Create the service principal

The same line works in bash, zsh and PowerShell; replace `<subscription-id>` first.

```
az ad sp create-for-rbac --name "RuleBeat" --role Reader --scopes /subscriptions/<subscription-id>
```

It prints:

```json
{
  "appId": "11111111-2222-3333-4444-555555555555",
  "displayName": "RuleBeat",
  "password": "<shown once, copy it now>",
  "tenant": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
}
```

`appId`, `password` and `tenant` are the **client ID**, **client secret** and **tenant ID** RuleBeat
asks for in Settings → Azure connection (or `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` /
`AZURE_TENANT_ID` for an unattended deployment). The password is shown once. To cover several
subscriptions in one command, repeat `--scopes`, or grant at a management group below.

In the Portal instead: **Microsoft Entra ID** → **App registrations** → **New registration**, name
it, leave single-tenant, register. On **Certificates & secrets** create a client secret and copy the
**Value** column immediately, not the Secret ID, which is a different string and will not
authenticate. Take the **Application (client) ID** and **Directory (tenant) ID** from Overview.

## 2. Grant Reader

Reader is the only role RuleBeat ever needs. Assign it wherever you want visibility: one
subscription for a pilot, or a management group to cover many at once. Both lines work in bash, zsh
and PowerShell.

```
# On a subscription
az role assignment create --assignee <client-id> --role Reader --scope /subscriptions/<subscription-id>

# On a management group
az role assignment create --assignee <client-id> --role Reader --scope /providers/Microsoft.Management/managementGroups/<management-group-id>
```

In the Portal: the subscription or management group → **Access control (IAM)** → **Add role
assignment** → role **Reader**, assign access to **User, group, or service principal**, select the
app registration. Repeat per scope.

RuleBeat's scope is exactly what Azure RBAC grants. Narrow it later by removing the assignment; no
setting inside RuleBeat controls it.

## 3. Optional: Microsoft Graph for Directory rules

Directory rules read Microsoft Graph directly instead of Azure Resource Graph, for checks about the
directory itself. `Application.Read.All` is a tenant-wide application permission, not scoped by
subscription RBAC the way Reader is, so grant it deliberately. RuleBeat's two built-in identity
checks (expiring app secrets and certificates) are Directory rules and need exactly this permission.
Nothing else in RuleBeat depends on it.

A Directory rule can read one of <!-- count:graph-resource-types -->seven object types.
`Application.Read.All` covers applications and service principals only; any other type needs its own
matching Graph read permission on the same identity, and without it that rule alone fails and is
reported as such. See [`directory-rules.md`](directory-rules.md) for the per-type table.

Microsoft Graph's application ID (`00000003-0000-0000-c000-000000000000`) and
`Application.Read.All`'s app-role ID (`9a5d68dd-52b0-4cc2-bd40-abcf44112121`) are fixed, so these
commands are the same for every tenant.

bash or zsh:

```bash
az ad app permission add --id <client-id> \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 9a5d68dd-52b0-4cc2-bd40-abcf44112121=Role

az ad app permission admin-consent --id <client-id>
```

PowerShell:

```powershell
az ad app permission add --id <client-id> `
  --api 00000003-0000-0000-c000-000000000000 `
  --api-permissions 9a5d68dd-52b0-4cc2-bd40-abcf44112121=Role

az ad app permission admin-consent --id <client-id>
```

In the Portal: the app registration → **API permissions** → **Add a permission** → **Microsoft
Graph** → **Application permissions** → `Application.Read.All`, then **Grant admin consent**. An
Application Administrator or Global Administrator must do that last step; adding the permission
alone is not enough. `Application.Read.All` is read-only: it lists app registrations and service
principals including credential expiry, and grants no ability to change anything.

## 4. Optional: Log Analytics Reader

RuleBeat can query a Log Analytics workspace once one is connected in Settings → Log Analytics
workspace. There is no separate identity: the same service principal queries it, so it needs one
more role assignment, scoped to the workspace resource rather than the subscription.

bash or zsh:

```bash
az role assignment create --assignee <client-id> --role "Log Analytics Reader" \
  --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.OperationalInsights/workspaces/<workspace-name>
```

PowerShell:

```powershell
az role assignment create --assignee <client-id> --role "Log Analytics Reader" `
  --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.OperationalInsights/workspaces/<workspace-name>
```

In the Portal: the workspace → **Access control (IAM)** → **Add role assignment** → role **Log
Analytics Reader**, selecting the same app registration. Without the role RuleBeat still
authenticates, but saving the workspace fails: it is verified with a real query before it is
persisted, and that query is refused until the role is granted.

## Verifying it worked

The onboarding wizard's step 2 and the admin-only Diagnostics page run the same four checks on
demand: the credential authenticates, it sees at least one subscription, Resource Graph answers a
query, and whether Microsoft Graph is reachable with the permission above. A Log Analytics workspace
is verified separately, at the moment you save it. Run the checks after each step rather than
guessing. See [`troubleshooting.md`](troubleshooting.md).
