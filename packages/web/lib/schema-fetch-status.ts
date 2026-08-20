export type SchemaFetchOutcome = 'ok' | 'not-found' | 'unavailable';

/**
 * Classifies an HTTP outcome from the resource-type/property schema routes so callers can tell "this
 * type genuinely has no schema" (404) apart from "Azure was unreachable" (anything else non-ok) —
 * both currently collapse to the same "empty" rendering on the client. A thrown/rejected fetch has no
 * status to classify; call sites map that case to 'unavailable' directly.
 */
export function classifySchemaStatus(ok: boolean, status: number): SchemaFetchOutcome {
  if (ok) return 'ok';
  if (status === 404) return 'not-found';
  return 'unavailable';
}
