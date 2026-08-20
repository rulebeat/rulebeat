'use client';

import { useRef, useState } from 'react';
import { X, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle, DialogViewport } from '@/components/ui/dialog';
import type { QueryVisibility } from '@/lib/types';

interface Props {
  onClose: () => void;
  // Returns an error message to display, or null on success.
  onSave: (name: string, visibility: QueryVisibility) => Promise<string | null>;
}

export function SaveQueryDialog({ onClose, onSave }: Props) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<QueryVisibility>('private');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) { setError('Please enter a name.'); return; }
    setSaving(true);
    setError('');
    try {
      const err = await onSave(trimmed, visibility);
      if (err) { setError(err); return; }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport className="items-center justify-center">
          <DialogPopup initialFocus={inputRef} className="mx-4 w-full max-w-sm">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <Save className="size-4 shrink-0 text-ink" />
                <DialogTitle className="text-sm font-semibold text-ink">Save query</DialogTitle>
              </div>
              <DialogClose aria-label="Close" className="p-1 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink">
                <X className="size-4" />
              </DialogClose>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="space-y-1.5">
                <Label htmlFor="save-query-name">Name</Label>
                <Input
                  id="save-query-name"
                  ref={inputRef}
                  type="text"
                  value={name}
                  onChange={e => { setName(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
                  placeholder="e.g. Public storage accounts"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Visibility</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={visibility === 'private' ? 'default' : 'outline'}
                    className="flex-1"
                    onClick={() => setVisibility('private')}
                  >
                    Private
                  </Button>
                  <Button
                    type="button"
                    variant={visibility === 'shared' ? 'default' : 'outline'}
                    className="flex-1"
                    onClick={() => setVisibility('shared')}
                  >
                    Shared
                  </Button>
                </div>
                <p className="text-xs text-ink-muted">
                  {visibility === 'private'
                    ? 'Only you can see this query.'
                    : 'Everyone with access to RuleBeat can see and run this query.'}
                </p>
              </div>

              {error && <p className="text-xs font-medium text-sev-critical">{error}</p>}

              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>
                  Cancel
                </Button>
                <Button className="flex-1" onClick={handleSave} disabled={saving || !name.trim()}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
