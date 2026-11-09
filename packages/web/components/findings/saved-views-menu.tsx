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
import { MAX_SAVED_VIEW_NAME_LENGTH, type HeldBackSavedView, type SavedViewTab } from '@/lib/saved-view-query';
import type { HeldBack } from '@/lib/held-back';
import { baseCopyAfterVisibilityChange, requestSavedViewChange, upsertSavedView, type SavedViewChange } from '@/lib/saved-view-actions';
import {
  DEMOTED_OWNER_NOTE, isDemotedOwner, isOwnItem, mayChangeItemWith, mayChangeVisibilityWith, openableItems, ownerLabel, sectionsOf, transferControlsWith, type ItemPermissions,
} from '@/lib/item-access-model';
import { shareConfirmation } from '@/lib/item-sharing';
import { SHARE_REASON } from '@/lib/write-controls';
import { requestVisibilityChange } from '@/lib/item-sharing-client';
import { ItemTransferDialog } from '@/components/item-transfer-dialog';

interface SavedViewsMenuProps {
  /** Which tab the explorer is on: only that tab's views are listed, and a new view opens there. */
  tab: SavedViewTab;
  /** The person asking, and what they may do with saved views. Everyone can open a Shared view and keep
   *  their own; changing a Shared view depends on who owns it. */
  currentUserId: string;
  permissions: ItemPermissions;
  /** Whether Share is on, and why not when it is off. Computed on the server from `mayAct`. */
  shareControl?: { allowed: boolean; reason?: string };
  /** The view the URL says is open, if any. */
  openId: string | null;
  /** Asks for the URL's open view to change: set after a save, cleared after a delete or when the
   *  open view is gone. */
  onOpenIdChange: (id: string | null) => void;
  /** Opens a saved view. */
  onOpen: (view: HeldBackSavedView) => void;
  /** Told which of the open view's stored values are held back from this person, or none when no view is open. */
  onHeldBackChange?: (heldBack: HeldBack[]) => void;
  /** The explorer's current View as the query a saved view stores. */
  currentQuery: string;
  /** The copy of the view the page was opened from, when the person opened it from this menu. A save is based
   *  on that copy, not on the list the menu re-reads, so someone else's later change is refused as stale. */
  appliedView?: HeldBackSavedView | null;
  /** Told the view changed since the copy the page was opened from, or null once that is cleared. */
  onStale?: (message: string | null) => void;
}

/** What the dialog is for. */
type ViewAction = 'save' | 'update' | 'rename' | 'delete' | 'share' | 'unshare';
interface SavedViewsState { status: 'loading' | 'error' | 'ready'; views: HeldBackSavedView[] }

export function SavedViewsMenu({ tab, currentUserId, permissions, shareControl: shareControlProp, openId, onOpenIdChange, onOpen, onHeldBackChange, currentQuery, appliedView, onStale }: SavedViewsMenuProps) {
  const [state, setState] = useState<SavedViewsState>({ status: 'loading', views: [] });
  const [reloadKey, setReloadKey] = useState(0);
  const [action, setAction] = useState<ViewAction | null>(null);
  const [transfer, setTransfer] = useState<'hand-over' | 'take-over' | null>(null);
  // The copy of the open view this page shows. Opening the menu re-reads the list, and that list may hold
  // someone else's newer change, so saves are based on this copy and never on the list.
  const [base, setBase] = useState<HeldBackSavedView | null>(appliedView?.id === openId ? appliedView ?? null : null);

  useEffect(() => {
    let live = true;
    fetchJson<HeldBackSavedView[]>('/api/views').then(result => {
      if (!live) return;
      setState(prev => (result.ok ? { status: 'ready', views: result.data } : { status: 'error', views: prev.views }));
    });
    return () => { live = false; };
  }, [reloadKey]);

  const views = state.views.filter(v => v.tab === tab);
  const open = views.find(v => v.id === openId) ?? null;
  const { yours, sharedByOthers } = sectionsOf({ id: currentUserId }, views);
  const shareControl = shareControlProp ?? (permissions.write ? { allowed: true } : { allowed: false, reason: SHARE_REASON });
  const actor = { id: currentUserId };
  const canChangeOpen = open !== null && mayChangeItemWith(actor, permissions, open);
  const canShareOpen = open !== null && open.visibility === 'personal' && isOwnItem(actor, open);
  const canUnshareOpen = open !== null && mayChangeVisibilityWith(actor, permissions, open, 'unshare');
  const demotedOpen = open !== null && isDemotedOwner(actor, permissions, open);
  const { handOver: canHandOverOpen, takeOver: canTakeOverOpen } = open ? transferControlsWith(actor, permissions, open) : { handOver: false, takeOver: false };

  // A view opened from a link has no applied copy: the first copy the list holds for it is the closest there is.
  // Syncing a stored copy to the URL's open view, not state derived from props.
  useEffect(() => {
    if (!open || base?.id === open.id) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBase(open);
  }, [open, base]);
  // Opening a copy from outside the menu (the reload notice) moves the base to it, even when the view is the same one.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (appliedView && appliedView.id === openId) setBase(appliedView);
  }, [appliedView, openId]);
  const baseCopy = base !== null && base.id === openId ? base : null;

  const openHeldBack = open?.heldBack;
  useEffect(() => { onHeldBackChange?.(openHeldBack ?? []); }, [openHeldBack, onHeldBackChange]);

  // A view someone else deleted, or a stale link, leaves nothing to update or rename.
  useEffect(() => {
    if (state.status === 'ready' && openId && !open) onOpenIdChange(null);
  }, [state.status, openId, open, onOpenIdChange]);

  /** Makes the change, then mirrors it in the list and the URL. Returns the message to show, or
   *  null when it worked. */
  async function applyAction(kind: ViewAction, name: string): Promise<string | null> {
    let change: SavedViewChange;
    if (kind === 'share' || kind === 'unshare') {
      if (!open) return null;
      const outcome = await requestVisibilityChange('view', open.id, kind);
      if (!outcome.ok) return outcome.error;
      // The answer is the view, or only its id, visibility and revision after someone else's unshare.
      const changed = outcome.item as Partial<HeldBackSavedView>;
      setState(prev => ({ status: prev.status, views: openableItems(actor, prev.views.map(v => (v.id === open.id ? { ...v, ...changed } : v))) }));
      setBase(prev => (prev && prev.id === open.id && changed.revision !== undefined && changed.visibility !== undefined
        ? baseCopyAfterVisibilityChange(prev, { visibility: changed.visibility, revision: changed.revision })
        : prev));
      return null;
    }
    if (kind === 'save') change = { kind: 'create', fields: { name, tab, query: currentQuery } };
    else if (!open || !baseCopy || !canChangeOpen) return null;
    else if (kind === 'rename') change = { kind: 'update', id: open.id, fields: { name }, revision: baseCopy.revision, opened: baseCopy.query };
    else if (kind === 'update') change = { kind: 'update', id: open.id, fields: { query: currentQuery }, revision: baseCopy.revision, opened: baseCopy.query };
    else change = { kind: 'delete', id: open.id };

    const outcome = await requestSavedViewChange(change);
    if (!outcome.ok) {
      if (outcome.stale) onStale?.(outcome.error);
      return outcome.error;
    }
    if (outcome.view) {
      const stored = outcome.view;
      setBase(stored);
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
                {permissions.personal
                  ? 'No saved views yet. Save the current filters to keep them.'
                  : 'No saved views here yet.'}
              </p>
            )}
            {views.length > 0 && (
              <>
                <DropdownMenuLabel>Yours</DropdownMenuLabel>
                {yours.length === 0 && <p className="px-3 py-1.5 text-sm text-ink-2">You have no saved views here.</p>}
                {yours.map(view => (
                  <ViewItem key={view.id} view={view} openId={openId} onOpen={onOpen}
                    tag={view.visibility === 'shared' ? 'Shared' : 'Personal'} />
                ))}
                <DropdownMenuLabel>Shared by others</DropdownMenuLabel>
                {sharedByOthers.length === 0 && <p className="px-3 py-1.5 text-sm text-ink-2">No one else has shared a view here.</p>}
                {sharedByOthers.map(view => (
                  <ViewItem key={view.id} view={view} openId={openId} onOpen={onOpen} tag={ownerLabel(view.owner)} />
                ))}
              </>
            )}
          </DropdownMenuGroup>
          {(permissions.personal || canChangeOpen || canShareOpen || canUnshareOpen || canHandOverOpen || canTakeOverOpen || demotedOpen) && (
            <>
              <DropdownMenuSeparator />
              {permissions.personal && <DropdownMenuItem onClick={() => setAction('save')}>Save current view</DropdownMenuItem>}
              {canChangeOpen && (
                <>
                  <DropdownMenuItem onClick={() => setAction('update')}>Update with current view</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAction('rename')}>Rename</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => setAction('delete')}>Delete</DropdownMenuItem>
                </>
              )}
              {canShareOpen && (
                <DropdownMenuItem disabled={!shareControl.allowed} onClick={() => setAction('share')}>Share</DropdownMenuItem>
              )}
              {canShareOpen && !shareControl.allowed && shareControl.reason && (
                <p className="px-3 pb-1.5 text-xs text-ink-2">{shareControl.reason}</p>
              )}
              {canUnshareOpen && <DropdownMenuItem onClick={() => setAction('unshare')}>Unshare</DropdownMenuItem>}
              {canHandOverOpen && <DropdownMenuItem onClick={() => setTransfer('hand-over')}>Hand over</DropdownMenuItem>}
              {canTakeOverOpen && <DropdownMenuItem onClick={() => setTransfer('take-over')}>Take over</DropdownMenuItem>}
              {demotedOpen && <p className="px-3 py-1.5 text-xs text-ink-2">{DEMOTED_OWNER_NOTE}</p>}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {transfer && open && (
        <ItemTransferDialog
          kind="view"
          mode={transfer}
          id={open.id}
          name={open.name}
          onClose={() => setTransfer(null)}
          onDone={() => setReloadKey(k => k + 1)}
        />
      )}

      {action && (
        <ViewDialog
          key={action}
          kind={action}
          viewName={open?.name ?? ''}
          shared={open?.visibility === 'shared'}
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
  share: { title: 'Share saved view', confirm: 'Share', busy: 'Sharing…' },
  unshare: { title: 'Unshare saved view', confirm: 'Unshare', busy: 'Unsharing…' },
};

/** One saved view in the list: a check where it is open, its name, and a quiet tag on the right. */
function ViewItem({ view, openId, onOpen, tag }: { view: HeldBackSavedView; openId: string | null; onOpen: (view: HeldBackSavedView) => void; tag: string }) {
  return (
    <DropdownMenuItem onClick={() => onOpen(view)}>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {view.id === openId && <Check className="size-3.5" aria-label="Open" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{view.name}</span>
      <span className="max-w-24 shrink-0 truncate text-xs text-ink-muted">{tag}</span>
    </DropdownMenuItem>
  );
}

function ViewDialog({ kind, viewName, shared, onClose, onConfirm }: {
  kind: ViewAction;
  viewName: string;
  /** Whether the open view is Shared: what the dialog says about who sees the change. */
  shared: boolean;
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
                {kind === 'save' && 'Only you can open this saved view. It keeps the filters, search, window, columns, sort and grouping you have now.'}
                {kind === 'update' && `Replace the filters saved in "${viewName}" with the ones you have now.${shared ? ' Everyone who opens it will see the change.' : ''}`}
                {kind === 'rename' && (shared ? 'Everyone who uses this install sees the new name.' : 'Only you see the new name.')}
                {kind === 'delete' && `Delete "${viewName}"${shared ? ' for everyone on this install' : ''}. Findings are not affected.`}
                {kind === 'share' && shareConfirmation('view', viewName)}
                {kind === 'unshare' && `Unshare "${viewName}"? Only its owner will be able to open it, and it stops showing for everyone else.`}
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
