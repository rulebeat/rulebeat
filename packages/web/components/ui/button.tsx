import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* Grid buttons: hard corners, no gradient, no drop shadow. The previous default
 * carried an inset highlight and a blue-tinted shadow baked in as a literal
 * rgba() — invisible to the theme and wrong on a dark ground.
 *
 * `default` is a solid ink fill, the highest contrast the page has, so it is
 * reserved for the one primary action per view. It is deliberately not the
 * accent red: red is the colour of a problem everywhere else in the product,
 * and a red Create button sitting next to a red Delete button taught people to
 * stop reading it. `outline` is the workhorse. */
const buttonVariants = cva(
  [
    "group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap",
    "text-sm font-medium transition-colors outline-none select-none",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/88 active:bg-primary/80",
        outline:
          "border border-rule-strong bg-surface text-ink hover:bg-surface-hover aria-expanded:bg-surface-hover data-[popup-open]:bg-surface-hover",
        secondary:
          "bg-surface-sunken text-ink hover:bg-surface-hover aria-expanded:bg-surface-hover",
        ghost:
          "text-ink-2 hover:bg-surface-hover hover:text-ink aria-expanded:bg-surface-hover aria-expanded:text-ink data-[popup-open]:bg-surface-hover",
        destructive:
          "border border-destructive bg-transparent text-destructive hover:bg-destructive hover:text-destructive-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 gap-2 px-4",
        xs: "h-7 gap-1.5 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 px-3 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-5",
        icon: "size-9",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-10",
      },
      /** Grid's uppercase mono treatment. For primary calls to action, not for
       *  every button — used everywhere it stops meaning anything. */
      emphasis: {
        none: "",
        grid: "font-mono text-[11px] font-semibold uppercase tracking-[0.08em]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      emphasis: "none",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  emphasis = "none",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, emphasis, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
