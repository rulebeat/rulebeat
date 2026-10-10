import type { ChangedFindingDetail, Finding } from '@/lib/types';
import type { FindingRow } from '@/lib/finding-rows';
import type { NotificationChannelType } from '@/lib/db/notification-channels';
import type { ScheduleRun } from '@/lib/schedule-runs';
import { isActivityRule } from '@/lib/finding-kinds';
import { tabForKind, type ViewTab } from '@/lib/view-response';

export type NotificationPayload =
  | { kind: 'webhook'; body: object; contentType: 'application/json' }
  | { kind: 'email'; subject: string; text: string };

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
};

function countsBySeverity(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

function summaryLine(findings: Finding[]): string {
  const counts = countsBySeverity(findings);
  return (['critical', 'high', 'medium', 'low', 'info'] as const)
    .filter(s => (counts[s] ?? 0) > 0)
    .map(s => `${counts[s]} ${s}`)
    .join(', ');
}

/** One "View changed ..." link: the open findings of one tab, since a changed finding is not new. */
interface ChangedLink {
  tab: ViewTab;
  label: string;
  href: string;
}

/**
 * What a message carries. `problems` and `activity` go to every channel, each in its own section
 * (#212); `advisories` is only present for a channel that opted in, and is a separate section in
 * every format. With no Activity and no advisories a message is exactly what it was before.
 */
interface MessageContent {
  /** Problems and Activity together, in the order they arrived: what the webhook's top-level
   *  fields hold. */
  everyChannel: Finding[];
  problems: Finding[];
  /** Activity findings, in their own "Activity" section with a link to the Activity tab. */
  activity: Finding[];
  advisories: Finding[];
  href: string;
  /** Where "View activity" goes: the Activity tab, filtered to new. */
  activityHref: string;
  /** Where "View advisories" goes: the Advisories tab, filtered to new. */
  advisoriesHref: string;
  /** Findings that gained rows (#193), in their own "Changed" section; Problems, Activity and, for a
   *  channel that includes them, Advisories alike. Empty for a message with none. */
  changed: ChangedFindingDetail[];
  /** One link per tab the changed findings are listed on, in tab order. */
  changedLinks: ChangedLink[];
}

/** A message holding only Activity, advisories or changed findings has no problem section; one
 *  holding nothing keeps the old shape. */
function hasProblemSection(c: MessageContent): boolean {
  return c.problems.length > 0 || (c.activity.length === 0 && c.advisories.length === 0 && c.changed.length === 0);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The one-line title: the old "N new findings", with the advisory and changed counts joined on when
 *  there are any. */
function headline(c: MessageContent): string {
  const parts = [
    ...(hasProblemSection(c) ? [plural(c.problems.length, 'new finding', 'new findings')] : []),
    ...(c.activity.length > 0 ? [plural(c.activity.length, 'new activity finding', 'new activity findings')] : []),
    ...(c.advisories.length > 0 ? [plural(c.advisories.length, 'new advisory', 'new advisories')] : []),
    ...(c.changed.length > 0 ? [plural(c.changed.length, 'changed finding', 'changed findings')] : []),
  ];
  const last = parts.pop()!;
  return `RuleBeat: ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}`;
}

const MAX_ROWS_SHOWN = 5;
const MAX_VALUE_LENGTH = 80;
/** How many findings (of each section) a Teams card or Slack message lists, an email lists and a
 *  webhook body carries; the rest is a count. */
const MAX_CARD_FINDINGS = 5;
const MAX_EMAIL_FINDINGS = 10;
const MAX_WEBHOOK_FINDINGS = 20;

function rowValue(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}...` : text;
}

/** A row as its key: value pairs, compact. */
function renderRow(row: FindingRow): string {
  return Object.entries(row).map(([key, value]) => `${key}: ${rowValue(value)}`).join(', ');
}

const CHANGED_LABEL = (findings: ChangedFindingDetail[]) => `Changed (${findings.length})`;

/** One line per added row, up to the first five, then "and N more rows". */
function addedRowLines(rows: FindingRow[], prefix: string): string[] {
  return [
    ...rows.slice(0, MAX_ROWS_SHOWN).map(row => `${prefix}${renderRow(row)}`),
    ...(rows.length > MAX_ROWS_SHOWN ? [`... and ${rows.length - MAX_ROWS_SHOWN} more rows.`] : []),
  ];
}

const ADVISORIES_LABEL = (findings: Finding[]) => `Advisories (${findings.length})`;
const ACTIVITY_LABEL = (findings: Finding[]) => `Activity (${findings.length})`;

/** Teams Adaptive Card table of the first five findings, headed by `firstColumn`. */
function teamsTable(findings: Finding[], firstColumn: string): object[] {
  const rows = findings.slice(0, MAX_CARD_FINDINGS).map(f => ({
    type: 'TableRow',
    cells: [
      { type: 'TableCell', items: [{ type: 'TextBlock', text: SEVERITY_LABEL[f.severity] ?? f.severity, wrap: false, size: 'Small' }] },
      { type: 'TableCell', items: [{ type: 'TextBlock', text: f.title, wrap: true, size: 'Small' }] },
      { type: 'TableCell', items: [{ type: 'TextBlock', text: f.resourceName, wrap: false, size: 'Small' }] },
    ],
  }));
  if (rows.length === 0) return [];

  const table: object[] = [{
    type: 'Table',
    columns: [{ width: 1 }, { width: 3 }, { width: 2 }],
    rows: [
      {
        type: 'TableRow',
        style: 'accent',
        cells: [
          { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Severity', weight: 'Bolder', size: 'Small' }] },
          { type: 'TableCell', items: [{ type: 'TextBlock', text: firstColumn, weight: 'Bolder', size: 'Small' }] },
          { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Resource', weight: 'Bolder', size: 'Small' }] },
        ],
      },
      ...rows,
    ],
    spacing: 'Medium',
  }];
  if (findings.length > MAX_CARD_FINDINGS) {
    table.push({
      type: 'TextBlock',
      text: `... and ${findings.length - MAX_CARD_FINDINGS} more.`,
      isSubtle: true,
      size: 'Small',
    });
  }
  return table;
}

/** Teams blocks for the first five changed findings: the finding, then the rows it gained. */
function teamsChangedBlocks(changed: ChangedFindingDetail[]): object[] {
  const blocks: object[] = [
    { type: 'TextBlock', text: CHANGED_LABEL(changed), weight: 'Bolder', spacing: 'Large' },
  ];
  for (const f of changed.slice(0, MAX_CARD_FINDINGS)) {
    blocks.push({
      type: 'TextBlock',
      text: `**${f.title}** · ${f.resourceName} (${SEVERITY_LABEL[f.severity] ?? f.severity})`,
      wrap: true,
      size: 'Small',
      spacing: 'Small',
    });
    blocks.push({
      type: 'TextBlock',
      text: addedRowLines(f.addedRows, '+ ').join('\n\n'),
      wrap: true,
      size: 'Small',
      isSubtle: true,
      spacing: 'None',
    });
  }
  if (changed.length > MAX_CARD_FINDINGS) {
    blocks.push({ type: 'TextBlock', text: `... and ${changed.length - MAX_CARD_FINDINGS} more.`, isSubtle: true, size: 'Small' });
  }
  return blocks;
}

/** Teams Adaptive Card payload for Power Automate Workflows. */
function buildTeamsPayload(c: MessageContent, _run: ScheduleRun): object {
  const problemSection = hasProblemSection(c);

  const card = {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: headline(c),
        weight: 'Bolder',
        size: 'Medium',
      },
      ...(problemSection ? [{
        type: 'TextBlock',
        text: summaryLine(c.problems),
        spacing: 'None',
        isSubtle: true,
      }] : []),
      ...teamsTable(c.problems, 'Finding'),
      ...(c.activity.length > 0 ? [
        {
          type: 'TextBlock',
          text: ACTIVITY_LABEL(c.activity),
          weight: 'Bolder',
          spacing: 'Large',
        },
        {
          type: 'TextBlock',
          text: summaryLine(c.activity),
          spacing: 'None',
          isSubtle: true,
        },
        ...teamsTable(c.activity, 'Activity'),
      ] : []),
      ...(c.advisories.length > 0 ? [
        {
          type: 'TextBlock',
          text: ADVISORIES_LABEL(c.advisories),
          weight: 'Bolder',
          spacing: 'Large',
        },
        {
          type: 'TextBlock',
          text: summaryLine(c.advisories),
          spacing: 'None',
          isSubtle: true,
        },
        ...teamsTable(c.advisories, 'Advisory'),
      ] : []),
      ...(c.changed.length > 0 ? teamsChangedBlocks(c.changed) : []),
    ],
    actions: [
      ...(problemSection ? [{
        type: 'Action.OpenUrl',
        title: 'Open in RuleBeat',
        url: c.href,
      }] : []),
      ...(c.activity.length > 0 ? [{
        type: 'Action.OpenUrl',
        title: 'View activity',
        url: c.activityHref,
      }] : []),
      ...(c.advisories.length > 0 ? [{
        type: 'Action.OpenUrl',
        title: 'View advisories',
        url: c.advisoriesHref,
      }] : []),
      ...c.changedLinks.map(link => ({
        type: 'Action.OpenUrl',
        title: link.label,
        url: link.href,
      })),
    ],
  };

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: card,
      },
    ],
  };
}

/** Slack blocks for the first five findings: a divider, one section each, and a "more" line. */
function slackFindingBlocks(findings: Finding[]): object[] {
  const blocks: object[] = [];
  const top = findings.slice(0, MAX_CARD_FINDINGS);
  if (top.length > 0) {
    blocks.push({ type: 'divider' });
    for (const f of top) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${f.title}*\n*${(f.severity).toUpperCase()}* · ${f.resourceName}`,
        },
      });
    }
  }
  if (findings.length > MAX_CARD_FINDINGS) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_... and ${findings.length - MAX_CARD_FINDINGS} more._` },
    });
  }
  return blocks;
}

/** Slack Block Kit payload. */
function buildSlackPayload(c: MessageContent, _run: ScheduleRun): object {
  const problemSection = hasProblemSection(c);

  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headline(c), emoji: true },
    },
    ...(problemSection ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: summaryLine(c.problems) },
    }] : []),
    ...slackFindingBlocks(c.problems),
  ];

  if (c.activity.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${ACTIVITY_LABEL(c.activity)}*\n${summaryLine(c.activity)}` },
    });
    blocks.push(...slackFindingBlocks(c.activity));
  }

  if (c.advisories.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${ADVISORIES_LABEL(c.advisories)}*\n${summaryLine(c.advisories)}` },
    });
    blocks.push(...slackFindingBlocks(c.advisories));
  }

  if (c.changed.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${CHANGED_LABEL(c.changed)}*` },
    });
    for (const f of c.changed.slice(0, MAX_CARD_FINDINGS)) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${f.title}*\n*${(f.severity).toUpperCase()}* · ${f.resourceName}\n${addedRowLines(f.addedRows, '+ ').join('\n')}`,
        },
      });
    }
    if (c.changed.length > MAX_CARD_FINDINGS) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `_... and ${c.changed.length - MAX_CARD_FINDINGS} more._` },
      });
    }
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      ...(problemSection ? [{
        type: 'button',
        text: { type: 'plain_text', text: 'View findings', emoji: true },
        url: c.href,
        style: 'primary',
      }] : []),
      ...(c.activity.length > 0 ? [{
        type: 'button',
        text: { type: 'plain_text', text: 'View activity', emoji: true },
        url: c.activityHref,
      }] : []),
      ...(c.advisories.length > 0 ? [{
        type: 'button',
        text: { type: 'plain_text', text: 'View advisories', emoji: true },
        url: c.advisoriesHref,
      }] : []),
      ...c.changedLinks.map(link => ({
        type: 'button',
        text: { type: 'plain_text', text: link.label, emoji: true },
        url: link.href,
      })),
    ],
  });

  return { blocks };
}

function webhookFinding(f: Finding) {
  return {
    fingerprint: f.fingerprint,
    title: f.title,
    severity: f.severity,
    category: f.category,
    resourceId: f.resourceId,
    resourceName: f.resourceName,
    subscriptionId: f.subscriptionId,
  };
}

/** Generic stable JSON webhook payload. The top-level fields never change shape, so they still hold
 *  Problems and Activity together; Activity is repeated in its own `activity` field with its own
 *  link (#212), and advisories, when the channel includes them and there are any, arrive in their
 *  own `advisories` field. */
function buildWebhookPayload(c: MessageContent, run: ScheduleRun): object {
  const everyChannel = c.everyChannel;
  return {
    event: 'scan.new_findings',
    runId: run.id,
    triggeredBy: run.triggeredBy,
    counts: countsBySeverity(everyChannel),
    totalNewFindings: everyChannel.length,
    findings: everyChannel.slice(0, MAX_WEBHOOK_FINDINGS).map(webhookFinding),
    scansUrl: c.href,
    ...(c.activity.length > 0 ? {
      activity: {
        totalNewActivity: c.activity.length,
        counts: countsBySeverity(c.activity),
        findings: c.activity.slice(0, MAX_WEBHOOK_FINDINGS).map(webhookFinding),
        activityUrl: c.activityHref,
      },
    } : {}),
    ...(c.advisories.length > 0 ? {
      advisories: {
        totalNewAdvisories: c.advisories.length,
        counts: countsBySeverity(c.advisories),
        findings: c.advisories.slice(0, MAX_WEBHOOK_FINDINGS).map(webhookFinding),
        advisoriesUrl: c.advisoriesHref,
      },
    } : {}),
    ...(c.changed.length > 0 ? {
      changed: {
        totalChangedFindings: c.changed.length,
        findings: c.changed.slice(0, MAX_WEBHOOK_FINDINGS).map(f => ({ ...webhookFinding(f), addedRows: f.addedRows })),
        // The first tab's link, so a body holding one kind of change links straight to its tab.
        changedUrl: c.changedLinks[0].href,
        changedUrls: Object.fromEntries(c.changedLinks.map(link => [link.tab, link.href])),
      },
    } : {}),
  };
}

/** Plain-text list of up to ten findings, with the "and N more" line. */
function emailItems(findings: Finding[]): string[] {
  const total = findings.length;
  return [
    ...findings.slice(0, MAX_EMAIL_FINDINGS).map(f =>
      `[${(f.severity).toUpperCase()}] ${f.title}\n  Resource: ${f.resourceName}\n  Category: ${f.category}`,
    ),
    ...(total > MAX_EMAIL_FINDINGS ? [`\n... and ${total - MAX_EMAIL_FINDINGS} more.`] : []),
  ];
}

/** Plain-text list of up to ten changed findings, each with a line per row it gained. */
function emailChangedItems(findings: ChangedFindingDetail[]): string[] {
  const total = findings.length;
  return [
    ...findings.slice(0, MAX_EMAIL_FINDINGS).map(f => [
      `[${(f.severity).toUpperCase()}] ${f.title}`,
      `  Resource: ${f.resourceName}`,
      `  Category: ${f.category}`,
      ...addedRowLines(f.addedRows, '  Added: ').map(line => (line.startsWith('...') ? `  ${line}` : line)),
    ].join('\n')),
    ...(total > MAX_EMAIL_FINDINGS ? [`\n... and ${total - MAX_EMAIL_FINDINGS} more.`] : []),
  ];
}

/** Plain-text email body. */
function buildEmailPayload(c: MessageContent, _run: ScheduleRun): { subject: string; text: string } {
  const problemSection = hasProblemSection(c);
  const total = c.problems.length;

  const lines = [
    ...(problemSection ? [
      `RuleBeat found ${total} new finding${total === 1 ? '' : 's'}.`,
      `Summary: ${summaryLine(c.problems)}`,
      '',
      ...emailItems(c.problems),
      '',
    ] : []),
    ...(c.activity.length > 0 ? [
      `Activity: ${c.activity.length} new`,
      `Summary: ${summaryLine(c.activity)}`,
      '',
      ...emailItems(c.activity),
      '',
    ] : []),
    ...(c.advisories.length > 0 ? [
      `Advisories: ${c.advisories.length} new`,
      `Summary: ${summaryLine(c.advisories)}`,
      '',
      ...emailItems(c.advisories),
      '',
    ] : []),
    ...(c.changed.length > 0 ? [
      `Changed: ${plural(c.changed.length, 'finding', 'findings')} gained rows`,
      '',
      ...emailChangedItems(c.changed),
      '',
    ] : []),
    ...(problemSection ? [`View in RuleBeat: ${c.href}`] : []),
    ...(c.activity.length > 0 ? [`View activity: ${c.activityHref}`] : []),
    ...(c.advisories.length > 0 ? [`View advisories: ${c.advisoriesHref}`] : []),
    ...c.changedLinks.map(link => `${link.label}: ${link.href}`),
  ];

  return {
    subject: headline(c),
    text: lines.join('\n'),
  };
}

/** The order a message's sections and links come in: Problems, Activity, then Advisories. */
const SECTION_ORDER: readonly ViewTab[] = ['results', 'activity', 'advisories'];

const CHANGED_LINK_LABEL: Record<ViewTab, string> = {
  results: 'View changed findings',
  activity: 'View changed activity',
  advisories: 'View changed advisories',
};

/** Where the changed findings of each tab are looked at. A tab without its own link falls back to
 *  the Results one. */
export interface ChangedHrefs {
  href: string;
  activityHref?: string;
  advisoriesHref?: string;
}

/** One link per tab the changed findings are listed on, so a changed Activity finding links to the
 *  Activity tab rather than to Results (#212). */
function changedLinks(changed: ChangedFindingDetail[], hrefs: ChangedHrefs): ChangedLink[] {
  const byTab: Record<ViewTab, string> = {
    results: hrefs.href,
    activity: hrefs.activityHref ?? hrefs.href,
    advisories: hrefs.advisoriesHref ?? hrefs.href,
  };
  const tabs = new Set(changed.map(f => tabForKind(f.kind)));
  return SECTION_ORDER.filter(tab => tabs.has(tab)).map(tab => ({ tab, label: CHANGED_LINK_LABEL[tab], href: byTab[tab] }));
}

/**
 * Builds the message for one channel. `findings` is what goes to every channel, Problems and
 * Activity, and the message gives each its own section; `advisories` is the Advisories the channel
 * opted in to (empty for a channel that did not), so a channel without the setting gets exactly the
 * message it always got.
 */
export function buildPayload(
  type: NotificationChannelType,
  findings: Finding[],
  href: string,
  run: ScheduleRun,
  advisories: Finding[] = [],
  advisoriesHref: string = href,
  changes?: { findings: ChangedFindingDetail[] } & ChangedHrefs,
  activityHref: string = href,
): NotificationPayload {
  const changed = changes?.findings ?? [];
  const content: MessageContent = {
    everyChannel: findings,
    problems: findings.filter(f => !isActivityRule(f)),
    activity: findings.filter(isActivityRule),
    advisories, href, activityHref, advisoriesHref,
    changed, changedLinks: changes ? changedLinks(changed, changes) : [],
  };
  if (type === 'email') {
    return { kind: 'email', ...buildEmailPayload(content, run) };
  }
  let body: object;
  if (type === 'teams') body = buildTeamsPayload(content, run);
  else if (type === 'slack') body = buildSlackPayload(content, run);
  else body = buildWebhookPayload(content, run);
  return { kind: 'webhook', body, contentType: 'application/json' };
}
