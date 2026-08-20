'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleRun } from '@/lib/schedule-runs';

/**
 * Polls `GET /api/scans/run?since=...` until the run this caller triggered finishes.
 *
 * `run: null` genuinely means "no run matching `since` yet" — the busy flag a scan holds can belong
 * to a scheduled run that started moments earlier, so 'waiting' is a real, visible state rather than
 * an instant flash. A 10-minute ceiling exists because scans on a large tenant can run long; past it
 * this reports 'timeout' rather than pretending the scan failed — it's still running in the background.
 */

export type RunProgressPhase = 'idle' | 'waiting' | 'running' | 'done' | 'timeout';

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;

export interface UseRunProgressResult {
  phase: RunProgressPhase;
  run: ScheduleRun | null;
  elapsedMs: number;
  /** Begin polling. `requestedAt` should be the server-clock timestamp from the triggering POST. */
  start: (requestedAt: string) => void;
}

export function useRunProgress(): UseRunProgressResult {
  const [phase, setPhase] = useState<RunProgressPhase>('idle');
  const [run, setRun] = useState<ScheduleRun | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const sinceRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimers = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (tickTimer.current) clearInterval(tickTimer.current);
    pollTimer.current = null;
    tickTimer.current = null;
  }, []);

  useEffect(() => stopTimers, [stopTimers]);

  const poll = useCallback(async () => {
    try {
      const since = sinceRef.current;
      const url = since ? `/api/scans/run?since=${encodeURIComponent(since)}` : '/api/scans/run';
      const res = await fetch(url);
      if (!res.ok) return;
      const body = await res.json() as { run: ScheduleRun | null };

      if (!body.run) {
        setPhase(p => (p === 'timeout' ? p : 'waiting'));
        setRun(null);
        return;
      }
      setRun(body.run);
      if (body.run.status === 'running') {
        setPhase('running');
      } else {
        setPhase('done');
        stopTimers();
      }
    } catch {
      // A transient fetch failure shouldn't stop the wait — the next tick tries again.
    }
  }, [stopTimers]);

  const start = useCallback((requestedAt: string) => {
    stopTimers();
    sinceRef.current = requestedAt;
    startedAtRef.current = Date.now();
    setPhase('waiting');
    setRun(null);
    setElapsedMs(0);

    void poll();
    pollTimer.current = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    tickTimer.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= TIMEOUT_MS) {
        setPhase(p => (p === 'done' ? p : 'timeout'));
        stopTimers();
      }
    }, 1000);
  }, [poll, stopTimers]);

  return { phase, run, elapsedMs, start };
}
