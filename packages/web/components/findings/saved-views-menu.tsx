'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import {
  Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle, DialogViewport,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchJson } from '@/lib/fetch-json';
import { MAX_SAVED_VIEW_NAME_LENGTH, type SavedView, type SavedViewTab } from '@/lib/saved-view-query';
import { requestSavedViewChange, upsertSavedView, type SavedViewChange } from '@/lib/saved-view-actions';

interface SavedViewsMenuProps {
  /** Which tab the explorer is on: only that tab's views are listed, and a new view opens there. */
  tab: SavedViewTab;
  /** Whether the viewer may save, update, rename and delete. Everyone can open a view. */
  canWrite: boolean;
  /** The view the URL says is open, if any. */
  openId: string | null;
  /** Asks for the URL's open view to change: set after a save, cleared after a delete or when the
   *  open view is gone. */
  onOpenIdChange: (id: string | null) => void;
  /** Opens a saved view. */
  onOpen: (view: SavedView) => void;
  /** The explorer's current View as the query a saved view stores. */
  currentQuery: string;
}

/** What the dialog is for. */
type ViewAction = 'save' | 'update' | 'rename' | 'delete';
interface SavedViewsState { status: 'loading' | 'error' | 'ready'; views: SavedView[] }

export function SavedViewsMenu({ tab, canWrite, openId, onOpenIdChange, onOpen, currentQuery }: SavedViewsMenuProps) {
  const [state, setState] = useState<SavedViewsState>({ status: 'loading', views: [] });
  const [reloadKey, setReloadKey] = useState(0);
  const [action, setAction] = useState<ViewAction | null>(null);

  useEffect(() => {
    let live = true;
    fetchJson<SavedView[]>('/api/views').then(result => {
      if (!live) return;
      setState(prev => (result.ok ? { status: 'ready', views: result.data } : { status: 'error', views: prev.views }));
    });
    return () => { live = false; };
  }, [reloadKey]);

  const views = state.views.filter(v => v.tab === tab);
  const open = views.find(v => v.id === openId) ?? null;

  // A view someone else deleted, or a stale link, leaves nothing to update or rename.
  useEffect(() => {
    if (state.status === 'ready' && openId && !open) onOpenIdChange(null);
  }, [state.status, openId, open, onOpenIdChange]);

  /** Makes the change, then mirrors it in the list and the URL. Returns the message to show, or
   *  null when it worked. */
  async function applyAction(kind: ViewAction, name: string): Promise<string | null> {
    let change: SavedViewChange;
    if (kind === 'save') change = { kind: 'create', fields: { name, tab, query: currentQuery } };
    else if (!open) return null;
    else if (kind === 'rename') change = { kind: 'update', id: open.id, fields: { name } };
    else if (kind === 'update') change = { kind: 'update', id: open.id, fields: { query: currentQuery } };
    else change = { kind: 'delete', id: open.id };

    const outcome = await requestSavedViewChange(change);
    if (!outcome.ok) return outcome.error;
    if (outcome.view) {
      const stored = outcome.view;
      setState(prev => ({ status: prev.status, views: upsertSavedView(prev.views, stored) }));
      if (kind === 'save') onOpenIdChange(stored.id);
    } else {
      setState(prev => ({ status: prev.status, views: prev.views.filter(v => v.id !== open?.id) }));
      onOpenIdChange(null);
    }
    return null;
  }

  return (
    <>
      <DropdownMenu onOpenChange={isOpen => { if (isOpen) setReloadKey(k => k + 1); }}>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="max-w-56 gap-1.5" title={open ? `Saved view: ${open.name}` : undefined}>
              <Bookmark />
              <span className="truncate">{open ? open.name : 'Views'}</span>
              <ChevronDown />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          {state.status === 'loading' && views.length === 0 && (
            <p className="px-3 py-1.5 text-sm text-ink-2">Loading saved views.</p>
          )}
          {state.status === 'error' && (
            <>
              <p className="px-3 py-1.5 text-sm text-ink-2">Saved views could not be loaded.</p>
              <DropdownMenuItem
                closeOnClick={false}
                onClick={() => { setState(prev => ({ ...prev, status: 'loading' })); setReloadKey(k => k + 1); }}
              >
                Try again
              </DropdownMenuItem>
            </>
          )}
          {state.status === 'ready' && views.length === 0 && (
            <p className="px-3 py-1.5 text-sm text-ink-2">
              {canWrite
                ? 'No saved views yet. Save the current filters to share them.'
                : 'No one has saved a view here yet.'}
            </p>
          )}
          {views.map(view => (
            <DropdownMenuItem key={view.id} onClick={() => onOpen(view)}>
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {view.id === openId && <Check className="size-3.5" aria-label="Open" />}
              </span>
              <span className="truncate">{view.name}</span>
            </DropdownMenuItem>
          ))}
          {canWrite && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAction('save')}>Save current view</DropdownMenuItem>
              {open && (
                <>
                  <DropdownMenuItem onClick={() => setAction('update')}>Update with current view</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAction('rename')}>Rename</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => setAction('delete')}>Delete</DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {action && (
        <ViewDialog
          key={action}
          kind={action}
          viewName={open?.name ?? ''}
          onClose={() => setAction(null)}
          onConfirm={name => applyAction(action, name)}
        />
      )}
    </>
  );
}

const COPY: Record<ViewAction, { title: string; confirm: string; busy: string }> = {
  save: { title: 'Save current view', confirm: 'Save', busy: 'Saving…' },
  update: { title: 'Update saved view', confirm: 'Update', busy: 'Updating…' },
  rename: { title: 'Rename saved view', confirm: 'Rename', busy: 'Renaming…' },
  delete: { title: 'Delete saved view', confirm: 'Delete', busy: 'Deleting…' },
};

function ViewDialog({ kind, viewName, onClose, onConfirm }: {
  kind: ViewAction;
  viewName: string;
  onClose: () => void;
  /** Returns the message to show, or null when it worked. */
  onConfirm: (name: string) => Promise<string | null>;
}) {
  const asksName = kind === 'save' || kind === 'rename';
  const [name, setName] = useState(kind === 'rename' ? viewName : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const copy = COPY[kind];

  async function submit() {
    const trimmed = name.trim();
    if (asksName && !trimmed) { setError('Please enter a name.'); return; }
    setBusy(true);
    setError('');
    try {
      const message = await onConfirm(trimmed);
      if (message) { setError(message); return; }
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
          <DialogPopup initialFocus={asksName ? inputRef : confirmRef} className="mx-4 w-full max-w-sm">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <Bookmark className="size-4 shrink-0 text-ink" />
                <DialogTitle className="text-sm font-semibold text-ink">{copy.title}</DialogTitle>
              </div>
              <DialogClose aria-label="Close" className="p-1 text-ink-2 transition-colors hover:bg-surface-hover hover:text-ink">
                <X className="size-4" />
              </DialogClose>
            </div>

            <div className="space-y-4 px-5 py-5">
              {asksName && (
                <div className="space-y-1.5">
                  <Label htmlFor="saved-view-name">Name</Label>
                  <Input
                    id="saved-view-name"
                    ref={inputRef}
                    type="text"
                    value={name}
                    maxLength={MAX_SAVED_VIEW_NAME_LENGTH}
                    onChange={e => { setName(e.target.value); setError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                    placeholder="e.g. Critical in production"
                  />
                </div>
              )}
              <p className="text-xs text-ink-2">
                {kind === 'save' && 'Everyone who uses this install can open a saved view. It keeps the filters, search, window, columns, sort and grouping you have now.'}
                {kind === 'update' && `Replace the filters saved in "${viewName}" with the ones you have now. Everyone who opens it will see the change.`}
                {kind === 'rename' && 'Everyone who uses this install sees the new name.'}
                {kind === 'delete' && `Delete "${viewName}" for everyone on this install. Findings are not affected.`}
              </p>

              {error && <p className="text-xs font-medium text-sev-critical">{error}</p>}

              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  ref={confirmRef}
                  variant={kind === 'delete' ? 'destructive' : 'default'}
                  className="flex-1"
                  onClick={submit}
                  disabled={busy || (asksName && !name.trim())}
                >
                  {busy ? copy.busy : copy.confirm}
                </Button>
              </div>
            </div>
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
