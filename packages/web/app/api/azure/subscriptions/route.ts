import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getArmCredential } from '@/lib/arm';
import { SubscriptionClient } from '@azure/arm-resources-subscriptions';
import { AZURE_LIST_TIMEOUT_MS } from '@rulebeat/core';
import { isDemoMode } from '@/lib/demo';
import { DEMO_SUBSCRIPTIONS } from '@/lib/demo-fixtures';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  // Demo mode never touches Azure — resolveAzureCredential() would throw anyway (the chokepoint's
  // own kill switch, lib/azure-credential.ts) — but short-circuiting here means the subscription
  // picker degrades gracefully to the fixed demo list instead of surfacing an error where a
  // working picker belongs.
  if (isDemoMode()) return NextResponse.json(DEMO_SUBSCRIPTIONS);

  try {
    const credential = getArmCredential();
    const client = new SubscriptionClient(credential);

    const subs: { id: string; name: string }[] = [];
    for await (const sub of client.subscriptions.list({
      abortSignal: AbortSignal.timeout(AZURE_LIST_TIMEOUT_MS),
    })) {
      if (sub.subscriptionId && sub.state === 'Enabled') {
        subs.push({ id: sub.subscriptionId, name: sub.displayName ?? sub.subscriptionId });
      }
    }
    subs.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json(subs);
  } catch (err) {
    return serverError('Failed to list Azure subscriptions', err);
  }
}
