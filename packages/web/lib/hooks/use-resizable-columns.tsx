'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Drag-to-resize state for a set of named columns. Mirrors the pattern used for the dashboard
 *  grid: one `Record<column, width>` drives both the header and every row via the same
 *  `gridTemplateColumns` string, so header and rows can never drift out of alignment.
 *
 *  `flexCol`, if given, names the one column that fills any leftover container width by default
 *  (so the table isn't left shrunk to the left with dead space on the right) — until the user
 *  actually drags its handle, at which point it behaves like every other fixed-width column. */
export function useResizableColumns<K extends string>(initial: Record<K, number>, opts?: { flexCol?: K; minWidth?: number }) {
  const minWidth = opts?.minWidth ?? 60;
  const [widths, setWidths] = useState<Record<K, number>>(initial);
  const [resizedCols, setResizedCols] = useState<Set<K>>(new Set());
  const dragRef = useRef<{ col: K; startX: number; startWidth: number } | null>(null);

  const onMouseMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const next = Math.max(minWidth, d.startWidth + (e.clientX - d.startX));
    setWidths(w => ({ ...w, [d.col]: next }));
  }, [minWidth]);

  // Holds the current onMouseUp identity so the handler can remove its own listener without
  // referencing itself inside its own declaration.
  const onMouseUpRef = useRef<() => void>(() => {});

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUpRef.current);
  }, [onMouseMove]);
  useEffect(() => {
    onMouseUpRef.current = onMouseUp;
  });

  const startResize = useCallback((col: K) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizedCols(prev => prev.has(col) ? prev : new Set(prev).add(col));
    dragRef.current = { col, startX: e.clientX, startWidth: widths[col] };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [widths, onMouseMove, onMouseUp]);

  const isFlexible = useCallback(
    (col: K) => opts?.flexCol === col && !resizedCols.has(col),
    [opts?.flexCol, resizedCols],
  );

  return { widths, startResize, isFlexible };
}

/** Thin draggable strip for the right edge of a resizable header cell. */
export function ColumnResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
      className="absolute right-0 top-0 bottom-0 w-1.5 -mr-1 cursor-col-resize z-10 group/handle"
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover/handle:bg-ink" />
    </div>
  );
}
