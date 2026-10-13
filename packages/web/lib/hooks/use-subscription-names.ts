import { useEffect, useState } from 'react';
import { DIRECTORY_LABEL, DIRECTORY_SUBSCRIPTION } from '../placement';

/** Subscription id → display name: findings/summaries only ever store the raw GUID (that's
 *  what ARG returns), so the friendly name has to come from a live ARM call. Shared by every
 *  surface that labels a subscription filter/chip. The reserved Directory value is named from the
 *  first render, since no ARM call knows it. */
export function useSubscriptionNames(): Record<string, string> {
  const [subNames, setSubNames] = useState<Record<string, string>>({ [DIRECTORY_SUBSCRIPTION]: DIRECTORY_LABEL });

  useEffect(() => {
    fetch('/api/azure/subscriptions')
      .then(r => r.ok ? r.json() : [])
      .then((subs: { id: string; name: string }[]) => {
        setSubNames({ [DIRECTORY_SUBSCRIPTION]: DIRECTORY_LABEL, ...Object.fromEntries(subs.map(s => [s.id, s.name])) });
      })
      .catch(() => {});
  }, []);

  return subNames;
}
