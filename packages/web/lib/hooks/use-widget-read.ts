'use client';

import { createContext, useContext } from 'react';
import type { WidgetReadTarget } from '@/lib/dashboard-filters';

/**
 * The dashboard and the widget a widget is drawn for. Every widget names them in its read (#375), so the
 * server can add back the values each place holds that the viewer's Access does not reach. A widget drawn
 * outside a dashboard sees `null` and reads its merged filters, as before.
 */
export const WidgetReadContext = createContext<WidgetReadTarget | null>(null);

export function useWidgetReadTarget(): WidgetReadTarget | null {
  return useContext(WidgetReadContext);
}
