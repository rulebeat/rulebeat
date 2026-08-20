'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DARK_CLASS,
  THEME_COOKIE,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme';

interface ThemeContextValue {
  /** What the user chose: light, dark, or follow the operating system. */
  preference: ThemePreference;
  /** What is actually on screen right now. Never 'system'. */
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(preference: ThemePreference): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemPrefersDark() ? 'dark' : 'light';
}

/** Wraps the app so any component can read or change the theme.
 *
 *  `initialPreference` comes from the cookie, read server-side in the root layout, so the
 *  first client render already agrees with the server-rendered HTML. The inline script in
 *  <head> has additionally resolved the `system` case onto <html> before paint, so by the
 *  time this mounts the correct ground is already showing and there is nothing to correct. */
export function ThemeProvider({
  initialPreference,
  children,
}: {
  initialPreference: ThemePreference;
  children: React.ReactNode;
}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);

  /* `resolved` starts from the preference alone rather than from matchMedia, because on the
     server matchMedia does not exist and guessing here would produce a hydration mismatch.
     The effect below corrects it on mount, which is a no-op in every case except `system`
     on a dark machine — and there the inline script has already painted dark, so the
     correction is invisible. */
  const [resolved, setResolved] = useState<ResolvedTheme>(
    initialPreference === 'dark' ? 'dark' : 'light',
  );

  const apply = useCallback((next: ResolvedTheme) => {
    document.documentElement.classList.toggle(DARK_CLASS, next === 'dark');
    setResolved(next);
  }, []);

  /* Keep the document in step with the preference, and — when following the system — with
     the operating system as it changes. Someone flipping their machine to dark at sunset
     should see RuleBeat follow without a reload. */
  useEffect(() => {
    // Synchronizing the DOM class and OS media-query subscription — the canonical external-system
    // effect, not derivable render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    apply(resolve(preference));
    if (preference !== 'system') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => apply(event.matches ? 'dark' : 'light');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference, apply]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
