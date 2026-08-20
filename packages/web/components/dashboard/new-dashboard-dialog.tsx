'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { X, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle, DialogViewport } from '@/components/ui/dialog';

interface Props {
  onClose: () => void;
}

export function NewDashboardDialog({ onClose }: Props) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) { setError('Please enter a name.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/dashboards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, config: { autoRefresh: 0, widgets: [] } }),
      });
      const data = await res.json() as { error?: string; id?: string };
      if (!res.ok) { setError(data.error ?? 'Failed to create dashboard.'); return; }
      onClose();
      router.push(`/dashboards/${(data as { id: string }).id}`);
      router.refresh();
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
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <LayoutDashboard className="size-4 shrink-0 text-ink" />
                <DialogTitle className="text-sm font-semibold text-ink">New dashboard</DialogTitle>
              </div>
              <DialogClose aria-label="Close" className="p-1 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink">
                <X className="size-4" />
              </DialogClose>
            </div>

            {/* Body */}
            <div className="space-y-4 px-5 py-5">
              <div className="space-y-1.5">
                <Label htmlFor="new-dashboard-name">Dashboard name</Label>
                <Input
                  id="new-dashboard-name"
                  ref={inputRef}
                  type="text"
                  value={name}
                  onChange={e => { setName(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                  placeholder="e.g. Security Overview"
                />
                {error && <p className="text-xs font-medium text-sev-critical">{error}</p>}
              </div>

              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>
                  Cancel
                </Button>
                <Button className="flex-1" onClick={handleCreate} disabled={saving || !name.trim()}>
                  {saving ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </div>
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
