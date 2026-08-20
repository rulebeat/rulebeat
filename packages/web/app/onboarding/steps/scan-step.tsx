'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { useRunProgress } from '@/lib/hooks/use-run-progress';
import { Loader2, PlayCircle } from 'lucide-react';

/**
 * Onboarding step 4 — run the first scan and land on a real result.
 *
 * `run.error` is never rendered: it's `errors.join('; ')` built from raw Azure/Graph error strings
 * (see `run-executor.ts`), including the `Graph API 403: <body>` case. Nothing in the product renders
 * it today and this must not become the first place — partial/error states show a count instead and
 * point at Run History.
 */
export function ScanStep({ onBack, onFinish, busy }: { onBack: () => void; onFinish: () => Promise<void>; busy: boolean }) {
  const router = useRouter();
  const { phase, run, elapsedMs, start } = useRunProgress();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setStarting(true); setError(null);
    try {
      const res = await fetch('/api/scans/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType: 'all' }),
      });
      const body = await res.json() as { requestedAt?: string; error?: string };
      if (!res.ok || !body.requestedAt) { setError(body.error ?? 'Could not start the scan.'); return; }
      start(body.requestedAt);
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally {
      setStarting(false);
    }
  }

  async function handleSeeResults() {
    await onFinish();
    router.push('/scans?tab=results');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlayCircle className="size-4 text-ink-muted" />
          Run your first scan
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Callout tone="error">{error}</Callout>}

        {phase === 'idle' && (
          <>
            <p className="text-sm leading-relaxed text-ink-2">
              Scans every subscription this credential can see, using whatever categories you enabled
              in the last step.
            </p>
            <Button onClick={() => void handleRun()} disabled={starting}>
              {starting ? <Loader2 className="size-3.5 animate-spin" /> : <PlayCircle className="size-3.5" />}
              Run scan
            </Button>
          </>
        )}

        {(phase === 'waiting' || phase === 'running') && (
          <div className="flex items-center gap-2 py-4 text-sm text-ink-muted">
            <Loader2 className="size-4 animate-spin" />
            {phase === 'waiting' ? 'Waiting for the current scan to finish…' : 'Scanning…'}
            <span className="numeral-grid text-xs">({Math.round(elapsedMs / 1000)}s)</span>
          </div>
        )}

        {phase === 'timeout' && (
          <Callout tone="warn">
            Still running in the background. This can take a while on a large tenant. Check Run
            History for the result.
          </Callout>
        )}

        {phase === 'done' && run && (
          run.status === 'success' ? (
            <Callout tone="success">
              Found {run.totalFindings} finding{run.totalFindings === 1 ? '' : 's'}
              {run.newFindings > 0 ? ` (${run.newFindings} new)` : ''} across {run.categories.length}{' '}
              categor{run.categories.length === 1 ? 'y' : 'ies'}.
            </Callout>
          ) : (
            <Callout tone="warn">
              {run.status === 'partial'
                ? `Finished with some categories failing. Found ${run.totalFindings} finding${run.totalFindings === 1 ? '' : 's'} from the rest.`
                : 'The scan did not complete.'}{' '}
              See Run History for details.
            </Callout>
          )
        )}

        <div className="flex justify-between border-t border-border pt-2">
          <Button variant="outline" onClick={onBack} disabled={phase === 'waiting' || phase === 'running'}>
            Back
          </Button>
          {phase === 'done' ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void onFinish()} disabled={busy}>Finish</Button>
              <Button onClick={() => void handleSeeResults()} disabled={busy}>See what we found</Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => void onFinish()} disabled={busy}>Finish later</Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
