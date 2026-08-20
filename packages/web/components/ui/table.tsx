"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/* ── Why this shape ─────────────────────────────────────────────────────────
 *
 * The previous version wrapped every <table> in its own scroll container. That
 * made the table decide its own scrolling, which is why callers that needed a
 * different height reached past it and hand-rolled their own <table> instead —
 * seven of them, each with a different header treatment and a different
 * arbitrary max-h.
 *
 * So scrolling is now the CALLER's, via <TableScroll>. The table itself only
 * knows how to be a table. Two consequences worth keeping:
 *
 *   · No height is baked in anywhere. A table fills the region it is given.
 *     Put <TableScroll> in a flex/grid parent with a real height and it scrolls
 *     to fit; leave it unconstrained and the page scrolls instead. Both are
 *     correct, and neither needs a magic number like max-h-[65vh].
 *
 *   · Sticky headers work, because the scroll container is a known ancestor.
 *     `sticky` is applied per <th>, never on the <tr> — a <tr> does not
 *     establish a containing block for it and the header slides away.
 * ─────────────────────────────────────────────────────────────────────────── */

/** The scroll region a table lives in. Owns both axes explicitly: setting only
 *  one leaves the other at `auto`, which lets a table scroll in a direction it
 *  was never meant to.
 *
 *  DEFAULT — the region scrolls sideways only and grows to the full height of its
 *  rows. Vertical scrolling belongs to the app's single scroll region, so a long
 *  table is read by scrolling the page, the way a long page is read anywhere else.
 *  This is what replaced the assorted `max-h-[65vh]` caps: a table cut off at an
 *  arbitrary fraction of the screen puts a second scrollbar inside the first, and
 *  the number was never right on any particular screen.
 *
 *  `fill` — the region takes the height its parent gives it and scrolls inside.
 *  Only for a table placed in a parent with a real height (a flex or grid child
 *  with `min-h-0`), and it is the only mode where a sticky header can work, since
 *  sticky needs a scroll container that actually scrolls. */
function TableScroll({
  className,
  fill = false,
  ...props
}: React.ComponentProps<"div"> & { fill?: boolean }) {
  return (
    <div
      data-slot="table-scroll"
      data-fill={fill ? "" : undefined}
      className={cn(
        "relative w-full",
        fill ? "min-h-0 flex-1 scroll-both" : "scroll-x",
        className
      )}
      {...props}
    />
  )
}

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <table
      data-slot="table"
      className={cn("w-full caption-bottom border-collapse text-sm", className)}
      {...props}
    />
  )
}

/** `sticky` keeps the header visible while the body scrolls. It needs an opaque
 *  background or rows show through as they pass underneath, and it is set on the
 *  cells rather than the row for the reason in the block comment above.
 *
 *  It only does anything inside `<TableScroll fill>`. In the default mode the
 *  wrapper never scrolls vertically, so the header simply stays where it is —
 *  harmless, but do not expect it to follow you down the page. */
function TableHeader({
  className,
  sticky = false,
  ...props
}: React.ComponentProps<"thead"> & { sticky?: boolean }) {
  return (
    <thead
      data-slot="table-header"
      data-sticky={sticky ? "" : undefined}
      className={cn(
        sticky &&
          "[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-surface",
        className
      )}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={className} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-border bg-surface-sunken font-medium",
        className
      )}
      {...props}
    />
  )
}

/** Rows are separated by the soft `border` token, so a long table reads as one
 *  block instead of a ladder. The table has no frame at all — it sits on the card
 *  that holds it. The only line carrying real weight is the one under the header. */
function TableRow({
  className,
  interactive = false,
  ...props
}: React.ComponentProps<"tr"> & { interactive?: boolean }) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border last:border-0",
        "data-[state=selected]:bg-surface-sunken",
        interactive &&
          "cursor-pointer transition-colors hover:bg-surface-hover has-aria-expanded:bg-surface-hover",
        className
      )}
      {...props}
    />
  )
}

/** `shrink` is the shrink-to-content column pattern: `w-px` plus `whitespace-nowrap`
 *  on BOTH the th and the td. Setting it on a child alone does not stop the cell
 *  stretching, which is the usual reason a narrow column still eats half the table. */
function TableHead({
  className,
  shrink = false,
  numeric = false,
  ...props
}: React.ComponentProps<"th"> & { shrink?: boolean; numeric?: boolean }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "label-grid h-9 px-3 text-left align-middle font-medium whitespace-nowrap",
        /* The one deliberately black rule in the app. See --rule-anchor. */
        "border-b border-rule-anchor",
        "[&:has([role=checkbox])]:pr-0",
        shrink && "w-px",
        numeric && "text-right",
        className
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  shrink = false,
  numeric = false,
  ...props
}: React.ComponentProps<"td"> & { shrink?: boolean; numeric?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-2.5 align-middle text-ink",
        "[&:has([role=checkbox])]:pr-0",
        shrink && "w-px whitespace-nowrap",
        numeric && "text-right tabular-nums",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-3 text-sm text-ink-muted", className)}
      {...props}
    />
  )
}

/** One empty state for every table, so "nothing here yet" looks the same on every
 *  screen. Say WHY it is empty — a filter that matches nothing and a table that has
 *  never had data are different situations and must not read identically. */
function TableEmpty({
  colSpan,
  className,
  children,
  ...props
}: React.ComponentProps<"td"> & { colSpan: number }) {
  return (
    <tr data-slot="table-empty">
      <td
        colSpan={colSpan}
        className={cn("px-3 py-10 text-center text-sm text-ink-muted", className)}
        {...props}
      >
        {children}
      </td>
    </tr>
  )
}

export {
  Table,
  TableScroll,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TableEmpty,
}
