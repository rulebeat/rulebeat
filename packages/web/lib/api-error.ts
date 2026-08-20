import { NextResponse } from 'next/server';

/**
 * Turns an unexpected failure into a client-safe error response.
 *
 * Azure SDK errors are not safe to hand to a browser: they carry the full request URL (tenant and
 * subscription ids), correlation ids, and on credential failures a description of which identity
 * sources were tried. Returning them verbatim puts that in devtools, in screenshots pasted into
 * support threads, and in front of Viewers — who are only meant to read findings.
 *
 * The full error goes to the server log, where an operator can already see everything anyway, and
 * the caller gets a stable message naming the operation that failed.
 *
 * Do NOT use this for errors the user is meant to act on — a KQL syntax error belongs in the
 * response, since the user is the only one who can fix it. See `extractAzureError` in
 * `app/api/rules/validate-kql/route.ts`.
 */
export function serverError(operation: string, err: unknown, status = 500): NextResponse {
  console.error(`[RuleBeat] ${operation}:`, err);
  return NextResponse.json(
    { error: `${operation}. Check the RuleBeat server logs for details.` },
    { status },
  );
}

/**
 * Like `serverError`, but lets one specific failure through: "no Azure credential is configured".
 *
 * That message is safe (it names no tenant, subscription or identity) and it is the only Azure
 * failure the person reading it can actually fix from the UI — telling an admin to check the server
 * logs when the real answer is "you haven't connected Azure yet" is how a 15-minute install turns
 * into an hour. Everything else still goes through `serverError`.
 *
 * Matched on the error's `code` rather than `instanceof` so this module stays free of database
 * imports — every API route imports it, and `lib/azure-credential.ts` opens the database.
 */
export function azureError(operation: string, err: unknown): NextResponse {
  if (err instanceof Error && (err as { code?: string }).code === 'azure_not_configured') {
    return NextResponse.json({ error: err.message, code: 'azure_not_configured' }, { status: 503 });
  }
  return serverError(operation, err);
}

/**
 * The client-safe half of an Azure failure, for places that report per-item outcomes rather than
 * failing the whole request. Logs the detail, returns a one-line summary.
 */
export function safeErrorMessage(operation: string, err: unknown): string {
  console.error(`[RuleBeat] ${operation}:`, err);
  return 'Request to Azure failed. Check the RuleBeat server logs for details.';
}
