# Advisory sources: primary-source research

This note covers sources for planned advisory rules. An advisory rule produces informational results
that do not count against posture. Every claim below cites a Microsoft-owned page: Microsoft Learn,
an official REST or Graph reference, or a Microsoft GitHub repository. Anything not confirmed by a
primary source is labelled as an inference or listed under "Open questions / could not confirm".

## Summary

| Source | How RuleBeat reads it | Permission | Stable key | Tenant-specific or global | Backend fit |
|---|---|---|---|---|---|
| Advisor recommendations (`advisorresources`, `microsoft.advisor/recommendations`) | Resource Graph KQL | Reader on the subscription, resource group or resource (`Microsoft.Advisor/recommendations/read`) | `name` (recommendation GUID), or `properties.recommendationTypeId` plus `properties.resourceMetadata.resourceId` | Tenant-specific, per subscription | Existing Resource Graph backend |
| Advisor service retirements (same table, subcategory `ServiceUpgradeAndRetirement`) | Resource Graph KQL; optionally the Advisor metadata REST endpoint for the retirement catalogue | Reader, as above; metadata needs `Microsoft.Advisor/metadata/read` | Same as Advisor recommendations. The retirement type is `recommendationTypeId`, which matches the metadata `supportedValues[].id` | Recommendations are per subscription; the metadata catalogue is provider-level and appears to be global | Existing Resource Graph backend. The metadata catalogue would need a new ARM REST backend |
| Service Health events (`servicehealthresources`, `microsoft.resourcehealth/events`) | Resource Graph KQL | Reader on the subscription | `properties.TrackingId` plus `subscriptionId` (the row `id` already combines both) | Tenant-specific, per subscription. Tenant-level events are not in Resource Graph | Existing Resource Graph backend |
| Service Health impacted resources (`microsoft.resourcehealth/events/impactedresources`) | Resource Graph KQL | Reader on the subscription | Tracking id plus `properties.targetResourceId` | Tenant-specific, per subscription | Existing Resource Graph backend |
| Resource Health events REST (`Microsoft.ResourceHealth/events`) | ARM REST | Reader for subscription events; a tenant admin role for tenant-level events | `name` (the tracking id) | Tenant-specific | New ARM REST backend. Only needed for tenant-level events, which Resource Graph cannot return |
| Azure Updates RSS | Unauthenticated HTTP fetch of an RSS 2.0 feed | None | `guid` (numeric, `isPermaLink="false"`). Stability is not documented | Global, the same for every tenant | New backend (HTTP or RSS), with no credential |
| Microsoft 365 Message center (Graph `serviceAnnouncement/messages`) | Microsoft Graph | `ServiceMessage.Read.All`, application, admin consent | `id` (for example `MC` followed by digits) | Tenant-specific | Existing Microsoft Graph backend; needs a new permission |
| Microsoft 365 service health issues (Graph `serviceAnnouncement/issues`) | Microsoft Graph | `ServiceHealth.Read.All`, application, admin consent | `id` (for example `EX` followed by digits) | Tenant-specific | Existing Microsoft Graph backend; needs a new permission |
| Microsoft 365 service health overviews (Graph `serviceAnnouncement/healthOverviews`) | Microsoft Graph | `ServiceHealth.Read.All`, application, admin consent | `id` (the service name, for example `Exchange`) | Tenant-specific | Existing Microsoft Graph backend; needs a new permission |

A note on keys for RuleBeat: findings are keyed by `sha256(ruleId::resourceId)`. Advisor rows carry
a real ARM resource id. Service Health events, Azure Updates items and Graph messages and issues do
not describe a resource, so a rule over them needs a key field that plays the role
`dimensionKeyField` plays for Logs rules. The candidates for that field are the keys in the table.

## 1. The `advisorresources` table

### Row types

The Resource Graph supported-tables reference lists these types under `advisorresources`:
`microsoft.advisor/assessments`, `microsoft.advisor/configurations`,
`microsoft.advisor/recommendations`, `microsoft.advisor/recommendations/suppressions`,
`microsoft.advisor/resiliencyreviews`, `microsoft.advisor/suppressions`,
`microsoft.advisor/triagerecommendations` and `microsoft.advisor/triageresources`
([Resource Graph supported tables](https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources)).

The Advisor Resource Graph page also names `microsoft.advisor/advisorscore` and
`microsoft.advisor/metadata`. Metadata rows carry `properties.language`,
`properties.recommendationTypeId`, `properties.recommendationCategory`,
`properties.recommendationImpact`, `properties.label`, `properties.recommendationSubCategory` and
`properties.supportedResourceType`
([Advisor and Azure Resource Graph](https://learn.microsoft.com/en-us/azure/advisor/advisor-azure-resource-graph)).
These two types are not in the supported-tables reference, so the two pages disagree. See the open
questions.

### Shape of a recommendation row

The REST schema `ResourceRecommendationBase` (api-version 2025-01-01) describes a recommendation
([Recommendations - Get](https://learn.microsoft.com/en-us/rest/api/advisor/recommendations/get)):

- `id` is an ARM id of the form
  `{resourceUri}/providers/Microsoft.Advisor/recommendations/{recommendationId}`, and `name` is the
  recommendation GUID.
- `properties.category` is one of `HighAvailability`, `Security`, `Performance`, `Cost` or
  `OperationalExcellence`.
- `properties.control` is one of `HighAvailability`, `BusinessContinuity`, `DisasterRecovery`,
  `Scalability`, `MonitoringAndAlerting`, `ServiceUpgradeAndRetirement`, `Other`,
  `PrioritizedRecommendations` or `Personalized`.
- `properties.impact` is `High`, `Medium` or `Low`. `properties.risk` is `Error`, `Warning` or
  `None`.
- `properties.impactedField` is documented as "The resource type identified by Advisor", and
  `properties.impactedValue` is the resource identified by Advisor.
- `properties.lastUpdated` is "The most recent time that Advisor checked the validity of the
  recommendation".
- `properties.recommendationTypeId` is the recommendation-type GUID.
- `properties.resourceMetadata` holds `resourceId`, `source`, `singular`, `plural` and `action`.
- `properties.shortDescription` holds `problem` and `solution`.
- The remaining properties are `extendedProperties`, `suppressionIds`, `label`, `learnMoreLink`,
  `potentialBenefits`, `description` and `actions`.

The Advisor Resource Graph page adds consolidated state fields
([Advisor and Azure Resource Graph](https://learn.microsoft.com/en-us/azure/advisor/advisor-azure-resource-graph)):

- `properties.recommendationStatus`, with values `New`, `InProgress`, `Completed`, `Postponed` and
  `Dismissed`. The page calls it the single source of truth for status.
- `properties.completionType`, either `MarkedByUser` or `SystemVerified`.
- `properties.lastUpdated`.
- A warning that `customerState` and `platformState` may change and should not be relied on.
- A note that the `Completed` state for security recommendations in Resource Graph may not reflect
  current status, and that Defender for Cloud should be checked instead.

The sample queries on that page project `stableId = name`, filter on `properties.tracked`, and read
`properties.resourceMetadata.resourceId` and `properties.extendedProperties` values such as
`annualSavingsAmount`, `savingsCurrency` and `MaxCpuP95`
([Advisor and Azure Resource Graph](https://learn.microsoft.com/en-us/azure/advisor/advisor-azure-resource-graph)).

### Scoping to a subscription

Each row carries the standard Resource Graph `subscriptionId` column, and a query can be scoped to
chosen subscriptions like any other table
([Resource Graph overview](https://learn.microsoft.com/en-us/azure/governance/resource-graph/overview)).
The REST sample for a recommendation shows an `actions` metadata id at subscription level, which
suggests some recommendations target the subscription itself rather than a resource
([Recommendations - Get](https://learn.microsoft.com/en-us/rest/api/advisor/recommendations/get)).
The retirement guide lists retirements whose service name is "Subscription"
([Service upgrade and retirement recommendations](https://learn.microsoft.com/en-us/azure/advisor/advisor-how-to-use-service-upgrade-retirement-recommendations)).
For those, `properties.resourceMetadata.resourceId` would be a subscription id. This is an
inference; no page states the shape of such a row.

### RBAC

The Reader role at subscription, resource group or resource scope can view recommendations but not
manage their status. "You must have access to the resource associated with the recommendation to
view a recommendation." The read actions are `Microsoft.Advisor/recommendations/read` and
`Microsoft.Advisor/metadata/read`
([Advisor permissions](https://learn.microsoft.com/en-us/azure/advisor/permissions)).
Resource Graph returns only rows the caller has at least read access to, and returns no results
otherwise
([Resource Graph overview](https://learn.microsoft.com/en-us/azure/governance/resource-graph/overview)).
RuleBeat's existing Reader credential is therefore enough. No write action is involved: changing a
recommendation's state is a separate, user-initiated operation that RuleBeat must not perform
([Advisor state management](https://learn.microsoft.com/en-us/azure/advisor/advisor-azure-state-management)).

### How service retirements appear

Retirements are recommendations in the "Service Upgrade and Retirement" subcategory under
Reliability, which is category `HighAvailability`. Upgrade-only recommendations have Retirement Date
and Retiring Feature set to N/A or null. The pane, the API, Resource Graph, Azure Service Health and
the workbooks "have the same source of truth - Advisor retirement recommendations". Coverage is not
complete: some retirements have no impacted-resource data yet ("To be updated soon"), and the feature
is supported only in Azure public cloud
([Service upgrade and retirement recommendations](https://learn.microsoft.com/en-us/azure/advisor/advisor-how-to-use-service-upgrade-retirement-recommendations)).

The same page gives this Resource Graph query
([Service upgrade and retirement recommendations](https://learn.microsoft.com/en-us/azure/advisor/advisor-how-to-use-service-upgrade-retirement-recommendations)):

```kusto
advisorresources
| where type == "microsoft.advisor/recommendations"
| where properties.category == "HighAvailability"
| where properties.extendedProperties.recommendationSubCategory == "ServiceUpgradeAndRetirement"
| extend retirementFeatureName = properties.extendedProperties.retirementFeatureName
| extend retirementDate = properties.extendedProperties.retirementDate
| extend resourceId = properties.resourceMetadata.resourceId
| extend shortDescription = properties.shortDescription.problem
| where retirementFeatureName != ''
| project retirementFeatureName, retirementDate, resourceId, shortDescription
```

The REST equivalents on that page
([Service upgrade and retirement recommendations](https://learn.microsoft.com/en-us/azure/advisor/advisor-how-to-use-service-upgrade-retirement-recommendations)):

- The retirement catalogue:
  `GET https://management.azure.com/providers/Microsoft.Advisor/metadata?api-version=2025-01-01&$filter=recommendationCategory eq 'HighAvailability' and recommendationSubCategory eq 'ServiceUpgradeAndRetirement'`.
  It returns `supportedValues[].id` (the recommendation type GUID) with
  `sourceProperties.serviceRetirement.retirementDate` and `retirementFeatureName`. Adding
  `$expand=ibiza` returns more detail. The page says the older `recommendationControl` filter is
  legacy and planned for deprecation.
- Impacted resources per subscription:
  `GET /subscriptions/{subscriptionId}/providers/Microsoft.Advisor/recommendations?api-version=2025-01-01&$filter=Category eq 'HighAvailability' and SubCategory eq 'ServiceUpgradeAndRetirement'`.
  `extendedProperties` include `recommendationControl`, `maturityLevel`, `retirementDate`,
  `retirementFeatureName` and `recommendationOfferingId`.

### Freshness

Resource Graph data "isn't strongly consistent. Data is indexed with a short latency." It is kept
current from Resource Manager change notifications plus a regular full scan. Queries are throttled
per user, reported through the `x-ms-user-quota-remaining` and `x-ms-user-quota-resets-after`
response headers
([Resource Graph overview](https://learn.microsoft.com/en-us/azure/governance/resource-graph/overview)).

Advisor itself "automatically checks every 24 hours ... (the exact cadence depends on the
recommendation type)". It defines the states Active, Postponed, Dismissed and Completed.
System-verified completed recommendations are final and kept for six months. Security
recommendations support only the Active state. This page is marked preview
([Advisor state management](https://learn.microsoft.com/en-us/azure/advisor/advisor-azure-state-management)).

The Service Retirement workbook's Resource Graph base query keeps a row only when
`properties.lastUpdated > ago(1d)` for GUID-named rows (otherwise `properties.platformState == 'New'`),
and drops rows where `properties.tracked` is set
([Service Retirement workbook source](https://github.com/microsoft/Application-Insights-Workbooks/blob/master/Workbooks/Azure%20Advisor/AzureServiceRetirement/Azure%20Services%20Retirement.workbook)).
Inference, not documented: this filter suggests that stale recommendation rows can stay in Resource
Graph after Advisor stops refreshing them, so a RuleBeat rule should apply the same freshness filter.

## 2. Service Health, Resource Health and the Service Retirement workbook

### Tables

The supported-tables reference lists `microsoft.resourcehealth/events` and
`microsoft.resourcehealth/events/impactedresources` under `servicehealthresources`, and
`microsoft.resourcehealth/availabilitystatuses` and `microsoft.resourcehealth/resourceannotations`
under `healthresources`. It lists no table named `resourcehealthresources`
([Resource Graph supported tables](https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources)).

### Event rows in Resource Graph

A Service Health event row has an `id` of the form
`/subscriptions/{subscriptionId}/providers/Microsoft.ResourceHealth/events/{trackingId}`. Its
properties include `EventType` (`ServiceIssue`, `PlannedMaintenance`, `HealthAdvisory`, `Billing`,
`SecurityAdvisory`, `EmergingIssues`, `PIR`), `EventSubType` (`Retirement`, `TaxChanges`,
`PriceChanges`, `MeterIDChanges`, `ForeignExchangeRateChange`, `UnauthorizedPartyAbuse`,
`Underbilling`, `Overbilling`), `Status` (`Active` or `Resolved`), `EventLevel`, `TrackingId`
("Unique identifier for the event"), `LastUpdateTime`, `Impact`, `Region`, `RecommendedActions`,
`PlatformInitiated`, `EventTags` and `Description`. The page notes the properties structure is
dynamic. Impacted-resource rows carry `targetResourceId`, `targetResourceType`, `targetRegion`,
`resourceName`, `maintenanceStartTime` and `maintenanceEndTime`. Service Health notifications are a
subclass of activity log events, and sensitive events need elevated access
([Service Health and Azure Resource Graph](https://learn.microsoft.com/en-us/azure/service-health/azure-resource-graph-overview)).

The Service Health sample queries use `properties.EventType`, `Status`, `Title`, `TrackingId`,
`Summary`, `Priority`, `ImpactStartTime`, `ImpactMitigationTime`, `EventSubType` and `Impact`. Some
samples convert times with `todatetime(tolong(...))`, so time fields can arrive as epoch numbers.
"All upcoming service retirement events are part of all active health advisory events", and the
retirements sample filters `EventType == "HealthAdvisory"`, `EventSubType == "Retirement"` and an
impact mitigation time later than now. For health advisories the mitigation time is the advisory's
end time. Emerging issues are not tied to subscription ids and cannot be queried through Resource
Graph. Updated results should appear "within 5 minutes in general"
([Service Health Resource Graph samples](https://learn.microsoft.com/en-us/azure/service-health/resource-graph-samples)).

### Permissions and tenant-level events

Owner, Contributor or Reader on a subscription can view its Service Health events, and updates are
"near real-time"
([Service Health FAQ](https://learn.microsoft.com/en-us/azure/service-health/service-health-faq)).

Subscription-level and tenant-level events are separate. Subscription events are available through
the portal, the API and Resource Graph with the Reader role or equivalent. Tenant events are
available through the portal and the API only, not through Resource Graph, and need a tenant admin
role. The two scopes are "mutually exclusive in view scope". Sensitive details, such as those of
security advisories, need elevated access through the `events/{trackingId}/fetchEventDetails`
endpoint
([Subscription vs. tenant admin accounts](https://learn.microsoft.com/en-us/azure/service-health/subscription-vs-tenant)).
For RuleBeat this means tenant-level events would need a credential with a tenant admin role, which
is a larger grant than Reader. That is a product decision, flagged here rather than assumed.

### Resource Health events REST API

`GET /subscriptions/{subscriptionId}/providers/Microsoft.ResourceHealth/events` (api-version
2025-05-01) accepts `$filter` (the example is `service eq 'Virtual Machines' or region eq 'West US'`)
and `queryStartTime`, which defaults to 3 days and applies to `lastUpdateTime`. Results page through
`nextLink` with a `$skipToken`. In the sample, `name` equals the tracking id. Documented values
([Events - List By Subscription Id](https://learn.microsoft.com/en-us/rest/api/resourcehealth/events/list-by-subscription-id?view=rest-resourcehealth-2025-05-01)):

- `eventType`: `ServiceIssue`, `PlannedMaintenance`, `HealthAdvisory`, `RCA`, `EmergingIssues`,
  `SecurityAdvisory`, `Billing`.
- `eventSubType`: `Retirement`, `ForeignExchangeRateChange`, `Underbilling`, `Overbilling`,
  `PriceChanges`, `TaxChanges`, `MeterIDChanges`, `UnauthorizedPartyAbuse`.
- `status`: `Active`, `Resolved`. `eventLevel`: `Critical`, `Error`, `Warning`, `Informational`.
- `impact[]` holds `impactedService` and `impactedServiceGuid` (a "permanent identifier for the
  impacted service"), and `impactedRegions[]` with `impactedRegion`, `impactedSubscriptions`,
  `impactedTenants`, `status` and `updates`.
- Other fields: `impactStartTime`, `impactMitigationTime`, `lastUpdateTime`, `priority` (0 to 23),
  `isEventSensitive` (details then come from `fetchEventDetails`), `isHIR`, `eventTags` (`Action
  Recommended`, `False Positive`, `Preliminary PIR`, `Final PIR`) and `platformInitiated`.

The REST enum names the post-incident type `RCA` while the Resource Graph page names it `PIR`
([Service Health and Azure Resource Graph](https://learn.microsoft.com/en-us/azure/service-health/azure-resource-graph-overview)).
A rule must match the source it actually queries.

### Data source of the Service Retirement workbook

The workbook has three views: Impacted Services, All Services and Retired Services. It shows only a
subset of services at resource level. Its FAQ says the Advisor APIs or Resource Graph return the same
data, and it points to Azure Updates for the full retirement lifecycle
([Service Retirement workbook](https://learn.microsoft.com/en-us/azure/advisor/advisor-workbook-service-retirement)).

The workbook source confirms that it reads Advisor, not Service Health
([Service Retirement workbook source](https://github.com/microsoft/Application-Insights-Workbooks/blob/master/Workbooks/Azure%20Advisor/AzureServiceRetirement/Azure%20Services%20Retirement.workbook)):

- The retirement catalogue comes from ARM endpoint queries against
  `providers/Microsoft.Advisor/metadata?api-version=2025-01-01`, filtered on
  `recommendationSubCategory eq 'ServiceUpgradeAndRetirement'` and on `retirementDate` against the
  current date, with `$expand=ibiza`. Columns come from
  `sourceProperties.serviceRetirement.retirementFeatureName`, `retirementDate`,
  `resourceMetadata.singular`, `learnMoreLink` and `recommendationIngestionType` (`Automated` shows
  as Yes, `Manual` as No).
- Impacted resources come from this Resource Graph base query, which the workbook then joins to
  `resources` and `resourcecontainers`:

```kusto
advisorresources
| where type =~ 'microsoft.advisor/recommendations'
| where properties.extendedProperties.recommendationSubCategory == 'ServiceUpgradeAndRetirement'
| where iff(strlen(name) == 36, properties.lastUpdated > ago(1d), properties.platformState == 'New')
| where isempty(properties.tracked)
| extend resourceId = tolower(tostring(properties.resourceMetadata.resourceId))
| project id, subscriptionId, resourceGroup, location, resourceId, ServiceID = tostring(properties.recommendationTypeId)
```

## 3. Azure Updates and Microsoft Graph service communications

### Azure Updates

The Azure Updates page links an RSS feed at
`https://www.microsoft.com/releasecommunications/api/v2/azure/rss`, and offers filters for products,
status (In development, In preview, Launched), update type, and new or updated
([Azure Updates](https://azure.microsoft.com/en-us/updates/)). A retirements view is linked from the
Advisor workbook page as `https://azure.microsoft.com/updates/?updateType=retirements`
([Service Retirement workbook](https://learn.microsoft.com/en-us/azure/advisor/advisor-workbook-service-retirement)).

Fetching the feed returns RSS 2.0 with the `a10` Atom namespace and the channel title "Azure service
updates". Each item has a numeric `guid` with `isPermaLink="false"`, a `link` of the form
`https://azure.microsoft.com/updates?id={guid}`, a `title` (retirements are titled starting with
"Retirement:"), one or more `category` elements (including "Retirements"), `description`, `pubDate`
and `a10:updated`
([Azure Updates RSS feed](https://www.microsoft.com/releasecommunications/api/v2/azure/rss)). This is
an observation of the live feed. No Microsoft page documenting the feed schema, its paging, its
history depth or the stability of `guid` was found.

The feed is global: it carries no tenant or subscription context and needs no credential. It cannot
say whether a tenant is affected. Joining an item to impacted resources would need the Advisor
retirement data in section 1, and no documented field links an Azure Updates item to an Advisor
recommendation type.

### Microsoft Graph service communications

The service communications API covers Microsoft 365 and Dynamics 365 services "subscribed by the
tenant", so its data is tenant-specific
([Service communications API overview](https://learn.microsoft.com/en-us/graph/service-communications-concept-overview)).
It does not cover Azure services.

**messages (Message center).** `GET /admin/serviceAnnouncement/messages` needs
`ServiceMessage.Read.All`, delegated (work or school account) or application. Personal Microsoft
accounts are not supported. The method "supports the OData query parameters" without listing which
operators each property supports. Callers can request up to 1000 items per page with
`Prefer: odata.maxpagesize`. The default page is 100, and `@odata.nextLink` pages with `$skip`. The
sample message has id `MC172851` and category `StayInformed`. The sample response includes
`expiryDateTime`, which is not in the v1.0 resource table
([List serviceAnnouncement messages](https://learn.microsoft.com/en-us/graph/api/serviceannouncement-list-messages?view=graph-rest-1.0)).

The `serviceUpdateMessage` resource has `actionRequiredByDateTime`, `body` (HTML), `category`
(`preventOrFixIssue`, `planForChange`, `stayInformed`, `unknownFutureValue`), `details` (which
"doesn't support filters"), `endDateTime`, `hasAttachments`, `id`, `isMajorChange`,
`lastModifiedDateTime`, `services`, `severity` (`normal`, `high`, `critical`, `unknownFutureValue`),
`startDateTime`, `tags` and `title`. `viewPoint` "is null when accessed with application
permissions". The resource also has markRead, markUnread, archive, unarchive, favorite and
unfavorite methods, which change per-user state; RuleBeat must not call them
([serviceUpdateMessage resource](https://learn.microsoft.com/en-us/graph/api/resources/serviceupdatemessage?view=graph-rest-1.0)).

Message center tracks posts by message ID, offers a Retirement tag, and marks a post as updated when
it changes, which implies an update keeps the same message ID. Read, archive and favourite state is
specific to each admin's own view
([Message center](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/message-center)).

**issues.** `GET /admin/serviceAnnouncement/issues` needs `ServiceHealth.Read.All`, delegated or
application, with the same paging rules. The sample issue id is `EX226792`
([List serviceAnnouncement issues](https://learn.microsoft.com/en-us/graph/api/serviceannouncement-list-issues?view=graph-rest-1.0)).
The `serviceHealthIssue` resource has `classification` (`advisory`, `incident`), `origin`
(`microsoft`, `thirdParty`, `customer`), `status` (including `serviceOperational`, `investigating`,
`restoringService`, `verifyingService`, `serviceRestored`, `postIncidentReviewPublished`,
`serviceDegradation`, `serviceInterruption`, `extendedRecovery`, `falsePositive` and
`investigationSuspended`), `isResolved`, `impactDescription`, `service`, `feature`, `featureGroup`
and `posts`. Issues marked `falsePositive` stay in history "until they expire"
([serviceHealthIssue resource](https://learn.microsoft.com/en-us/graph/api/resources/servicehealthissue?view=graph-rest-1.0)).

**healthOverviews.** `GET /admin/serviceAnnouncement/healthOverviews` needs `ServiceHealth.Read.All`,
delegated or application, returns pages of 100, has ids such as `Exchange` and `OrgLiveID`, and
supports `$expand=issues`
([List healthOverviews](https://learn.microsoft.com/en-us/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0)).

**Consent.** Both `ServiceMessage.Read.All` and `ServiceHealth.Read.All` require admin consent for
delegated and application use. The application descriptions read "Allows the app to read service
messages for a tenant, without a signed-in user" and the same for service health
([Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)).
Both are read-only, so they fit RuleBeat's read-only rule, but each is a new permission an admin must
grant to the existing app registration.

## 4. Stable key per source

| Source | Key | Basis |
|---|---|---|
| Advisor recommendation | `name` (GUID). Alternative: `properties.recommendationTypeId` plus lower-cased `properties.resourceMetadata.resourceId` | Microsoft samples project `stableId = name` ([Advisor and Azure Resource Graph](https://learn.microsoft.com/en-us/azure/advisor/advisor-azure-resource-graph)). The type GUID plus resource id is how the workbook joins rows ([workbook source](https://github.com/microsoft/Application-Insights-Workbooks/blob/master/Workbooks/Azure%20Advisor/AzureServiceRetirement/Azure%20Services%20Retirement.workbook)). Neither page states that `name` survives a refresh |
| Advisor retirement type | `recommendationTypeId`, equal to metadata `supportedValues[].id` | [Service upgrade and retirement recommendations](https://learn.microsoft.com/en-us/azure/advisor/advisor-how-to-use-service-upgrade-retirement-recommendations) |
| Service Health event (Resource Graph) | `id`, which is subscription plus tracking id; or `properties.TrackingId` alone for a tenant-wide view | `TrackingId` is the "Unique identifier for the event" ([Service Health and Azure Resource Graph](https://learn.microsoft.com/en-us/azure/service-health/azure-resource-graph-overview)) |
| Service Health impacted resource | Tracking id plus `properties.targetResourceId` | [Service Health and Azure Resource Graph](https://learn.microsoft.com/en-us/azure/service-health/azure-resource-graph-overview) |
| Resource Health event (REST) | `name` (tracking id); `impactedServiceGuid` identifies the service permanently | [Events - List By Subscription Id](https://learn.microsoft.com/en-us/rest/api/resourcehealth/events/list-by-subscription-id?view=rest-resourcehealth-2025-05-01) |
| Azure Updates item | `guid` | Observed in the feed only; not documented |
| Graph message | `id` (MC number) | [Message center](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/message-center), [serviceUpdateMessage](https://learn.microsoft.com/en-us/graph/api/resources/serviceupdatemessage?view=graph-rest-1.0) |
| Graph issue | `id` | [serviceHealthIssue](https://learn.microsoft.com/en-us/graph/api/resources/servicehealthissue?view=graph-rest-1.0) |
| Graph health overview | `id` (service name) | [List healthOverviews](https://learn.microsoft.com/en-us/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0) |

For a lifecycle that resolves an advisory when it goes away, note that Advisor rows can linger (see
the freshness inference in section 1), Service Health events move to `Resolved` rather than
disappearing, and Graph issues report `isResolved`. Each source therefore needs its own "still
open" condition in the rule's query rather than relying on the row vanishing.

## Open questions / could not confirm

- Whether an Advisor recommendation's `name` GUID stays the same across Advisor refreshes. The
  `stableId = name` sample implies it, but no page states it.
- Whether stale `microsoft.advisor/recommendations` rows remain in Resource Graph after Advisor stops
  producing them, and for how long. The workbook's one-day `lastUpdated` filter suggests they do.
- Why `microsoft.advisor/advisorscore` and `microsoft.advisor/metadata` appear on the Advisor
  Resource Graph page but not in the supported-tables reference.
- Whether Advisor metadata (the retirement catalogue) differs between tenants. The endpoint is
  provider-level, which suggests it is global, but this is not stated.
- How long Service Health events stay in Resource Graph after they resolve.
- Whether a table named `resourcehealthresources` exists. The supported-tables reference lists only
  `healthresources` and `servicehealthresources`.
- The Azure Updates RSS feed schema, history depth, paging, and whether `guid` is stable. No Microsoft
  documentation of the feed was found; everything about it here comes from the live feed.
- Which `$filter` operators the Graph `messages` and `issues` lists support (for example on
  `lastModifiedDateTime`). The reference says only that OData query parameters are supported. The
  one example found was on a Q&A site, which is not a primary source.
- How long Graph messages and issues are retained. `expiryDateTime` appears in the messages sample
  but not in the v1.0 resource table, and the issues page only says false positives stay "until they
  expire".
- The Advisor FAQ and a Service Health list page returned 404 during this research, so anything those
  pages might add is not covered.
