'use client';

import { useCallback, useState } from 'react';

/** Azure-portal-style collapse/pin preference for a sidebar, persisted to a cookie rather than
 *  localStorage — cookies are sent with the request and readable during server rendering, so the
 *  server can render the *correct* initial state directly. localStorage can't be read until after
 *  hydration, which either flashes the wrong default or needs extra logic to suppress the
 *  transition on that one corrective render. The caller reads the cookie server-side (see
 *  `app/(app)/layout.tsx` and `app/(app)/library/page.tsx`) and passes it in as `initialPinned`,
 *  so client and server agree from the very first paint — no correction, no flash.
 *
 *  `pinned` is the docked-open/collapsed-rail preference the user explicitly set; `hovering` is
 *  transient (never persisted). `expanded = pinned || hovering` is the one flag consumers need to
 *  decide "show labels / wide" vs. "icon rail." */
export function useSidebarPref(key: string, initialPinned: boolean) {
  const [pinned, setPinnedState] = useState(initialPinned);
  const [hovering, setHovering] = useState(false);

  const setPinned = useCallback((next: boolean) => {
    setPinnedState(next);
    document.cookie = `${key}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  }, [key]);

  const hoverHandlers = {
    onMouseEnter: useCallback(() => setHovering(true), []),
    onMouseLeave: useCallback(() => setHovering(false), []),
  };

  return {
    pinned,
    expanded: pinned || hovering,
    setPinned,
    hoverHandlers,
  };
}
