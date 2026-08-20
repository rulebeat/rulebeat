"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { Check, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/* ── Why base-ui rather than another hand-rolled dropdown ───────────────────
 *
 * Before this, RuleBeat had six separate portal-and-click-outside dropdown
 * implementations plus ten native <select> elements. The native ones cannot be
 * themed — a browser paints its own popup, so they stayed light in dark mode and
 * looked different on every operating system. The hand-rolled ones each
 * re-solved positioning, flipping, click-outside and keyboard handling, and each
 * solved them slightly differently.
 *
 * base-ui was already a dependency. It handles what those six kept getting
 * wrong: arrow-key navigation and type-ahead, focus restore on close, collision
 * detection with flipping, repositioning on scroll rather than closing, portal
 * rendering so no ancestor's `overflow` can clip the popup, and correct ARIA.
 *
 * Everything here is styling on top of that. If a dropdown misbehaves, the fix
 * belongs in this file, once.
 * ─────────────────────────────────────────────────────────────────────────── */

const Root = SelectPrimitive.Root
const Group = SelectPrimitive.Group
const GroupLabel = SelectPrimitive.GroupLabel

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "default" | "sm"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex w-full items-center justify-between gap-2 border border-rule-strong bg-surface text-left text-ink",
        "transition-colors outline-none select-none",
        "hover:bg-surface-hover",
        "data-[popup-open]:bg-surface-hover",
        "disabled:pointer-events-none disabled:opacity-50 disabled:bg-surface-sunken",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3 text-sm",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        className="shrink-0 text-ink-muted transition-transform data-[popup-open]:rotate-180"
        render={<ChevronDown className="size-3.5" aria-hidden="true" />}
      />
    </SelectPrimitive.Trigger>
  )
}

/** The trigger's label.
 *
 *  base-ui's Value takes a render FUNCTION, not a `placeholder` prop — passing
 *  `placeholder` typechecks (it is a valid HTML attribute on a span) but lands on
 *  the DOM node and renders nothing, leaving an empty trigger. The caller supplies
 *  children that resolve the current value to a label. */
function SelectValue({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("truncate", className)}
      {...props}
    />
  )
}

/** The floating popup. Grid gives it a hard corner and a strong rule; the one
 *  shadow in the system lifts it off the page so it reads as temporary rather
 *  than as part of the layout.
 *
 *  `max-h` here is intentional and is the ONE place a dropdown height is capped:
 *  it is bounded by the viewport rather than by a fixed pixel number, so a long
 *  list scrolls inside the popup instead of running off the bottom of the screen. */
function SelectContent({
  className,
  children,
  sideOffset = 4,
  align = "start",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> & {
  sideOffset?: number
  align?: "start" | "center" | "end"
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        alignItemWithTrigger={false}
        collisionPadding={8}
        className="z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "min-w-[var(--anchor-width)] max-h-[min(24rem,var(--available-height))]",
            "scroll-y border border-rule-strong bg-popover text-popover-foreground shadow-overlay",
            "origin-[var(--transform-origin)] transition-[opacity,transform] duration-100",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]",
            className
          )}
          {...props}
        >
          <SelectPrimitive.List className="py-1">{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "flex cursor-default items-center gap-2 px-3 py-1.5 text-sm text-ink outline-none select-none",
        "data-[highlighted]:bg-ink data-[highlighted]:text-background",
        "data-[disabled]:pointer-events-none data-[disabled]:text-ink-faint",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="flex size-3.5 shrink-0 items-center justify-center">
        <Check className="size-3.5" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText className="truncate">
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn("label-grid px-3 pt-2.5 pb-1", className)}
      {...props}
    />
  )
}

function SelectSeparator({ className }: { className?: string }) {
  return (
    <div
      role="separator"
      data-slot="select-separator"
      className={cn("my-1 h-px bg-border", className)}
    />
  )
}

/* ── Convenience form ───────────────────────────────────────────────────────
 * Most of the app just needs "a list of options with a current value." This is
 * the drop-in replacement for a native <select>; reach for the composable parts
 * above only when a case genuinely needs groups or custom item rendering. */

export interface SelectOption {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  disabled,
  size = "default",
  className,
  contentClassName,
  name,
  "aria-label": ariaLabel,
}: {
  value: string | null
  onValueChange: (value: string) => void
  options: readonly SelectOption[]
  placeholder?: string
  disabled?: boolean
  size?: "default" | "sm"
  className?: string
  contentClassName?: string
  name?: string
  "aria-label"?: string
}) {
  return (
    <Root
      value={value}
      onValueChange={(next) => onValueChange(String(next))}
      disabled={disabled}
      name={name}
      items={options as { value: string; label: React.ReactNode }[]}
    >
      <SelectTrigger size={size} className={className} aria-label={ariaLabel}>
        <SelectValue>
          {(current) => {
            const selected = options.find((option) => option.value === current)
            return selected ? (
              selected.label
            ) : (
              <span className="text-ink-faint">{placeholder}</span>
            )
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Root>
  )
}

export {
  Select,
  Root as SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Group as SelectGroup,
  SelectGroupLabel,
  SelectSeparator,
  GroupLabel,
}
