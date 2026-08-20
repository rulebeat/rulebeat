'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Suppression } from '@/lib/types';
import { EyeOff, Trash2, Clock, CheckCircle2, AlertCircle, Copy, Check } from 'lucide-react';

function isExpired(s: Suppression): boolean {
  return !!s.expiresAt && new Date(s.expiresAt) <= new Date();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="shrink-0 p-0.5 transition-colors hover:bg-surface-hover"
      title="Copy resource ID"
    >
      {copied ? <Check className="size-3 text-status-ok" /> : <Copy className="size-3 text-ink-muted" />}
    </button>
  );
}

interface Props {
  initialSuppressions: Suppression[];
  canEdit: boolean;
}

export function SuppressionsClient({ initialSuppressions, canEdit }: Props) {
  const [suppressions, setSuppressions] = useState(initialSuppressions);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showExpired, setShowExpired] = useState(false);

  const active = suppressions.filter(s => !isExpired(s));
  const expired = suppressions.filter(s => isExpired(s));
  const visible = showExpired ? suppressions : active;

  async function remove(id: string) {
    setRemoving(id);
    try {
      await fetch(`/api/suppressions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setSuppressions(prev => prev.filter(s => s.id !== id));
    } finally {
      setRemoving(null);
    }
  }

  if (suppressions.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-20 text-center gap-3">
          <div className="flex size-12 items-center justify-center border border-border bg-surface-sunken">
            <EyeOff className="size-6 text-ink-faint" />
          </div>
          <p className="text-sm font-medium text-ink">No suppressions</p>
          <p className="max-w-xs text-sm text-ink-muted">
            When you suppress a finding from a scan page, it will appear here. Suppressions hide acknowledged issues from your active findings count.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <p className="text-sm text-ink-muted">
            <span className="numeral-grid font-medium text-ink">{active.length}</span> active suppression{active.length !== 1 ? 's' : ''}
            {expired.length > 0 && `, ${expired.length} expired`}
          </p>
          {expired.length > 0 && (
            <button
              onClick={() => setShowExpired(s => !s)}
              className="text-xs text-ink-2 transition-colors hover:text-ink"
            >
              {showExpired ? 'Hide expired' : 'Show expired'}
            </button>
          )}
        </div>
        {expired.length > 0 && canEdit && (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              for (const s of expired) await remove(s.id);
            }}
          >
            <Trash2 className="size-3.5" />
            Clear expired
          </Button>
        )}
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">All suppressions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {visible.map(s => {
              const expired = isExpired(s);
              return (
                <div
                  key={s.id}
                  className={`flex items-start gap-4 px-6 py-4 ${expired ? 'opacity-50' : 'hover:bg-surface-hover'} transition-colors`}
                >
                  {/* Status icon */}
                  <div className="shrink-0 mt-0.5">
                    {expired
                      ? <AlertCircle className="size-4 text-status-warn" />
                      : <CheckCircle2 className="size-4 text-ink-muted" />}
                  </div>

                  {/* Main content */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-sm font-medium text-ink">{s.reason}</p>
                    <div className="flex items-center gap-1.5 font-mono text-xs text-ink">
                      {/* Absent resourceId means this suppresses an 'activity' finding pattern
                          (spec 034), which has no resource — the fingerprint is the only stored
                          identifier for it. */}
                      <span className="truncate max-w-[400px]">{s.resourceId ?? s.fingerprint}</span>
                      <CopyButton text={s.resourceId ?? s.fingerprint} />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-ink-muted">
                      <span className="flex items-center gap-1">
                        <Clock className="size-3" />
                        Suppressed {formatDate(s.suppressedAt)}
                      </span>
                      {s.expiresAt && (
                        <span className={expired ? 'text-status-warn' : ''}>
                          {expired ? 'Expired' : 'Expires'} {formatDate(s.expiresAt)}
                        </span>
                      )}
                      {!s.expiresAt && (
                        <span>No expiry</span>
                      )}
                    </div>
                  </div>

                  {/* Remove */}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      disabled={removing === s.id}
                      onClick={() => remove(s.id)}
                      title="Remove suppression"
                    >
                      <Trash2 className="size-3.5 text-ink-muted" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
