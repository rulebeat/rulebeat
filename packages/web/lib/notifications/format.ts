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

/** Teams Adaptive Card payload for Power Automate Workflows. */
function buildTeamsPayload(findings: Finding[], href: string, _run: ScheduleRun): object {
  const top = findings.slice(0, 5);
  const total = findings.length;

  const rows = top.map(f => ({
    type: 'TableRow',
    cells: [
      { type: 'TableCell', items: [{ type: 'TextBlock', text: SEVERITY_LABEL[f.severity] ?? f.severity, wrap: false, size: 'Small' }] },
      { type: 'TableCell', items: [{ type: 'TextBlock', text: f.title, wrap: true, size: 'Small' }] },
      { type: 'TableCell', items: [{ type: 'TextBlock', text: f.resourceName, wrap: false, size: 'Small' }] },
    ],
  }));

  const card = {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: `RuleBeat: ${total} new finding${total === 1 ? '' : 's'}`,
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: summaryLine(findings),
        spacing: 'None',
        isSubtle: true,
      },
      ...(rows.length > 0 ? [{
        type: 'Table',
        columns: [{ width: 1 }, { width: 3 }, { width: 2 }],
        rows: [
          {
            type: 'TableRow',
            style: 'accent',
            cells: [
              { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Severity', weight: 'Bolder', size: 'Small' }] },
              { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Finding', weight: 'Bolder', size: 'Small' }] },
              { type: 'TableCell', items: [{ type: 'TextBlock', text: 'Resource', weight: 'Bolder', size: 'Small' }] },
            ],
          },
          ...rows,
        ],
        spacing: 'Medium',
      }] : []),
      ...(total > 5 ? [{
        type: 'TextBlock',
        text: `... and ${total - 5} more.`,
        isSubtle: true,
        size: 'Small',
      }] : []),
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Open in RuleBeat',
        url: href,
      },
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

/** Slack Block Kit payload. */
function buildSlackPayload(findings: Finding[], href: string, _run: ScheduleRun): object {
  const total = findings.length;
  const top = findings.slice(0, 5);

  const blocks: object[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `RuleBeat: ${total} new finding${total === 1 ? '' : 's'}`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summaryLine(findings) },
    },
  ];

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

  if (total > 5) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_... and ${total - 5} more._` },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View findings', emoji: true },
        url: href,
        style: 'primary',
      },
    ],
  });

  return { blocks };
}

/** Generic stable JSON webhook payload. */
function buildWebhookPayload(findings: Finding[], href: string, run: ScheduleRun): object {
  return {
    event: 'scan.new_findings',
    runId: run.id,
    triggeredBy: run.triggeredBy,
    counts: countsBySeverity(findings),
    totalNewFindings: findings.length,
    findings: findings.slice(0, 20).map(f => ({
      fingerprint: f.fingerprint,
      title: f.title,
      severity: f.severity,
      category: f.category,
      resourceId: f.resourceId,
      resourceName: f.resourceName,
      subscriptionId: f.subscriptionId,
    })),
    scansUrl: href,
  };
}

/** Plain-text email body. */
function buildEmailPayload(findings: Finding[], href: string, _run: ScheduleRun): { subject: string; text: string } {
  const total = findings.length;
  const top = findings.slice(0, 10);

  const lines = [
    `RuleBeat found ${total} new finding${total === 1 ? '' : 's'}.`,
    `Summary: ${summaryLine(findings)}`,
    '',
    ...top.map(f =>
      `[${(f.severity).toUpperCase()}] ${f.title}\n  Resource: ${f.resourceName}\n  Category: ${f.category}`,
    ),
    ...(total > 10 ? [`\n... and ${total - 10} more.`] : []),
    '',
    `View in RuleBeat: ${href}`,
  ];

  return {
    subject: `RuleBeat: ${total} new finding${total === 1 ? '' : 's'}`,
    text: lines.join('\n'),
  };
}

export function buildPayload(
  type: NotificationChannelType,
  findings: Finding[],
  href: string,
  run: ScheduleRun,
): NotificationPayload {
  if (type === 'email') {
    return { kind: 'email', ...buildEmailPayload(findings, href, run) };
  }
  let body: object;
  if (type === 'teams') body = buildTeamsPayload(findings, href, run);
  else if (type === 'slack') body = buildSlackPayload(findings, href, run);
  else body = buildWebhookPayload(findings, href, run);
  return { kind: 'webhook', body, contentType: 'application/json' };
}
