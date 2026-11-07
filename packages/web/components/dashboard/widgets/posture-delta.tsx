import type { WidgetSummary } from '@/lib/dashboard-data';
import { baselineGapMessage } from '@/lib/posture-baseline';
import { pointsLabel } from '@/lib/posture-math';
import { trendUnavailableMessage } from '@/lib/trend-scope';
import { Delta } from '@/components/dashboard/widgets/delta';
import { WidgetUnavailable } from '@/components/dashboard/widgets/widget-unavailable';

type Slot = Pick<WidgetSummary, 'deltaPct' | 'baseline' | 'baselineGap' | 'trendUnavailable'>;

/** The change under a posture figure, shared by the ring and the stat card: "+25 pts vs <date>" when a
 *  baseline was built, otherwise the reason there is none, in place of the delta so the live number
 *  above it still shows. Nothing when the filters carry no trend at all. */
export function PostureDelta({ summary, size }: { summary: Slot; size?: 'sm' | 'xs' }) {
  if (summary.deltaPct !== null && summary.baseline) {
    return (
      <Delta
        value={summary.deltaPct}
        text={pointsLabel(summary.deltaPct, summary.baseline.date)}
        size={size}
        display="inline-flex"
      />
    );
  }
  if (summary.trendUnavailable) return <WidgetUnavailable inline reason={trendUnavailableMessage(summary.trendUnavailable)} />;
  if (summary.baselineGap) return <WidgetUnavailable inline reason={baselineGapMessage(summary.baselineGap)} />;
  return null;
}
