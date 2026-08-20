'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import type { PreflightResult } from '@/lib/preflight';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { PreflightChecks } from '@/components/diagnostics/preflight-checks';

/**
 * Onboarding step 2 — runs `lib/preflight.ts` via `GET /api/diagnostics/preflight` and shows plainly
 * what the connected identity can and can't see. Never blocking: RuleBeat's whole positioning is
 * guided visibility, not a firewall, so Continue stays available regardless of what this finds.
 */
export function PreflightStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/diagnostics/preflight');
      const body = await res.json() as PreflightResult & { error?: string };
      if (!res.ok) { setError(body.error ?? 'Could not run the checks.'); return; }
      setResult(body);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally { setLoading(false); }
  }

  // Mount-triggered fetch of the connected identity's real access — an external-system read,
  // not derivable render state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void run(); }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-ink-muted" />
          Verify access
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Re-run checks
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-2">
          What this identity can actually reach: Azure Resource Graph, subscriptions, and optionally
          Microsoft Graph for identity checks. See{' '}
          <span className="font-mono text-ink">docs/public/permissions.md</span> if anything below
          needs fixing.
        </p>

        {error && <Callout tone="error">{error}</Callout>}

        {loading && !result && (
          <div className="flex items-center gap-2 py-4 text-sm text-ink-muted">
            <Loader2 className="size-4 animate-spin" />
            Running checks…
          </div>
        )}

        {result && <PreflightChecks result={result} />}

        <div className="flex justify-between border-t border-border pt-2">
          <Button variant="outline" onClick={onBack}>Back</Button>
          <Button onClick={onNext} disabled={loading}>Continue</Button>
        </div>
      </CardContent>
    </Card>
  );
}
