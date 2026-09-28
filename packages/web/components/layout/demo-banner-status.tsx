'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

/** Where this browser remembers the last Reset it saw, so it can tell a Visitor once that the Demo
 *  was reset since their last visit. Per browser, like the Visitor. */
const SEEN_RESET_KEY = 'rulebeat-demo-seen-reset';
const NOTICE_MS = 60_000;

function readSeenReset(): string | null {
  try {
    return window.localStorage.getItem(SEEN_RESET_KEY);
  } catch {
    return null;
  }
}

function writeSeenReset(value: string): void {
  try {
    window.localStorage.setItem(SEEN_RESET_KEY, value);
  } catch { /* storage blocked: the notice just shows again next time */ }
}

const TICK_MS = 15_000;

// The countdown's clock, as an external store: a time that moves every TICK_MS, and none on the
// server, so the server renders the plain sentence and the browser fills in the countdown.
function subscribeToClock(onTick: () => void): () => void {
  const tick = setInterval(onTick, TICK_MS);
  return () => clearInterval(tick);
}
// Rounded up, so the countdown can run a little short but never promises more time than there is.
const clockSnapshot = () => Math.ceil(Date.now() / TICK_MS) * TICK_MS;
const serverClockSnapshot = () => null;

/** "in 23 minutes", counted down to the Reset. */
export function describeNextReset(nextResetAt: Date, now: Date): string {
  const minutes = Math.ceil((nextResetAt.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'It resets any moment now.';
  if (minutes === 1) return 'It resets in under a minute.';
  if (minutes < 120) return `It resets in ${minutes} minutes.`;
  return `It resets in ${Math.round(minutes / 60)} hours.`;
}

export function DemoBannerStatus({ resetAt, nextResetAt }: { resetAt: string | null; nextResetAt: string | null }) {
  const now = useSyncExternalStore(subscribeToClock, clockSnapshot, serverClockSnapshot);
  // Depends on this browser's storage, so it is worked out after hydration.
  const [wasReset, setWasReset] = useState(false);

  useEffect(() => {
    if (!resetAt) return;
    const seen = readSeenReset();
    // A browser that has never been here has nothing to have lost, so it gets no notice.
    writeSeenReset(resetAt);
    if (seen === null || seen === resetAt) return;
    const show = setTimeout(() => setWasReset(true), 0);
    // The layout stays mounted across navigation, so the notice steps aside on its own.
    const hide = setTimeout(() => setWasReset(false), NOTICE_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [resetAt]);

  if (wasReset) {
    return (
      <span role="status" className="opacity-90">
        This Demo was reset since your last visit, so changes made before then are gone.
      </span>
    );
  }

  return (
    <span className="opacity-75">
      Synthetic data, shared by every Visitor.{' '}
      {nextResetAt && now !== null ? describeNextReset(new Date(nextResetAt), new Date(now)) : nextResetAt ? '' : 'It returns to its starting state on restart.'}
    </span>
  );
}
