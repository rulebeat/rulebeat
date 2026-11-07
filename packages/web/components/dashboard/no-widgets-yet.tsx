import type { ReactNode } from 'react';

/** What a dashboard with no widgets shows. The ordinary view adds the button that fixes it; Present, which cannot edit, shows the sentence alone. */
export function NoWidgetsYet({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-4 border border-dashed border-rule-strong">
      <p className="text-sm text-ink-muted">No widgets yet</p>
      {children}
    </div>
  );
}
