"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"

/* Shared modal dialog primitive: focus trap, Escape-to-close, and focus return to the trigger
 * are all handled by Base UI instead of being reimplemented per dialog — see components/ui/
 * popover.tsx and select.tsx for the same reasoning applied to non-modal floating panels.
 *
 * `DialogViewport` is required, not optional: it is what positions the popup (centered,
 * right-docked, etc.) now that there is no hand-rolled outer wrapper doing that job. Each
 * consumer passes its own positioning classes to it. `DialogTitle` is required too — without it
 * the popup has no accessible name.
 *
 * No transition/animation classes are applied here, unlike Popover's fade/scale — these dialogs
 * keep their existing instant show/hide, since Popover's motion was never part of what this
 * primitive is standing in for. */

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

function DialogBackdrop({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={cn("fixed inset-0 z-50 bg-scrim", className)}
      {...props}
    />
  )
}

function DialogViewport({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Viewport>) {
  return (
    <DialogPrimitive.Viewport
      data-slot="dialog-viewport"
      className={cn("fixed inset-0 z-50 flex", className)}
      {...props}
    />
  )
}

function DialogPopup({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Popup>) {
  return (
    <DialogPrimitive.Popup
      data-slot="dialog-popup"
      className={cn("relative border border-rule-strong bg-surface shadow-overlay", className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={className} {...props} />
}

export { Dialog, DialogTrigger, DialogPortal, DialogBackdrop, DialogViewport, DialogPopup, DialogTitle, DialogClose }
