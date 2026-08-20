/** Theme preference — shared by the server (root layout reads the cookie) and the client
 *  (the provider writes it). Kept free of React and of any Node-only import so both sides
 *  and the edge/proxy bundle can import it safely.
 *
 *  Three states, not two. `system` is the default and means "follow the operating system,"
 *  which is what people now expect; `light` and `dark` are explicit choices that override it.
 *  Light is the fallback whenever the OS preference cannot be determined.
 *
 *  Persisted in a cookie rather than localStorage for the same reason as the sidebar
 *  preference (see `lib/hooks/use-sidebar-pref.ts`): a cookie is sent with the request and
 *  can be read during server rendering, so the server emits the correct `class` on <html>
 *  from the very first byte. localStorage is not readable until after hydration, which
 *  means a white flash for every dark-mode user on every page load. */

export type ThemePreference = 'light' | 'dark' | 'system';

/** Resolved ground actually applied to the document. `system` is never a resolved value. */
export type ResolvedTheme = 'light' | 'dark';

export const THEME_COOKIE = 'theme';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

export function parseThemePreference(value: string | undefined | null): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : DEFAULT_THEME_PREFERENCE;
}

/** The class name Tailwind's dark variant keys off (`@custom-variant dark (&:is(.dark *))`).
 *  Applied to <html>. */
export const DARK_CLASS = 'dark';

/** Runs in <head> before first paint, so a dark-mode user never sees a white flash.
 *  Only needed for the `system` preference — for an explicit choice the server already
 *  stamped the class. It is written as a string rather than a real function because it has
 *  to be inlined into the HTML document; keep it small, dependency-free, and total (any
 *  throw here would block rendering, hence the try/catch).
 *
 *  Kept in sync by construction: it reads the same cookie name and applies the same class
 *  as the constants above. */
export const THEME_INIT_SCRIPT = `(function(){try{
var m=document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=([^;]*)/);
var p=m?decodeURIComponent(m[1]):'${DEFAULT_THEME_PREFERENCE}';
var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.classList.toggle('${DARK_CLASS}',d);
}catch(e){}})();`;
