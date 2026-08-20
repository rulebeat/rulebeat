import { useState } from 'react';
import type { PreflightResult, PreflightStatus } from '@/lib/preflight';
import { CircleAlert, CircleCheck, CircleX, MinusCircle, ChevronDown, ChevronUp } from 'lucide-react';

/* A check either passed, needs attention, failed, or was not run. Those are outcomes,
 * so they use the status tokens rather than severity's, and they follow the theme.
 * "Skipped" gets no colour at all: nothing happened, so nothing should draw the eye. */
export const STATUS_ICON: Record<PreflightStatus, React.ReactNode> = {
  ok: <CircleCheck className="size-4 shrink-0 text-status-ok" />,
  warn: <CircleAlert className="size-4 shrink-0 text-status-warn" />,
  fail: <CircleX className="size-4 shrink-0 text-sev-critical" />,
  skipped: <MinusCircle className="size-4 shrink-0 text-ink-faint" />,
};

const COLLAPSE_THRESHOLD = 6;

/** Check list + subscriptions panel, shared between onboarding step 2 and the diagnostics page. */
export function PreflightChecks({ result }: { result: PreflightResult }) {
  const subs = result.subscriptions;
  const collapsible = subs.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!collapsible);

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border bg-surface">
        {result.checks.map(check => (
          <li key={check.id} className="flex items-start gap-3 px-3.5 py-3">
            {STATUS_ICON[check.status]}
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-ink">{check.label}</p>
              <p className="text-xs leading-relaxed text-ink-2">{check.summary}</p>
              {check.remediation && (
                <p className="text-xs leading-relaxed text-ink-2">{check.remediation}</p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {subs.length > 0 && (
        <div className="space-y-2 bg-surface-sunken px-3.5 py-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-ink">
              {subs.length} subscription{subs.length === 1 ? '' : 's'} in scope
            </p>
            {collapsible && (
              <button
                onClick={() => setExpanded(v => !v)}
                className="flex items-center gap-1 text-xs text-ink-2 transition-colors hover:text-ink"
              >
                {expanded ? (
                  <><ChevronUp className="size-3" />Hide</>
                ) : (
                  <><ChevronDown className="size-3" />Show all</>
                )}
              </button>
            )}
          </div>

          {/* No height cap here. The Show all / Hide control above already exists precisely
              so a long list does not take over the panel, and stacking an inner scrollbar
              on top of it meant "show all" still hid most of them behind a second scroll. */}
          {expanded && (
            <ul className="space-y-0.5 text-xs text-ink">
              {subs.map(s => (
                <li key={s.id} className="truncate">
                  {s.name} <span className="font-mono text-ink-faint">({s.id})</span>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-ink-2">
            RuleBeat scans all subscriptions this identity has Reader access to. To exclude one,
            remove its Reader role assignment in Azure RBAC.
          </p>
        </div>
      )}
    </div>
  );
}
