'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  ruleId: string;
  /** Why the copy is unavailable, worked out on the server; null when it is available. */
  blockedReason: string | null;
  /** Receives a failure message. Without it the button shows the message beside itself. */
  onError?: (message: string | null) => void;
  /** An icon-only button, as the Library rows use. */
  iconOnly?: boolean;
}

/** Copies a shared rule into the signed-in person's Personal rules, then opens the copy. */
export function CopyToPersonalButton({ ruleId, blockedReason, onError, iconOnly = false }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const report = (message: string | null) => (onError ? onError(message) : setLocalError(message));

  async function copy() {
    setBusy(true);
    report(null);
    try {
      const res = await fetch(`/api/rules/${encodeURIComponent(ruleId)}/personal-copy`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        report(body?.error ?? 'The rule was not copied.');
        return;
      }
      const created = await res.json() as { id: string };
      router.push(`/library/personal/${encodeURIComponent(created.id)}`);
    } catch {
      report('The rule was not copied. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const label = 'Copy to personal';
  const icon = busy ? <Loader2 className="size-3.5 animate-spin" /> : <UserRound className="size-3.5" />;
  return (
    <>
      {iconOnly ? (
        <Button
          variant="ghost" size="icon-sm"
          title={blockedReason ?? label}
          aria-label={label}
          disabled={blockedReason !== null || busy}
          onClick={() => { void copy(); }}
        >
          {icon}
        </Button>
      ) : (
        <Button
          variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1.5"
          title={blockedReason ?? undefined}
          disabled={blockedReason !== null || busy}
          onClick={() => { void copy(); }}
        >
          {icon}
          {label}
        </Button>
      )}
      {localError && <span role="alert" className="text-xs text-destructive">{localError}</span>}
    </>
  );
}
