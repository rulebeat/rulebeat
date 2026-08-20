'use client';

import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* A small pressable chip that is either on or off: weekday buttons, a repeat
 * pattern, a category filter, an icon choice.
 *
 * Five places wrote this by hand with the same pair of class strings, and the
 * strings had already diverged in height and in whether the idle state had a
 * background. It is also the single most common place a design leaks a hue it
 * did not mean to: the old version marked "selected" with a tinted primary
 * background.
 *
 * Grid marks selection by inversion. Colour in this product means severity, so
 * spending a hue on "this one is picked" makes a row of ordinary filter chips
 * shout as loudly as a critical finding. Inversion is unambiguous, works
 * identically in both themes, and stays readable for anyone who cannot separate
 * the two hues at all.
 *
 * `aria-pressed` is set from `selected`, so screen readers get the state that
 * the inversion communicates visually. */

const toggleChipVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1",
    "text-xs font-medium whitespace-nowrap transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&>svg]:pointer-events-none [&>svg]:size-3",
  ],
  {
    variants: {
      size: {
        sm: "h-6 px-2",
        default: "h-8 px-3",
        icon: "size-7 px-0",
      },
      /* Both states are fills, so a row of seven weekday chips is seven shapes
       * rather than seven outlines. The unpressed one is the soft sunken fill,
       * which reads on a white card and on the bare canvas alike. */
      selected: {
        true: "bg-ink text-background",
        false: "bg-surface-sunken text-ink-2 hover:bg-surface-sunken-hover hover:text-ink",
      },
    },
    defaultVariants: {
      size: "default",
      selected: false,
    },
  }
)

function ToggleChip({
  className,
  size,
  selected = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  Omit<VariantProps<typeof toggleChipVariants>, "selected"> & {
    selected?: boolean
  }) {
  return (
    <button
      type={type}
      data-slot="toggle-chip"
      aria-pressed={selected}
      className={cn(toggleChipVariants({ size, selected }), className)}
      {...props}
    />
  )
}

export { ToggleChip, toggleChipVariants }
