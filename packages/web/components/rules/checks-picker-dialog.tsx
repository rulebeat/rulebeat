'use client';

import { Server, Users, ScrollText, X } from 'lucide-react';
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle, DialogViewport } from '@/components/ui/dialog';
import type { QueryBackend } from '@/lib/types';

interface Props {
  onSelect: (backend: QueryBackend) => void;
  onClose: () => void;
  /** Why Directory objects are unavailable to this person (no Directory Scope): the option is shown disabled with it. */
  directoryUnavailable?: string;
}

const OPTIONS = [
  {
    id: 'resource-graph',
    icon: Server,
    label: 'Resource configuration',
    description: 'Azure resource settings and properties, queried with Resource Graph.',
    enabled: true,
  },
  {
    id: 'microsoft-graph',
    icon: Users,
    label: 'Directory objects',
    description: 'Users, apps, and other Microsoft Entra ID objects.',
    enabled: true,
  },
  {
    id: 'log-analytics',
    icon: ScrollText,
    label: 'Logs & activity',
    description: 'Events over time, queried with Log Analytics.',
    enabled: false,
  },
] as const;

/**
 * Shown before RuleForm on the /rules/new path (spec 029). Resource Graph and Directory objects
 * (Microsoft Graph) are authorable; Log Analytics is paused (spec 038) pending multi-workspace
 * targeting and a GUI builder: it only supports one tenant-wide workspace today. Directory objects
 * are disabled, with the reason, for someone without the Directory Scope.
 */
export function ChecksPickerDialog({ onSelect, onClose, directoryUnavailable }: Props) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport className="items-center justify-center">
          <DialogPopup className="mx-4 w-full max-w-md">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <DialogTitle className="text-sm font-semibold text-ink">What does this rule check?</DialogTitle>
              <DialogClose aria-label="Close" className="p-1 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink">
                <X className="size-4" />
              </DialogClose>
            </div>
            <div className="space-y-2 px-5 py-5">
              {OPTIONS.map(opt => {
                const Icon = opt.icon;
                const reason = opt.id === 'microsoft-graph' ? directoryUnavailable : undefined;
                const enabled = opt.enabled && !reason;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={!enabled}
                    onClick={() => { if (enabled) onSelect(opt.id); }}
                    className={
                      enabled
                        ? 'flex w-full items-start gap-3 border border-rule-strong bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-hover'
                        : 'flex w-full cursor-not-allowed items-start gap-3 border border-transparent bg-surface-sunken px-3.5 py-3 text-left opacity-60'
                    }
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-ink-2" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-ink">{opt.label}</p>
                        {!opt.enabled && (
                          <span className="label-grid shrink-0 whitespace-nowrap bg-surface px-1.5 py-0.5 text-ink-faint">Coming soon</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{opt.description}</p>
                      {reason && <p className="mt-1 text-xs leading-relaxed text-ink">{reason}</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
