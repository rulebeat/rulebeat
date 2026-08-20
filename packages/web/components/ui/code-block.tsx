"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"

import { cn } from "@/lib/utils"

/* Code and commands, in the app's own colours.
 *
 * These blocks used to be hardcoded slate-950 panels — a dark card dropped into
 * a light page, which is exactly the "one component brought its own theme" look
 * the rework is removing. They are a sunken surface with a strong rule now, and
 * they follow light and dark like everything else.
 *
 * Height is not capped. A long script scrolls sideways if a line is long, and
 * the page scrolls for the rest, so nothing is hidden behind an inner scrollbar
 * the user has to find first. */

function CopyAction({
  text,
  label = "Copy",
  className,
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Without this, copying and then navigating away leaves a timer holding a
  // setState on an unmounted component.
  React.useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(text)
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 2000)
      }}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-ink-2 transition-colors hover:text-ink",
        className
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-status-ok" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? "Copied" : label}
    </button>
  )
}

function CodeBlock({
  code,
  title,
  actions,
  copyable = true,
  className,
}: {
  code: string
  /** What the block is: "Az CLI", "PowerShell", a filename. */
  title?: React.ReactNode
  /** Extra controls in the header, to the left of Copy. */
  actions?: React.ReactNode
  copyable?: boolean
  className?: string
}) {
  const hasHeader = Boolean(title || actions || copyable)
  return (
    <div className={cn("bg-surface-sunken", className)}>
      {hasHeader && (
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            {title ? <span className="label-grid truncate">{title}</span> : null}
            {actions}
          </div>
          {copyable && <CopyAction text={code} className="shrink-0" />}
        </div>
      )}
      <pre className="scroll-x px-3 py-2.5 font-mono text-xs leading-relaxed text-ink">
        {code}
      </pre>
    </div>
  )
}

export { CodeBlock, CopyAction }
