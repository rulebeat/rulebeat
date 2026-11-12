'use client';

import { useEffect, useState } from 'react';
import { UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle, DialogViewport,
} from '@/components/ui/dialog';
import type { ItemKind } from '@/lib/item-access-model';
import {
  fetchHandOverCandidates, requestHandOver, requestTakeOver, type HandOverPerson,
} from '@/lib/item-transfer-client';

const NOUN: Record<ItemKind, string> = { dashboard: 'dashboard', view: 'saved view' };

interface Props {
  kind: ItemKind;
  mode: 'hand-over' | 'take-over';
  id: string;
  name: string;
  onClose: () => void;
  /** Called with the item the server answered with, after the change was accepted. */
  onDone: (item: unknown) => void;
}

/**
 * The Hand over picker and the Take over confirmation for one Shared dashboard or saved view. The picker lists
 * the people the server offers, each by name and email and nothing else, and the server checks the choice again.
 */
export function ItemTransferDialog({ kind, mode, id, name, onClose, onDone }: Props) {
  const handOver = mode === 'hand-over';
  const noun = NOUN[kind];
  const [people, setPeople] = useState<HandOverPerson[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!handOver) return;
    let live = true;
    fetchHandOverCandidates(kind, id).then(result => {
      if (!live) return;
      if (result.ok) setPeople(result.people);
      else { setPeople([]); setError(result.error); }
    });
    return () => { live = false; };
  }, [handOver, kind, id]);

  async function submit() {
    if (handOver && !chosen) return;
    setBusy(true);
    setError('');
    try {
      const outcome = handOver && chosen ? await requestHandOver(kind, id, chosen) : await requestTakeOver(kind, id);
      if (!outcome.ok) { setError(outcome.error); return; }
      onDone(outcome.item);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={isOpen => { if (!isOpen) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport className="items-center justify-center">
          <DialogPopup className="mx-4 w-full max-w-sm">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <UserRound className="size-4 shrink-0 text-ink" />
                <DialogTitle className="text-sm font-semibold text-ink">
                  {handOver ? `Hand over ${noun}` : `Take over ${noun}`}
                </DialogTitle>
              </div>
              <DialogClose aria-label="Close" className="p-1 text-ink-2 transition-colors hover:bg-surface-hover hover:text-ink">
                <X className="size-4" />
              </DialogClose>
            </div>

            <div className="space-y-4 px-5 py-5">
              <p className="text-xs text-ink-2">
                {handOver
                  ? `Choose who becomes the owner of "${name}". It stays Shared and nobody is notified.`
                  : `Make yourself the owner of "${name}"? It stays Shared and nobody is notified.`}
              </p>

              {handOver && people === null && <p className="text-sm text-ink-2">Loading people.</p>}
              {handOver && people !== null && people.length === 0 && !error && (
                <p className="text-sm text-ink-2">No one else holds an Editor Role or is an Admin, so there is no one to hand it to.</p>
              )}
              {handOver && people !== null && people.length > 0 && (
                <div role="radiogroup" aria-label="New owner" className="max-h-64 divide-y divide-border overflow-y-auto bg-surface-sunken">
                  {people.map(person => (
                    <label key={person.id} className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-surface-hover">
                      <input
                        type="radio"
                        name="new-owner"
                        checked={chosen === person.id}
                        onChange={() => { setChosen(person.id); setError(''); }}
                        className="mt-0.5 size-4 shrink-0 accent-ink"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink">{person.displayName}</span>
                        {person.email !== person.displayName && <span className="block truncate text-xs text-ink-2">{person.email}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {error && <p className="text-xs font-medium text-sev-critical">{error}</p>}

              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button className="flex-1" onClick={submit} disabled={busy || (handOver && !chosen)}>
                  {busy ? (handOver ? 'Handing over…' : 'Taking over…') : (handOver ? 'Hand over' : 'Take over')}
                </Button>
              </div>
            </div>
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
