"use client"

import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

/* Action menus — the "⋯" row menu, export menus, the dashboard widget menu.
 *
 * Distinct from Select: a Select holds a value, a menu performs actions. Using
 * one for the other is why some of the old hand-rolled dropdowns had to invent
 * their own selected-state and keyboard handling.
 *
 * Same base-ui reasoning as select.tsx: portalled so no ancestor `overflow` can
 * clip it, repositions on scroll rather than closing (closing mid-scroll breaks
 * the interaction), and returns focus to the trigger on close. */

const DropdownMenu = MenuPrimitive.Root
const DropdownMenuTrigger = MenuPrimitive.Trigger
const DropdownMenuGroup = MenuPrimitive.Group
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup
const DropdownMenuSubmenu = MenuPrimitive.SubmenuRoot

function DropdownMenuContent({
  className,
  children,
  sideOffset = 4,
  align = "end",
  side = "bottom",
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Popup> & {
  sideOffset?: number
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        collisionPadding={8}
        className="z-50"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "min-w-44 max-h-[min(24rem,var(--available-height))] scroll-y py-1",
            "border border-rule-strong bg-popover text-popover-foreground shadow-overlay",
            "origin-[var(--transform-origin)] transition-[opacity,transform] duration-100",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]",
            className
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/** `variant="destructive"` is for actions that remove or overwrite something.
 *  It is the one place in a menu that earns the accent red. */
function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & {
  variant?: "default" | "destructive"
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex cursor-default items-center gap-2 px-3 py-1.5 text-sm outline-none select-none",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        variant === "destructive"
          ? "text-destructive data-[highlighted]:bg-destructive data-[highlighted]:text-destructive-foreground"
          : "text-ink data-[highlighted]:bg-ink data-[highlighted]:text-background",
        "data-[disabled]:pointer-events-none data-[disabled]:text-ink-faint",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "flex cursor-default items-center gap-2 px-3 py-1.5 text-sm text-ink outline-none select-none",
        "data-[highlighted]:bg-ink data-[highlighted]:text-background",
        "data-[disabled]:pointer-events-none data-[disabled]:text-ink-faint",
        className
      )}
      {...props}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center border border-current">
        <MenuPrimitive.CheckboxItemIndicator>
          <Check className="size-3" aria-hidden="true" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      <span className="truncate">{children}</span>
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "flex cursor-default items-center gap-2 px-3 py-1.5 text-sm text-ink outline-none select-none",
        "data-[highlighted]:bg-ink data-[highlighted]:text-background",
        "data-[disabled]:pointer-events-none data-[disabled]:text-ink-faint",
        className
      )}
      {...props}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-current">
        <MenuPrimitive.RadioItemIndicator>
          <span className="size-1.5 rounded-full bg-current" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      <span className="truncate">{children}</span>
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.GroupLabel>) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn("label-grid px-3 pt-2.5 pb-1", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className }: { className?: string }) {
  return (
    <div
      role="separator"
      data-slot="dropdown-menu-separator"
      className={cn("my-1 h-px bg-border", className)}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuRadioGroup,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
}
