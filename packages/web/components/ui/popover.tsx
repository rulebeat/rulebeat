"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

/* Free-form floating panels: filter checklists, colour pickers, the date range
 * picker, anything that is neither a value list (Select) nor a list of actions
 * (DropdownMenu).
 *
 * Same reason as the other two — RuleBeat had several of these hand-rolled with
 * `position: fixed` and a manual getBoundingClientRect. Those never flipped when
 * the trigger sat near the bottom of the window, never followed the trigger on
 * scroll, and each one re-implemented click-outside. This does all of it.
 *
 * Height is bounded by the VIEWPORT (`--available-height`), never by a fixed
 * number of pixels, so the panel uses whatever room it actually has. */

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverClose = PopoverPrimitive.Close

function PopoverContent({
  className,
  children,
  sideOffset = 4,
  align = "start",
  side = "bottom",
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
  sideOffset?: number
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        collisionPadding={8}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "flex max-h-[min(28rem,var(--available-height))] flex-col",
            "border border-rule-strong bg-popover text-popover-foreground shadow-overlay",
            "origin-[var(--transform-origin)] transition-[opacity,transform] duration-100",
            "data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0",
            className
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent, PopoverClose }
