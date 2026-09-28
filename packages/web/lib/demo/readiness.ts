// What this process knows about its running Demo, held on globalThis so every module instance
// Next.js creates sees the same value. No imports on purpose: /api/health and the banner read it,
// and neither should open the database or load the Reset machinery to do so.

type DemoRuntimeGlobals = {
  __rulebeatDemoReady?: boolean;
  __rulebeatDemoNextResetAt?: string;
};

function runtime(): DemoRuntimeGlobals {
  return globalThis as typeof globalThis & DemoRuntimeGlobals;
}

/** Called once the Demo's snapshot exists and the live database has been restored from it. */
export function markDemoReady(): void {
  runtime().__rulebeatDemoReady = true;
}

/** Whether this process has finished preparing its Demo. */
export function isDemoReady(): boolean {
  return runtime().__rulebeatDemoReady === true;
}

/** Records when the Reset timer fires next (./live-reset.ts). */
export function setNextDemoResetAt(at: Date | null): void {
  runtime().__rulebeatDemoNextResetAt = at?.toISOString();
}

/** When the timer will next reset the Demo, or null when the timer is off. */
export function getNextDemoResetAt(): Date | null {
  const at = runtime().__rulebeatDemoNextResetAt;
  return at ? new Date(at) : null;
}
