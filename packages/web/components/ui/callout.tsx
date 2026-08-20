import * as React from "react"
import { Info, TriangleAlert, CircleCheck, CircleX } from "lucide-react"

import { cn } from "@/lib/utils"

/* The boxed message that explains, warns, or reports a result.
 *
 * Before this, every screen wrote its own: a rounded blue-50 box here, an
 * amber-50 one there, a red-200 border somewhere else. They used raw palette
 * classes, so none of them followed the theme, and no two agreed on padding,
 * icon size, or how strong the border should be.
 *
 * Four tones, and each one means something:
 *   info    something worth knowing before continuing
 *   warn    something that will bite later if ignored
 *   error   the thing you asked for did not happen
 *   success the thing you asked for happened, with the result
 *
 * They are deliberately quiet. A callout sits inside a page that already has
 * severities on it, and a full-strength coloured panel would out-shout an
 * actual critical finding. The tone lives in the icon and a soft ground; the
 * text stays on the ink scale so it reads as normal prose. There is no outline:
 * a tinted edge around a tinted fill is the same statement made twice.
 *
 * Red is not a tone you reach for to add emphasis. `error` means an operation
 * failed. Anything else uses `warn`. */

type CalloutTone = "info" | "warn" | "error" | "success"

const TONE: Record<
  CalloutTone,
  { icon: React.ElementType; frame: string; iconCls: string }
> = {
  info: { icon: Info, frame: "bg-status-info-soft", iconCls: "text-status-info" },
  warn: { icon: TriangleAlert, frame: "bg-status-warn-soft", iconCls: "text-status-warn" },
  error: { icon: CircleX, frame: "bg-sev-critical-soft", iconCls: "text-sev-critical" },
  success: { icon: CircleCheck, frame: "bg-status-ok-soft", iconCls: "text-status-ok" },
}

function Callout({
  tone = "info",
  title,
  icon,
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: CalloutTone
  /** Bolded first line. Omit for a single-sentence callout. */
  title?: React.ReactNode
  /** Override the tone's default icon. `null` removes it. */
  icon?: React.ElementType | null
}) {
  const tokens = TONE[tone]
  const Icon = icon === null ? null : ((icon ?? tokens.icon) as React.ElementType)

  return (
    <div
      data-slot="callout"
      data-tone={tone}
      className={cn("flex items-start gap-2.5 px-3.5 py-2.5", tokens.frame, className)}
      {...props}
    >
      {Icon && <Icon className={cn("mt-px size-4 shrink-0", tokens.iconCls)} aria-hidden="true" />}
      <div className="min-w-0 flex-1 space-y-0.5 text-xs leading-relaxed text-ink-2">
        {title && <p className="text-[13px] font-medium text-ink">{title}</p>}
        {children}
      </div>
    </div>
  )
}

/** A callout that wraps its own content — a result table, a list of samples.
 *  Same frame and same header row, but the body sits flush instead of inset. */
function CalloutPanel({
  tone = "info",
  title,
  icon,
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: CalloutTone
  title: React.ReactNode
  icon?: React.ElementType | null
}) {
  const tokens = TONE[tone]
  const Icon = icon === null ? null : ((icon ?? tokens.icon) as React.ElementType)

  return (
    <div
      data-slot="callout-panel"
      data-tone={tone}
      className={cn(tokens.frame, className)}
      {...props}
    >
      <div className="flex items-center gap-2 border-b border-current/15 px-3.5 py-2">
        {Icon && <Icon className={cn("size-4 shrink-0", tokens.iconCls)} aria-hidden="true" />}
        <p className="min-w-0 text-xs font-medium text-ink">{title}</p>
      </div>
      {children}
    </div>
  )
}

export { Callout, CalloutPanel }
