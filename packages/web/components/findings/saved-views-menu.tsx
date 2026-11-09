'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import {
  Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle, DialogViewport,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fetchJson } from '@/lib/fetch-json';
import { MAX_SAVED_VIEW_NAME_LENGTH, type SavedView, type SavedViewTab } from '@/lib/saved-view-query';
import { requestSavedViewChange, upsertSavedView, type SavedViewChange, type SavedViewConflict } from '@/lib/saved-view-actions';
import { changedMark, droppedNotice } from '@/lib/saved-view-conflict';

interface SavedViewsMenuProps {
  /** Which tab the explorer is on: only that tab's views are listed, and a new view opens there. */
  tab: SavedViewTab;
  /** Whether the viewer may save, update, rename and delete. Everyone can open a view. */
  canWrite: boolean;
  /** The view the address says is open, if any. */
  openId: string | null;
  /** The revision of the open view the page holds. A save is checked against it. */
  openRevision: number | null;
  /** The address's changes over the open view, as the query a save sends. Empty with none open. */
  changes: string;
  /** The parts of the view that differ from the open one, for the Changed mark beside Update. */
  changedParts: string[];
  /** The open view changed: it is the stored view after a save, an update or a rename (so the address
   *  is written against it, at its new revision), and null after a delete. `reset` asks the page to show
   *  the stored view as it is, when saving stored something other than what the page showed. */
  onOpenChange: (view: SavedView | null, opts?: { reset?: boolean }) => void;
  /** Someone saved the open view first. Nothing was saved; the page takes the newer view and says so. */
  onConflict: (conflict: SavedViewConflict) => void;
  /** Removes the values outside the person's access that the address added, when a save was refused for them. */
  onRemoveOutside: () => void;
  /** Opens a saved view. */
  onOpen: (view: SavedView) => void;
  /** The explorer's current View as the query a saved view stores. */
  currentQuery: string;
}

/** What the dialog is for. */
type ViewAction = 'save' | 'update' | 'rename' | 'delete';
/** What a confirmed action leaves the dialog with: closed (null), an error to fix, or a note to read first. */
type DialogResult = null | { error: string; outside?: number } | { notice: string };
interface SavedViewsState { status: 'loading' | 'error' | 'ready'; views: SavedView[] }

export function SavedViewsMenu({
  tab, canWrite, openId, openRevision, changes, changedParts, onOpenChange, onConflict, onRemoveOutside, onOpen, currentQuery,
}: SavedViewsMenuProps) {
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

  /** Makes the change, then mirrors it in the list and the URL. */
  async function applyAction(kind: ViewAction, name: string): Promise<DialogResult> {
    // Saved with a view open, the server builds the new one from it, so a value the person cannot see is
    // dropped and counted there; with none open the View's query is saved as it is.
    const holdsOpen = openId !== null && openRevision !== null;
    let change: SavedViewChange;
    if (kind === 'save') {
      change = holdsOpen
        ? { kind: 'create-from-open', name, tab, fromView: openId, revision: openRevision, changes }
        : { kind: 'create', fields: { name, tab, query: currentQuery } };
    } else if (!holdsOpen) return null;
    else if (kind === 'rename') change = { kind: 'update', id: openId, revision: openRevision, name };
    else if (kind === 'update') change = { kind: 'update', id: openId, revision: openRevision, changes };
    else change = { kind: 'delete', id: openId };

    const outcome = await requestSavedViewChange(change);
    if (!outcome.ok) {
      if (!outcome.conflict) return { error: outcome.error, ...(outcome.outside !== undefined && { outside: outcome.outside }) };
      // Someone saved first: the notice is the page's, so the dialog closes on it.
      const { view } = outcome.conflict;
      setState(prev => ({ status: prev.status, views: upsertSavedView(prev.views, view) }));
      onConflict(outcome.conflict);
      return null;
    }
    if (outcome.view) {
      const stored = outcome.view;
      setState(prev => ({ status: prev.status, views: upsertSavedView(prev.views, stored) }));
      const dropped = outcome.dropped ?? 0;
      onOpenChange(stored, { reset: kind === 'update' || dropped > 0 });
      return dropped > 0 ? { notice: droppedNotice(dropped) } : null;
    }
    setState(prev => ({ status: prev.status, views: prev.views.filter(v => v.id !== openId) }));
    onOpenChange(null);
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
          {/* A group label throws outside a group, so the list sits in one. */}
          <DropdownMenuGroup>
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
          </DropdownMenuGroup>
          {canWrite && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAction('save')}>Save current view</DropdownMenuItem>
              {open && (
                <>
                  <DropdownMenuItem onClick={() => setAction('update')} className="flex-wrap">
                    Update with current view
                    {changedMark(changedParts) && (
                      <span className="w-full truncate text-xs text-ink-2" title={changedMark(changedParts)!}>{changedMark(changedParts)}</span>
                    )}
                  </DropdownMenuItem>
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
          changedParts={changedParts}
          saveFromOpen={openId !== null}
          onClose={() => setAction(null)}
          onConfirm={name => applyAction(action, name)}
          onRemoveOutside={() => { onRemoveOutside(); setAction(null); }}
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

function ViewDialog({ kind, viewName, changedParts, saveFromOpen, onClose, onConfirm, onRemoveOutside }: {
  kind: ViewAction;
  viewName: string;
  /** The parts that differ from the open view, listed when updating it. */
  changedParts: string[];
  /** A view is open, so a save builds the new one from it. */
  saveFromOpen: boolean;
  onClose: () => void;
  /** Returns what to show, or null when it worked and the dialog can close. */
  onConfirm: (name: string) => Promise<DialogResult>;
  onRemoveOutside: () => void;
}) {
  const asksName = kind === 'save' || kind === 'rename';
  const [name, setName] = useState(kind === 'rename' ? viewName : '');
  const [error, setError] = useState('');
  /** How many values outside the person's access a refusal says to remove. */
  const [outside, setOutside] = useState(0);
  /** Said after a save that worked, which the person reads before closing. */
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const copy = COPY[kind];

  async function submit() {
    const trimmed = name.trim();
    if (asksName && !trimmed) { setError('Please enter a name.'); return; }
    setBusy(true);
    setError('');
    setOutside(0);
    try {
      const result = await onConfirm(trimmed);
      if (result && 'error' in result) { setError(result.error); setOutside(result.outside ?? 0); return; }
      if (result) { setNotice(result.notice); return; }
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
                {kind === 'save' && !saveFromOpen && 'Everyone who uses this install can open a saved view. It keeps the filters, search, window, columns, sort and grouping you have now.'}
                {kind === 'save' && saveFromOpen && 'Everyone who uses this install can open a saved view. It keeps what you see now: the open view with your changes on top. Values outside your access are not saved.'}
                {kind === 'update' && `Save your changes on top of "${viewName}". Everyone who opens it will see them.`}
                {kind === 'rename' && 'Everyone who uses this install sees the new name.'}
                {kind === 'delete' && `Delete "${viewName}" for everyone on this install. Findings are not affected.`}
              </p>

              {kind === 'update' && changedMark(changedParts) && (
                <p className="text-xs text-ink-2">{changedMark(changedParts)}</p>
              )}

              {error && <p className="text-xs font-medium text-sev-critical">{error}</p>}
              {error && outside > 0 && (
                <Button variant="outline" size="sm" onClick={onRemoveOutside}>
                  Remove {outside} {outside === 1 ? 'value' : 'values'} outside your access
                </Button>
              )}
              {notice && <p role="status" className="text-xs font-medium text-ink">{notice}</p>}

              <div className="flex gap-2 pt-1">
                {notice ? (
                  <Button className="flex-1" onClick={onClose}>Done</Button>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            </div>
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
