'use client';

import { X } from 'lucide-react';
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle, DialogViewport } from '@/components/ui/dialog';

/** Shared right-hand slide-over shell — fixed backdrop + w-80 panel with a header (title + close)
 *  — used by both the "Add Widget" template picker and the per-widget "Configure Widget" form. */
export function SlideOverPanel({ title, onClose, children, bodyClassName, footer }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  bodyClassName?: string;
  footer?: React.ReactNode;
}) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport className="justify-end">
          <DialogPopup className="flex h-full w-80 flex-col border-l">
            {/* Header */}
            <div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
              <DialogTitle className="text-sm font-semibold text-ink">{title}</DialogTitle>
              <DialogClose aria-label="Close" className="p-1 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink">
                <X className="size-4" />
              </DialogClose>
            </div>

            <div className={bodyClassName ?? 'flex-1 overflow-y-auto px-4 py-4 space-y-3'}>{children}</div>

            {footer}
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
