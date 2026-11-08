'use client';

import { createContext, useContext, useEffect } from 'react';

/** Where a widget hands up its limit notes: the dashboard grid's frame around the widget owns the notes
 *  slot (WidgetWrapper), while the widget owns the fetch that says which notes apply. */
export const WidgetNotesContext = createContext<((notes: string[]) => void) | null>(null);

/**
 * Reports `notes` to the frame the widget sits in, and takes them back when the widget goes or the
 * list changes, so a note shows exactly as long as the data that asked for it. Outside a frame (a
 * widget rendered on its own) it does nothing.
 */
export function useReportWidgetNotes(notes: readonly string[]): void {
  const report = useContext(WidgetNotesContext);
  const key = JSON.stringify(notes);
  useEffect(() => {
    if (!report) return;
    report(JSON.parse(key) as string[]);
    return () => report([]);
  }, [report, key]);
}
