/**
 * Below 1024px the app shell (sidebar, tables, dashboard grid) has no defined layout, so this
 * covers the page with a plain notice instead of a broken one. Shown via a CSS media query, not
 * JS `matchMedia`, so there is no flash of the broken layout before it can react. It has to be an
 * overlay rather than a wrapper that hides `children`: several surfaces (e.g. the date range
 * picker) portal straight to `document.body` outside any wrapper's subtree, so hiding `children`
 * would leave them visible underneath. z-[2000] sits above every existing portal in the app (the
 * highest today is date-range-picker.tsx's z-index: 1000).
 *
 * `max-[1024px]:` (not `max-[1023px]:`) is deliberate: Tailwind compiles an arbitrary `max-*`
 * variant to `not (min-width: <value>)`, which is exclusive of the value itself — so
 * `max-[1023px]` would stay hidden at exactly 1023px, one pixel narrower than the guard is
 * supposed to cover. `max-[1024px]` is the one that actually means "below 1024px".
 */
export function MinWidthGuard() {
  return (
    <div
      className="fixed inset-0 z-[2000] hidden max-[1024px]:flex items-center justify-center bg-background px-8 text-center"
      role="alert"
      aria-label="Widen your browser window to use RuleBeat"
    >
      <p className="text-ink text-sm" aria-hidden="true">Widen your browser window to use RuleBeat.</p>
    </div>
  );
}
