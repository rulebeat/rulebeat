'use client';

import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { WidgetDef } from '@/lib/types';
import { ROW_HEIGHT, ROW_MARGIN } from '@/components/dashboard/dashboard-constants';

interface Options {
  containerRef: RefObject<HTMLElement | null>;
  /** The widgets as last set, kept current by the caller so a pass never measures against a stale list. */
  widgetsRef: RefObject<WidgetDef[]>;
  setWidgets: Dispatch<SetStateAction<WidgetDef[]>>;
  /** False while the heights are somebody's to set by hand (edit mode). */
  enabled: boolean;
  /** Anything whose change should run a pass again, besides the DOM itself. */
  triggers: unknown[];
}

/* Fit a widget's height to what it actually renders.
   A list widget gets a fixed row span from the template, so a category scorecard
   holding four cards sat in a box tall enough for twelve and left a dead area
   below them. Widgets that mark their natural-height block with
   `data-widget-content` get measured here and their row span shrunk to fit.
   Only ever shrinks: anything taller than its box keeps its own scrollbar.
   Watches the DOM rather than running once, because every widget fetches its own
   data: at first paint they are all spinners and there is nothing to measure. The
   MutationObserver is the one that matters: it catches a widget swapping its
   spinner for content, and the ResizeObserver handles the window being resized.
   Shared by the dashboard and by Present, so the two lay the same grid out the same way. */
export function useFitWidgetsToContent({ containerRef, widgetsRef, setWidgets, enabled, triggers }: Options): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    let raf = 0;
    const ro = new ResizeObserver(() => schedule());

    const measure = () => {
      const current = widgetsRef.current;
      let changed = false;

      // Blocks appear as each widget's fetch resolves, so pick up any that are new
      // since the last pass: a content block that grows later still gets measured.
      container.querySelectorAll('[data-widget-content]').forEach(el => ro.observe(el));

      const next = current.map(w => {
        const block = container.querySelector<HTMLElement>(`[data-grid-item="${w.id}"] [data-widget-content]`);
        const item = block?.closest<HTMLElement>('[data-grid-item]');
        // The widget's own content region, not the block's immediate parent: some
        // widgets put a scroll region in between, and that region sizes itself to
        // the content, which would report no unused space at all.
        const box = item?.querySelector<HTMLElement>('[data-widget-body]');
        if (!block || !item || !box) return w;

        // Measure the unused space rather than the widget chrome, so this never has
        // to know how tall a widget header is.
        const slack = box.clientHeight - block.offsetHeight;
        if (slack <= ROW_MARGIN) return w; // content fills the box, or overflows it

        const neededPx = item.offsetHeight - slack;
        const rows = Math.max(2, Math.ceil((neededPx + ROW_MARGIN) / (ROW_HEIGHT + ROW_MARGIN)));
        if (rows >= w.h) return w;

        changed = true;
        return { ...w, h: rows };
      });

      if (!changed) return;
      /* Shrinking a widget makes the grid compact everything below it upward, and
         RGL reports that back through onLayoutChange with new positions, which is
         fine: this pass only ever runs outside edit mode, and a layout change
         outside edit mode never marks the dashboard dirty (see onLayoutChange). */
      widgetsRef.current = next;
      setWidgets(next);
    };

    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    const mo = new MutationObserver(schedule);
    mo.observe(container, { childList: true, subtree: true });
    ro.observe(container);
    schedule();

    return () => { mo.disconnect(); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...triggers]);
}
