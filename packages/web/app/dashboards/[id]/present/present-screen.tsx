'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GridLayout, useContainerWidth } from 'react-grid-layout';
import { Maximize2, X } from 'lucide-react';
import { buttonVariants, Button } from '@/components/ui/button';
import { NoWidgetsYet } from '@/components/dashboard/no-widgets-yet';
import { PresentProvider } from '@/components/dashboard/present-context';
import { WidgetRenderer } from '@/components/dashboard/widget-renderer';
import { useFitWidgetsToContent } from '@/components/dashboard/use-fit-widgets-to-content';
import { ROW_HEIGHT, ROW_MARGIN } from '@/components/dashboard/dashboard-constants';
import { escapeAction, offersFullScreen } from '@/lib/present';
import { widgetHasScopeOverrides, type WidgetFilters } from '@/lib/dashboard-filters';
import type { OutsideAccess } from '@/lib/outside-access';
import type { Dashboard, WidgetDef } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Whether the browser would let the page go full screen now. Hidden until the page is on the client, so the server never offers it. */
function useFullScreenOffered(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('fullscreenchange', onChange);
      return () => document.removeEventListener('fullscreenchange', onChange);
    },
    () => offersFullScreen(document),
    () => false,
  );
}

/** The Full screen button. Nothing renders when the browser cannot do it or the page already is. */
export function FullScreenButton({ offered, onRequest }: { offered: boolean; onRequest: () => void }) {
  if (!offered) return null;
  return (
    <Button size="sm" variant="outline" className="gap-1.5" onClick={onRequest}>
      <Maximize2 className="size-3.5" />Full screen
    </Button>
  );
}

/**
 * Present's frame: the dashboard's name, Full screen and Exit above one scroll region. Esc leaves like Exit
 * does, except in browser full screen, where the first Esc is the browser's and only leaves full screen.
 */
export function PresentFrame({ name, exitHref, children }: { name: string; exitHref: string; children: ReactNode }) {
  const router = useRouter();
  const offered = useFullScreenOffered();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (escapeAction(event, document) === 'exit') router.push(exitHref);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [router, exitHref]);

  // Only ever called from the button's click: a browser refuses the request without a gesture, and a
  // refusal is not worth a message, so it is dropped.
  const requestFullScreen = useCallback(() => {
    try {
      document.documentElement.requestFullscreen().catch(() => undefined);
    } catch {
      // A browser without the API throws instead of rejecting.
    }
  }, []);

  return (
    <PresentProvider value={true}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-rule-strong bg-surface px-4 py-2">
          <h1 className="title-grid min-w-0 flex-1 truncate">{name}</h1>
          <FullScreenButton offered={offered} onRequest={requestFullScreen} />
          <Link
            href={exitHref}
            className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'gap-1.5')}
            onClick={() => { if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined); }}
          >
            <X className="size-3.5" />Exit
          </Link>
        </div>
        {/* Present's single scroll region: a tall layout scrolls here, never the page. */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </PresentProvider>
  );
}

interface GridProps {
  dashboard: Dashboard;
  /** The filters Present reads with: the saved filter bar with the URL filters laid over it. */
  filters: WidgetFilters;
  outsideAccess: OutsideAccess;
}

/** The dashboard's grid with nothing in it to change: the same 12 columns at the screen's own width, never scaled. */
export function PresentGrid({ dashboard, filters, outsideAccess }: GridProps) {
  const [widgets, setWidgets] = useState<WidgetDef[]>(dashboard.config.widgets);
  const widgetsRef = useRef(widgets);
  useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
  const { width, containerRef } = useContainerWidth({ initialWidth: 1200 });
  useFitWidgetsToContent({ containerRef, widgetsRef, setWidgets, enabled: true, triggers: [widgets, width] });

  const hasActiveFilters = Boolean(
    filters.categories?.length || filters.subscriptions?.length || filters.resourceGroups?.length
    || filters.tags?.length || filters.severities?.length || filters.ruleIds?.length,
  );

  return (
    <div className="px-4 py-4" ref={containerRef as React.RefObject<HTMLDivElement>}>
      {widgets.length === 0 ? (
        <NoWidgetsYet />
      ) : (
        <GridLayout
          width={width}
          layout={widgets.map(w => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 2 })) as never}
          gridConfig={{ cols: 12, rowHeight: ROW_HEIGHT, margin: [ROW_MARGIN, ROW_MARGIN] as const, containerPadding: null, maxRows: Infinity }}
          dragConfig={{ enabled: false }}
          resizeConfig={{ enabled: false }}
        >
          {widgets.map(w => (
            <div key={w.id} data-grid-item={w.id}>
              <WidgetRenderer
                widget={w}
                filters={filters}
                filtered={hasActiveFilters || widgetHasScopeOverrides(w.config)}
                refreshKey={0}
                editMode={false}
                outsideAccess={outsideAccess}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
