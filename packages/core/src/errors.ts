/**
 * Azure SDK errors nest their actionable message under `err.details[0].message` or
 * `err.response.parsedBody.error.message` — the outer `err.message` is often a generic wrapper
 * ("Please provide below info...") that says nothing about what actually went wrong. This is the
 * same unwrapping `packages/web/app/api/rules/validate-kql/route.ts` already did locally for the one
 * case it cared about (a 400, safe to show a user); this version has no status-code gate, since it
 * only ever reaches a server log, never the browser.
 */
export function extractAzureErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as unknown as Record<string, unknown>;

  const details = (e['details'] ?? (e['response'] as Record<string, unknown> | undefined)?.['parsedBody']) as unknown;
  if (Array.isArray(details) && details.length > 0) {
    const inner = (details[0] as Record<string, unknown>)['message'];
    if (typeof inner === 'string' && inner) return inner;
  }

  const body = ((e['response'] as Record<string, unknown> | undefined)?.['parsedBody'] as Record<string, unknown> | undefined)?.['error'] as Record<string, unknown> | undefined;
  if (typeof body?.['message'] === 'string') return body['message'] as string;

  return err.message;
}
