import type { LogFields } from '@rulebeat/core';

export interface ScanLogContext {
  runId?: string;
}

/**
 * The one place a real (non-fake) `TenantContext.log` writes to. stdout only — see spec 006's
 * "Explicitly out of scope": no persistence, no retention policy, that's the paid-tier audit/SIEM
 * roadmap item, not this. `context` (e.g. `runId`) is closed over at construction time so every
 * call site doesn't have to keep re-passing it.
 */
export function createScanLogger(context: ScanLogContext = {}): (message: string, fields?: LogFields) => void {
  return (message, fields) => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: fields?.level ?? 'info',
      ...context,
      ...fields,
      message,
    }));
  };
}
