"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/* One text field for the whole app.
 *
 * Inputs were previously written out class by class wherever one was needed, so
 * heights, borders and focus rings drifted: some had a 2px ring at 40% opacity,
 * some had none, some sat on `bg-card` and some on `bg-background`. Grid gives
 * every field the same square frame and the same focus outline.
 *
 * Focus is an OUTLINE, not a ring. A ring is a box-shadow, so it is painted
 * outside the element's box and gets clipped the moment the field sits inside
 * anything that scrolls or hides overflow. An outline is not. */

const fieldBase = [
  "w-full min-w-0 border border-rule-strong bg-surface text-ink transition-colors outline-none",
  "placeholder:text-ink-faint",
  "focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-ring",
  "disabled:pointer-events-none disabled:bg-surface-sunken disabled:text-ink-faint",
  "aria-invalid:border-destructive aria-invalid:focus-visible:outline-destructive",
  // Date and time fields paint their own picker glyph; keep it on the ink scale
  // rather than the browser's default blue-black.
  "[&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-55",
  "[&::-webkit-calendar-picker-indicator]:hover:opacity-100",
]

const sizeClasses = {
  sm: "h-8 px-2.5 text-[13px]",
  default: "h-9 px-3 text-sm",
  lg: "h-10 px-3.5 text-sm",
} as const

function Input({
  className,
  type = "text",
  inputSize = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & {
  inputSize?: keyof typeof sizeClasses
}) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(fieldBase, sizeClasses[inputSize], className)}
      {...props}
    />
  )
}

/** Multi-line. No `size` — a textarea is sized by `rows` or by its container. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldBase, "min-h-20 px-3 py-2 text-sm leading-relaxed", className)}
      {...props}
    />
  )
}

/** The caption above a field. Uses the same uppercase mono as table headers, so
 *  a form and a table read as parts of the same system. */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn("label-grid block", className)}
      {...props}
    />
  )
}

/** Helper text under a field. `tone="error"` for validation messages: say what
 *  is wrong and what to do about it, not that something went wrong. */
function FieldHint({
  className,
  tone = "muted",
  ...props
}: React.ComponentProps<"p"> & { tone?: "muted" | "error" }) {
  return (
    <p
      data-slot="field-hint"
      className={cn(
        "text-xs",
        tone === "error" ? "text-destructive" : "text-ink-muted",
        className
      )}
      {...props}
    />
  )
}

export { Input, Textarea, Label, FieldHint, fieldBase }
