import { useEffect, useState } from 'react';

/** Subscription id → display name — findings/summaries only ever store the raw GUID (that's
 *  what ARG returns), so the friendly name has to come from a live ARM call. Shared by every
 *  surface that labels a subscription filter/chip. */
export function useSubscriptionNames(): Record<string, string> {
  const [subNames, setSubNames] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch('/api/azure/subscriptions')
      .then(r => r.ok ? r.json() : [])
      .then((subs: { id: string; name: string }[]) => {
        setSubNames(Object.fromEntries(subs.map(s => [s.id, s.name])));
      })
      .catch(() => {});
  }, []);

  return subNames;
}
