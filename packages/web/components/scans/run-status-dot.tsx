import { cn } from "@/lib/utils"

/* One place for "how did that run end".
 *
 * Two screens drew this dot from their own inline map (Run History and the
 * Schedules table), and the two maps had already drifted apart. Worse, both
 * used literal palette classes, so neither followed the theme.
 *
 * Grid rule applied here: a run that succeeded is the ordinary case and gets a
 * neutral dot, not a green one. Colour is reserved for the two states worth
 * interrupting someone over. A screen full of green dots reporting nothing
 * unusual is exactly what makes a real red one easy to miss. */

export type RunStatus = "success" | "partial" | "error" | "running" | string

const DOT: Record<string, string> = {
  success: "bg-ink-muted",
  partial: "bg-status-warn",
  error: "bg-sev-critical",
  running: "bg-ink-faint animate-pulse",
}

const LABEL: Record<string, string> = {
  success: "Succeeded",
  partial: "Finished with errors",
  error: "Failed",
  running: "Running",
}

export function RunStatusDot({
  status,
  className,
}: {
  status: RunStatus | null | undefined
  className?: string
}) {
  const key = status ?? "unknown"
  return (
    <span
      title={LABEL[key] ?? "Not run yet"}
      /* Square at 8px, the same mark severity and finding status use. A round dot was the
         one soft corner left in the interface and it read as a leftover from another kit. */
      className={cn("size-2 shrink-0", DOT[key] ?? "bg-ink-faint", className)}
    />
  )
}
