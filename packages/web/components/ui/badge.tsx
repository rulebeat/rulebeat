import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* The old variants used literal palette classes (border-red-200 bg-red-50
 * text-red-700, emerald, amber). Those do not flip with the theme, so every badge
 * would have stayed on a light background in dark mode. They now read from the
 * status tokens, which are defined for both grounds.
 *
 * Two distinct jobs, kept separate on purpose:
 *   · STATUS  — an outcome. Did the scan succeed, is the credential verified.
 *   · SEVERITY — how bad a finding is. Lives in its own component
 *     (components/findings/severity-badge.tsx) because Grid encodes severity by
 *     visual weight rather than by hue, and mixing the two ramps is what makes a
 *     dashboard look like a bag of sweets. */
/* A badge is a soft filled shape with no outline. The tinted variants used to
 * carry a matching border at 35% as well, which put two edges on a 22px element
 * and made a table cell holding three of them look like three tiny windows. The
 * fill alone says everything the outline was saying. `outline` keeps its border,
 * because that is what a caller is asking for by name. */
const badgeVariants = cva(
  [
    "group/badge inline-flex h-[22px] w-fit shrink-0 items-center justify-center gap-1.5",
    "px-2 text-xs font-medium whitespace-nowrap transition-colors",
    "[&>svg]:pointer-events-none [&>svg]:size-3",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-surface-sunken text-ink",
        outline: "border border-border bg-surface text-ink-2",
        ghost: "text-ink-2",
        destructive: "bg-sev-critical-soft text-destructive",
        success: "bg-status-ok-soft text-status-ok",
        warning: "bg-status-warn-soft text-status-warn",
        info: "bg-status-info-soft text-status-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
