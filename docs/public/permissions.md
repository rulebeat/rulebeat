# Azure permissions guide

RuleBeat reads your Azure tenant with a service principal that you create. RuleBeat never creates
this service principal itself, never assigns itself roles, and never requests write access. That's
a design principle, not a launch shortcut: a governance tool that could escalate its own privileges
would be a bigger risk than the misconfigurations it's meant to catch.

This page covers the four things that credential needs, in order:

1. Create the service principal (app registration).
2. Grant it **Reader** on the subscriptions or management groups you want scanned.
3. Optionally, grant it Microsoft Graph **`Application.Read.All`** for Directory rules, checks about
   the directory itself rather than Azure resources, including the two built-in identity checks.
4. Optionally, grant it **Log Analytics Reader** on a workspace if you connect one in Settings.

Steps 1 and 2 are required. Without them RuleBeat can authenticate but see nothing. Steps 3 and 4
are independent of each other and of step 2: skip either and everything else still works normally.

**Supported environment:** RuleBeat targets Azure public cloud only. Resource Graph, Microsoft
Graph, and Entra ID endpoints are fixed to their public-cloud hosts (`management.azure.com`,
`graph.microsoft.com`, `login.microsoftonline.com`), and generated portal links point at
`portal.azure.com`. Azure Government and Azure China aren't supported yet; [open an
issue](https://github.com/rulebeat/rulebeat/issues) if that's blocking you.

---

## 1. Create the service principal

### CLI

The same line works in bash, zsh and PowerShell; replace `<subscription-id>` first.

```
az ad sp create-for-rbac --name "RuleBeat" --role Reader --scopes /subscriptions/<subscription-id>
```

It prints something like:

```json
{
  "appId": "11111111-2222-3333-4444-555555555555",
  "displayName": "RuleBeat",
  "password": "<shown once, copy it now>",
  "tenant": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
}
```

`appId`, `password` and `tenant` are the **client ID**, **client secret** and **tenant ID**
RuleBeat asks for in Settings → Azure connection (or the `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`
/ `AZURE_TENANT_ID` environment variables, for an unattended deployment). The password is shown
once, so copy it immediately.

To scope Reader across several subscriptions in one command, repeat `--scopes`, or grant it at a
management group instead (see below).

### Portal

1. **Microsoft Entra ID** → **App registrations** → **New registration**. Name it (for example
   "RuleBeat"), leave the default single-tenant option, and register.
2. On the app's **Certificates & secrets** page, create a new client secret. Copy the **Value**
   column immediately; it is not shown again. (Not the Secret ID, which is a different string and
   won't authenticate.)
3. Note the **Application (client) ID** and **Directory (tenant) ID** from the app's Overview page.

## 2. Grant Reader

Reader is the only role RuleBeat ever needs. Assign it wherever you want visibility: a single
subscription for a pilot, or a management group to cover many subscriptions at once.

### CLI

Both lines work in bash, zsh and PowerShell.

```
# On a subscription
az role assignment create --assignee <client-id> --role Reader --scope /subscriptions/<subscription-id>

# On a management group
az role assignment create --assignee <client-id> --role Reader --scope /providers/Microsoft.Management/managementGroups/<management-group-id>
```

### Portal

1. Go to the subscription (or management group) → **Access control (IAM)** → **Add role
   assignment**.
2. Role: **Reader**. Assign access to: **User, group, or service principal**. Select the app
   registration you created above.
3. Repeat for every subscription or management group you want scanned.

RuleBeat's own scope is exactly what Azure RBAC grants. Narrow it later by removing the assignment;
no setting inside RuleBeat controls it.

## 3. Optional: Microsoft Graph for Directory rules

Some checks aren't about Azure resources at all. They're about the directory itself: app
registrations, service principals, and (with the right permission) users, groups, devices, and
more. RuleBeat runs these as Directory rules, reading Microsoft Graph directly instead of Azure
Resource Graph. `Application.Read.All` is a tenant-wide application permission, not scoped by Azure
subscription RBAC the way Reader is, so grant it deliberately. RuleBeat's two built-in identity
checks (expiring app secrets and certificates) are Directory rules themselves, not a special case,
and they need exactly this permission. Skip this section if you don't need those checks yet.
Nothing else in RuleBeat depends on it.

A Directory rule can read one of <!-- count:graph-resource-types -->seven object types: users, groups, applications, service
principals, directory roles, devices, and administrative units. `Application.Read.All` covers
applications and service principals only. A rule against any other type returns data only if the
same identity also holds the matching Microsoft Graph read permission for that type (for example
the user and group read permissions for users and groups); without it, that rule fails for that
object type and is reported as such in the run, and every other rule is unaffected. See
[`directory-rules.md`](directory-rules.md) for which permission each type needs.

### CLI

Microsoft Graph's application ID is fixed (`00000003-0000-0000-c000-000000000000`), and so is
`Application.Read.All`'s app-role ID (`9a5d68dd-52b0-4cc2-bd40-abcf44112121`), so these commands
are the same for every tenant.

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

### Portal

1. On the app registration, go to **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Application permissions**.
2. Search for and select **`Application.Read.All`**.
3. Click **Grant admin consent**. An Application Administrator or Global Administrator must do this
   step; adding the permission alone is not enough.

`Application.Read.All` is read-only. It lets RuleBeat list app registrations and service
principals, including their credential expiry. It grants no ability to change anything.

## 4. Optional: Log Analytics Reader for Log Analytics rules

RuleBeat can also query a Log Analytics workspace, once one is connected in Settings → Log
Analytics workspace. There's no separate identity for this: the same service principal from step 1
does the querying, so it needs one more role assignment, scoped to the workspace resource itself
rather than the subscription. Skip this section if you don't plan to connect a workspace yet;
nothing else in RuleBeat depends on it.

### CLI

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

### Portal

1. Go to the Log Analytics workspace resource → **Access control (IAM)** → **Add role
   assignment**.
2. Role: **Log Analytics Reader**. Assign access to: **User, group, or service principal**. Select
   the same app registration you created above.

Without this role, RuleBeat can still authenticate, but saving the workspace in Settings fails:
the workspace is verified with a real query before it's persisted, and that query is refused until
the role is granted.

---

## Verifying it worked

RuleBeat's onboarding wizard (step 2) runs a preflight, and the admin-only Diagnostics page
(linked from Settings → Azure connection as **View diagnostics**) runs the same four checks on
demand: that the credential authenticates, that it can see at least one subscription, that Azure
Resource Graph answers a query, and whether Microsoft Graph is reachable with the permission
above. A Log Analytics workspace is verified separately, at the moment you save it in Settings
(step 4 above). Run the checks after each step rather than guessing. See
[`troubleshooting.md`](troubleshooting.md).
