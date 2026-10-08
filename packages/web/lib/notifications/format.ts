import type { Finding } from '@/lib/types';
import type { NotificationChannelType } from '@/lib/db/notification-channels';
import type { ScheduleRun } from '@/lib/schedule-runs';

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

/**
 * What a message carries. `problems` is everything that goes to every channel (Problems and
 * Activity); `advisories` is only present for a channel that opted in, and is a separate section in
 * every format. With no advisories a message is exactly what it was before the setting existed.
 */
interface MessageContent {
  problems: Finding[];
  advisories: Finding[];
  href: string;
  /** Where "View advisories" goes: the Advisories tab, filtered to new. */
  advisoriesHref: string;
}

/** A message holding only advisories has no problem section; one holding neither keeps the old shape. */
function hasProblemSection(c: MessageContent): boolean {
  return c.problems.length > 0 || c.advisories.length === 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The one-line title: the old "N new findings", with the advisory count joined on when there is one. */
function headline(c: MessageContent): string {
  const advisories = plural(c.advisories.length, 'new advisory', 'new advisories');
  if (c.advisories.length === 0) return `RuleBeat: ${plural(c.problems.length, 'new finding', 'new findings')}`;
  if (c.problems.length === 0) return `RuleBeat: ${advisories}`;
  return `RuleBeat: ${plural(c.problems.length, 'new finding', 'new findings')} and ${advisories}`;
}

const ADVISORIES_LABEL = (findings: Finding[]) => `Advisories (${findings.length})`;

/** Teams Adaptive Card table of the first five findings, headed by `firstColumn`. */
function teamsTable(findings: Finding[], firstColumn: string): object[] {
  const rows = findings.slice(0, 5).map(f => ({
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
  if (findings.length > 5) {
    table.push({
      type: 'TextBlock',
      text: `... and ${findings.length - 5} more.`,
      isSubtle: true,
      size: 'Small',
    });
  }
  return table;
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
    ],
    actions: [
      ...(problemSection ? [{
        type: 'Action.OpenUrl',
        title: 'Open in RuleBeat',
        url: c.href,
      }] : []),
      ...(c.advisories.length > 0 ? [{
        type: 'Action.OpenUrl',
        title: 'View advisories',
        url: c.advisoriesHref,
      }] : []),
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
  const top = findings.slice(0, 5);
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
  if (findings.length > 5) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_... and ${findings.length - 5} more._` },
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

  if (c.advisories.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${ADVISORIES_LABEL(c.advisories)}*\n${summaryLine(c.advisories)}` },
    });
    blocks.push(...slackFindingBlocks(c.advisories));
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
      ...(c.advisories.length > 0 ? [{
        type: 'button',
        text: { type: 'plain_text', text: 'View advisories', emoji: true },
        url: c.advisoriesHref,
      }] : []),
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

/** Generic stable JSON webhook payload. The problem fields never change shape; advisories, when
 *  the channel includes them and there are any, arrive in their own `advisories` field. */
function buildWebhookPayload(c: MessageContent, run: ScheduleRun): object {
  return {
    event: 'scan.new_findings',
    runId: run.id,
    triggeredBy: run.triggeredBy,
    counts: countsBySeverity(c.problems),
    totalNewFindings: c.problems.length,
    findings: c.problems.slice(0, 20).map(webhookFinding),
    scansUrl: c.href,
    ...(c.advisories.length > 0 ? {
      advisories: {
        totalNewAdvisories: c.advisories.length,
        counts: countsBySeverity(c.advisories),
        findings: c.advisories.slice(0, 20).map(webhookFinding),
        advisoriesUrl: c.advisoriesHref,
      },
    } : {}),
  };
}

/** Plain-text list of up to ten findings, with the "and N more" line. */
function emailItems(findings: Finding[]): string[] {
  const total = findings.length;
  return [
    ...findings.slice(0, 10).map(f =>
      `[${(f.severity).toUpperCase()}] ${f.title}\n  Resource: ${f.resourceName}\n  Category: ${f.category}`,
    ),
    ...(total > 10 ? [`\n... and ${total - 10} more.`] : []),
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
    ...(c.advisories.length > 0 ? [
      `Advisories: ${c.advisories.length} new`,
      `Summary: ${summaryLine(c.advisories)}`,
      '',
      ...emailItems(c.advisories),
      '',
    ] : []),
    ...(problemSection ? [`View in RuleBeat: ${c.href}`] : []),
    ...(c.advisories.length > 0 ? [`View advisories: ${c.advisoriesHref}`] : []),
  ];

  return {
    subject: headline(c),
    text: lines.join('\n'),
  };
}

/**
 * Builds the message for one channel. `findings` is what goes to every channel; `advisories` is the
 * Advisories the channel opted in to (empty for a channel that did not), so a channel without the
 * setting gets exactly the message it always got.
 */
export function buildPayload(
  type: NotificationChannelType,
  findings: Finding[],
  href: string,
  run: ScheduleRun,
  advisories: Finding[] = [],
  advisoriesHref: string = href,
): NotificationPayload {
  const content: MessageContent = { problems: findings, advisories, href, advisoriesHref };
  if (type === 'email') {
    return { kind: 'email', ...buildEmailPayload(content, run) };
  }
  let body: object;
  if (type === 'teams') body = buildTeamsPayload(content, run);
  else if (type === 'slack') body = buildSlackPayload(content, run);
  else body = buildWebhookPayload(content, run);
  return { kind: 'webhook', body, contentType: 'application/json' };
}
