import * as React from "react"
import { cn } from "@/lib/utils"

/* A card is defined by GROUND, not by an outline. It is lighter than the page it sits on,
 * and that is the whole of it — no border, no shadow, no rounded corner.
 *
 * It used to carry a black hairline. One card looked precise; a settings page with four of
 * them, plus chips and a table that each drew their own, looked like a page of boxes with no
 * hierarchy. Removing the outline and dropping the canvas a few points says the same thing
 * more quietly, and it costs nothing when a screen has ten panels instead of one.
 *
 * `overflow-hidden` is deliberately NOT set here. It was the cause of a recurring class of
 * bugs: any ancestor with overflow other than visible becomes a scroll container, which
 * clips portal-less dropdowns and rebinds `position: sticky` to the wrong ancestor. Cards
 * that genuinely need to clip (a table with rounded internals, an image) opt in themselves. */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("flex flex-col bg-card text-card-foreground", className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "flex items-center justify-between gap-4 px-5 py-3.5 border-b border-border",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "title-grid truncate",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-ink-muted", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("flex items-center gap-2 shrink-0", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-5 py-4", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center gap-3 px-5 py-3.5 border-t border-border bg-surface-sunken",
        className
      )}
      {...props}
    />
  )
}

/** The uppercase mono micro-label Grid puts above numbers and section groupings.
 *  Exists as a component so its size and tracking cannot drift between screens. */
function CardLabel({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-label" className={cn("label-grid", className)} {...props} />
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
  CardLabel,
}
