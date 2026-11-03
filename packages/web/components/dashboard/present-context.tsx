'use client';

import { createContext, useContext } from 'react';

/**
 * True below Present's page. Widgets read it for the two things that differ there: a chart draws at once
 * instead of animating in, and a reason a widget shows in place of a number is not a live region (nothing
 * on a screen on the wall is listening for a change). The ordinary dashboard never provides it.
 */
const PresentContext = createContext(false);

export const PresentProvider = PresentContext.Provider;

export function usePresenting(): boolean {
  return useContext(PresentContext);
}

/** The `isAnimationActive` value for a chart series: on in the ordinary view, off on Present. */
export function useChartAnimation(): boolean {
  return !usePresenting();
}
