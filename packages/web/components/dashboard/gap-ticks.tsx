'use client';

import { usePlotArea, useXAxisScale } from 'recharts';

/** A short ink-faint tick under the axis for each day nobody recorded. A bar chart leaves a gap day
 *  empty, which on its own looks the same as a day with a tiny count, so the tick says "no record"
 *  without drawing a bar that claims a value. Rendered as a child of the chart so it can read the
 *  axis scale; pair it with a `tickMargin` on the XAxis so the labels sit below the tick. */
export function GapTicks({ dates }: { dates: readonly string[] }) {
  const scale = useXAxisScale();
  const area = usePlotArea();
  if (!scale || !area) return null;
  const axisY = area.y + area.height;
  return (
    <g data-gap-ticks>
      {dates.map(date => {
        const x = scale(date, { position: 'middle' });
        if (x === undefined) return null;
        return <line key={date} x1={x} x2={x} y1={axisY + 2} y2={axisY + 7} stroke="var(--color-ink-faint)" strokeWidth={2} />;
      })}
    </g>
  );
}
