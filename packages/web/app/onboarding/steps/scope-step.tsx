'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Category } from '@/lib/types';
import type { OnboardingRuleSummary } from '@/lib/rules';
import type { PreflightResult } from '@/lib/preflight';
import { KeyRound, ListChecks } from 'lucide-react';

/**
 * Onboarding step 3 — choose what to scan.
 *
 * Deliberately resolves entirely onto `rule.enabled`, not a new category-level flag: a second way to
 * switch a check off would need ambiguous precedence against the rule's own flag, and every reader
 * of category state (runCategoryScan, schedule-target, every widget/dashboard filter) would have to
 * learn about it. "All / High + critical only / None" per category is just three different
 * `enable`/`disable` id lists for `PATCH /api/rules/bulk`.
 *
 * Nothing here is applied automatically — the recommended tier is a badge, not a silent mutation, so
 * loading this step never changes what a scan does until the admin clicks a button.
 */

type Tier = 'all' | 'high' | 'none' | 'custom';

const RECOMMENDED_TIER: Record<string, Exclude<Tier, 'custom'>> = {
  cost: 'all',
  security: 'all',
  reliability: 'high',
  compliance: 'none',
};

const TIER_LABEL: Record<Exclude<Tier, 'custom'>, string> = {
  all: 'All',
  high: 'High + critical only',
  none: 'None',
};

function tierFor(enabledIds: Set<string>, allIds: string[], highIds: string[]): Tier {
  const enabledInCategory = allIds.filter(id => enabledIds.has(id));
  if (enabledInCategory.length === 0) return 'none';
  if (enabledInCategory.length === allIds.length) return 'all';
  const highSet = new Set(highIds);
  if (enabledInCategory.length === highIds.length && enabledInCategory.every(id => highSet.has(id))) return 'high';
  return 'custom';
}

export function ScopeStep({
  categories, ruleSummaries, onRuleSummariesChange, onBack, onNext,
}: {
  categories: Category[];
  ruleSummaries: OnboardingRuleSummary[];
  onRuleSummariesChange: (next: OnboardingRuleSummary[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [busyCategory, setBusyCategory] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<PreflightResult['subscriptions'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/diagnostics/preflight')
      .then(res => (res.ok ? res.json() as Promise<PreflightResult> : null))
      .then(body => { if (!cancelled && body) setSubscriptions(body.subscriptions); })
      .catch(() => { /* the panel just stays empty — this is informational, not blocking */ });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    const byCategory = new Map<string, OnboardingRuleSummary[]>();
    for (const r of ruleSummaries) {
      const list = byCategory.get(r.category);
      if (list) list.push(r); else byCategory.set(r.category, [r]);
    }
    const enabledIds = new Set(ruleSummaries.filter(r => r.enabled).map(r => r.id));

    return categories
      .filter(c => c.id !== 'identity')
      .map(c => {
        const catRules = byCategory.get(c.id) ?? [];
        const allIds = catRules.map(r => r.id);
        const highIds = catRules.filter(r => r.severity === 'critical' || r.severity === 'high').map(r => r.id);
        return {
          category: c,
          total: allIds.length,
          enabledCount: allIds.filter(id => enabledIds.has(id)).length,
          allIds,
          highIds,
          tier: tierFor(enabledIds, allIds, highIds),
        };
      });
  }, [categories, ruleSummaries]);

  const identityCategory = categories.find(c => c.id === 'identity');

  async function applyTier(categoryId: string, tier: Exclude<Tier, 'custom'>, allIds: string[], highIds: string[]) {
    const enable = tier === 'all' ? allIds : tier === 'high' ? highIds : [];
    const enableSet = new Set(enable);
    const disable = allIds.filter(id => !enableSet.has(id));

    setBusyCategory(categoryId);
    try {
      const res = await fetch('/api/rules/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable, disable }),
      });
      if (res.ok) {
        onRuleSummariesChange(ruleSummaries.map(r => (
          r.category === categoryId ? { ...r, enabled: enableSet.has(r.id) } : r
        )));
      }
    } finally {
      setBusyCategory(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="size-4 text-ink-muted" />
          Choose what to scan
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-2">
          Every check is a rule you can edit or disable later in the Library. This just sets a
          starting point per category.
        </p>

        <ul className="divide-y divide-border border border-border">
          {rows.map(row => (
            <li key={row.category.id} className="flex items-center justify-between gap-4 px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{row.category.label}</p>
                <p className="numeral-grid text-xs text-ink-2">{row.enabledCount} / {row.total} enabled</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {(['all', 'high', 'none'] as const).map(tier => (
                  <div key={tier} className="relative">
                    {RECOMMENDED_TIER[row.category.id] === tier && (
                      <span className="label-grid-strong absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap bg-surface px-1">
                        Recommended
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant={row.tier === tier ? 'default' : 'outline'}
                      disabled={busyCategory === row.category.id || row.total === 0}
                      onClick={() => void applyTier(row.category.id, tier, row.allIds, row.highIds)}
                    >
                      {TIER_LABEL[tier]}
                    </Button>
                  </div>
                ))}
              </div>
            </li>
          ))}
          {identityCategory && (
            <li className="flex items-center gap-3 px-3.5 py-3 text-ink-muted">
              <KeyRound className="size-4 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{identityCategory.label}</p>
                <p className="text-xs">Runs when Microsoft Graph access is available. See step 2.</p>
              </div>
            </li>
          )}
        </ul>

        {subscriptions && subscriptions.length > 0 && (
          <div className="border border-border bg-surface-sunken px-3.5 py-3">
            <p className="mb-1.5 text-xs font-medium text-ink">
              Scanning {subscriptions.length} subscription{subscriptions.length === 1 ? '' : 's'}
            </p>
            <p className="text-xs leading-relaxed text-ink-2">
              Scope is controlled by Azure RBAC, not a setting here. To narrow it, remove the Reader
              role assignment for the subscriptions you don&apos;t want scanned.
            </p>
          </div>
        )}

        <div className="flex justify-between border-t border-border pt-2">
          <Button variant="outline" onClick={onBack}>Back</Button>
          <Button onClick={onNext}>Continue</Button>
        </div>
      </CardContent>
    </Card>
  );
}
