# Lessons: React, CSS and component mechanics

Read this before building or changing anything in `packages/web/components/` or `app/`.
Visual and colour decisions live in [design-system.md](design-system.md), not here.

---

## React and state

**Define helper components that close over parent state at module scope, never inside a render function.** A new function reference every render makes React remount it, resetting focus and state. This is the classic search-input-loses-focus bug.

**In this codebase's self-fetching widgets, every `useMemo`/`useState`/`useEffect` must sit above the `if (loading) return <spinner>` guard, never after it.** A hook below an early return causes a "changed Hook order" error, so check hook order first when the console shows this.

**A view driven by both a prop and local state initialized from that prop will drift once the prop changes without a remount.** Don't shadow a URL/prop-derived value with local state. Navigate instead of calling `setState`.

**The React Compiler's `set-state-in-effect` lint rule cannot tell a legitimate external-system-sync effect from state that should be derived at render time, so read each flagged effect rather than bulk-disabling.** A timer tick, a `useLayoutEffect` localStorage restore before paint, a mount-triggered fetch, a DOM-class/`matchMedia` sync, and a prop-driven reset are all the rule's intended allowed case; each gets its own scoped `// eslint-disable-next-line` with a one-line rationale, not a blanket rule-category exclusion. That keeps the rule live for new code while making every exemption individually reviewable. `preserve-manual-memoization` has a separate false-positive: it treats any `.current` property access as a ref read even when the object is a plain value whose field happens to be named `current` (e.g. `WidgetSummary.current`). Same scoped-disable treatment, different reason.

**A comment inserted above a flagged line shifts every line number below it, so check for line-number-anchored tests (e.g. `TYPE_FLOOR_ALLOWLIST` in `type-hierarchy-balance.test.ts`) before trusting a lint fix is done.** Caught by running the full suite, not by the lint pass itself.

**A `useRef<'gui'|'kql'>` driver flag (not state) prevents feedback loops in bidirectional form-to-KQL sync.** Set it before updating one side so the matching effect on the other side is suppressed.

**Guard `onLayoutChange`-style callbacks (react-grid-layout and similar) with a ref-mirror comparison, not just a mount flag.** Prevents both false-positive dirty state and update-triggers-callback-triggers-update render loops.

**An automatic layout adjustment must tell the layout handler it was not a person.** Shrinking one widget makes react-grid-layout compact everything below it and report the new positions, which reads as a drag and shows "Save changes" to someone who only opened the page.

**Use `useLayoutEffect` (not `useEffect`) to restore `localStorage` state before first paint in Next.js client components.** `useState(() => readFromStorage())` causes a hydration mismatch: the initializer returns null on the server and rehydration reuses that null rather than re-running it.

**A `typeof window !== 'undefined'` branch read directly in render is a guaranteed hydration mismatch**, not a safe guard: the server has no `window`, so it renders the false branch, and the client's own first (pre-hydration) render pass runs the same render function and takes the true branch. Start state at the server-safe default (`useState('')`) and fill in the real value in a plain `useEffect` after mount instead.

**A ResizeObserver on a container never fires for content loading inside a fixed-height child.** Self-fetching widgets swap a spinner for content without changing any observed box, so pair it with a MutationObserver on the subtree. Otherwise the measuring pass only ever sees spinners.

**Section/tab nav state belongs in the URL (`?section=`), not React state alone.** A client-side remount (e.g. browser Back) loses local state. Read the initial value from server `searchParams` and sync changes via `router.replace`.

**A URL-sync effect that calls `router.replace` from component state must write back every param its own state initializer can read.** An asymmetric set silently strips deep-linked params the moment the effect first runs.

**A displayed "next run"/relative-time value computed server-side goes stale unless the client actively polls.** Recomputing the string from `Date.now()` doesn't help if nothing triggers a re-render.

**Track "unsaved changes" by diffing a snapshot against a baseline, not with an imperative `setDirty(true)` on every onChange.** The imperative version never clears when a change is reverted by hand. Only a real value comparison (`currentSnapshot !== baselineSnapshotRef.current`, baseline captured once via `useRef` at mount) makes "edit then undo" correctly go back to clean.

**A boolean backend/mode gate deciding which fields apply across more than one block of the same form component must be one shared function both blocks call, not the same condition re-typed at each call site.** `rule-form.tsx`'s two `isGraphBackend` checks drifted apart when Log Analytics became a third backend: one block was updated, the other missed it. Extracting the gate into `lib/rule-form-payload.ts`'s `deriveDedicatedEditorFields()` made that class of bug structurally impossible rather than just fixed once.

## Data fetching in components

**`fetch().then(r => r.json()).then(setState)` stores error bodies as if they were data.** A 401/403/500 body crashes on the first property access; in a grid of self-fetching widgets, one failed request takes down the whole page. Use a helper that returns a `{ok,data}`/`{ok:false}` result, never null on failure. Null collapses a real error into the same shape as a genuinely empty result, so the widget can't tell "broken" from "nothing to show."

**A self-fetching widget needs a third visual state, not just loading/empty.** `useWidgetFetch` + `WidgetUnavailable` give every widget a shared "Couldn't load this widget" + Retry state, scoped per-widget. Retry refetches only the widget it's clicked on, not the dashboard-wide `refreshKey`.

**When migrating widgets to self-fetch-with-merged-filter-object, a fetch call can compute the merged object correctly but still forward only a subset of its fields into the actual request.** Audit that every field of the merged object reaches the query string.

**A diagnostics page's slow check results (live network calls) should be manual-only and stored in `localStorage`.** Auto-running on mount keeps the page blank while the call runs. Fast local reads can auto-run since they're always current.

**A route that swallows every failure into the same "empty" response shape as a genuine empty result hides "the backend is unreachable" from the client entirely.** Let the error propagate to a real non-2xx status, then have the client read the body even on non-ok and show the server's own message. Don't collapse "no data" and "couldn't ask" into one code path.

**A mutation handler checking only `!res.ok` still misses a rejected `fetch` (genuine network failure), which bypasses response handling entirely.** Wrap in `try`/`catch`, clear stale errors before the request, and move busy-flag cleanup into `finally`. Otherwise a failed click leaves the button permanently disabled with no visible error.

## Layout and CSS

**Flex header titles need both `min-w-0` (container) and `truncate` (text) to actually truncate**, because flex children default to `min-width: auto` and won't shrink without `min-w-0`.

**A `flex-1 min-h-0` child does nothing unless its parent is a flex container.** It grows past the box and is silently clipped with no scrollbar, and any code measuring it sees zero unused space. Check the parent, not the child, when a fill-and-scroll region will not scroll.

**CSS grid children stretch to fill their cell by default, even inline elements.** Add `w-fit` to badges/chips that are direct grid children and should stay content-sized.

**A collapse/hover-flyout sidebar needs a wrapper `<div>` (reserving layout space) separate from the `<aside>` (which renders the current width).** Leaving the wrapper at a fixed rail width while the aside expands makes it paint over adjacent content rather than push it.

**Toggling an element's `position` (e.g. static → absolute) in the same render that a width transition starts can produce a one-frame glitch in Chromium.** Keep the element always absolutely positioned so only `width` ever interpolates.

**A hard conditional (`cond ? <A/> : <B/>`) swaps DOM subtrees instantly with no transition.** If the swap needs to feel smooth, keep both variants mounted and cross-fade with `opacity` + `transition-opacity` instead.

**Tailwind 4's `translate-x-*` writes the CSS `translate` property, not `transform`.** `getComputedStyle(el).transform` reads `none` on a correctly translated element, so probe `translate` or measure geometry before believing a component is broken.

## Scrolling

**Any ancestor with `overflow` other than `visible` becomes a CSS scroll container**, breaking portal dropdowns (use `overflow-visible` and round an inner element) and making `position: sticky` bind to the wrong ancestor. Apply sticky per-`<th>`, not on the `<tr>`.

**`overflow-x-auto` alone can make an element scroll vertically too** (CSS forces the other axis to `auto` if left `visible`), so always pair it with an explicit `overflow-y-hidden` when only horizontal scroll is wanted.

**`overscroll-behavior: contain` blocks the wheel from reaching the page even on an axis the element cannot scroll.** A table that only scrolls sideways swallowed every vertical wheel event, so the page sat still until the pointer moved off it. Let scroll regions chain upward.

**A page that adds its own scroll box inside the app's one scroll region makes the wheel stop dead partway down.** Whichever container the pointer is over wins, so scrolling resumes only after moving the cursor. The dashboard grid had exactly this.

**When a list already has a "Show all" control, an inner `max-h` scrollbar defeats it.** Pick one: bounded box or page scroll. The app has exactly one scroll region for this reason.

## Tables

**`w-px whitespace-nowrap` on both `<th>` and `<td>` is the standard shrink-to-content table column pattern.** `w-fit` on a child alone does not stop the cell itself from stretching.

**A `max-width` on a `<td>` does nothing under `table-layout: fixed`**, because width comes from the `<colgroup>`. To widen one column, take pixels from the others.

**Resizable table columns: derive one `gridTemplateColumns` string from a single `Record<Col, width>` state, apply it to header and rows both.** Set `document.body.style.cursor`/`userSelect` during drag.

**Resizable columns need one designated "flex" column that absorbs leftover width until dragged**, or the table renders shrunk left with dead space on the right once every column has an explicit pixel width.

**A table with drag-resizable columns and a header stuck to the page scroll cannot both exist.** Sticky binds to the nearest scroll container, and the column widths live in a `<colgroup>` that a detached header cannot share.

**An in-place edit row inside a table keeps the `<thead>` visible, making column headers float above an unrelated form.** Hide the `<thead>` while `editingId !== null || creating`.

## Dropdowns, portals and popovers

**Any custom dropdown inside a `Card` (`overflow: hidden`) needs a portal** (`createPortal` + `getBoundingClientRect` + `position: fixed`) or it gets clipped.

**A portal dropdown needs a real `width` constraint, not just `minWidth`.** `truncate` does nothing against an auto-sized box, and long content can run the panel off the viewport edge.

**A portal's own click-outside overlay must `stopPropagation()`** or the same mousedown bubbles to `document` and can also close a parent popover it's logically nested inside.

**A `sticky` + `z-index` parent creates a stacking context that caps its children's effective z-index.** Prefer `document.addEventListener('mousedown')` + `ref.contains()` over z-index escalation for click-outside overlays.

**For complex multi-step dropdowns (tree pickers, search), reposition on scroll rather than closing on scroll**, because closing breaks interactions mid-scroll.

**A full-viewport guard (e.g. minimum-width notice) must be a CSS-shown overlay sibling, never a wrapper that hides `children`.** Several surfaces portal straight to `document.body` outside any wrapper's subtree, so hiding the wrapper leaves them visible and interactive underneath the notice.

**`@base-ui/react`'s Dialog needs its Viewport and Title rendered explicitly, not just Root/Backdrop/Popup.** Viewport carries positioning (centered vs. right-docked) that a hand-rolled wrapper used to provide, and Title is what wires `aria-labelledby`; omitting either silently drops positioning or the dialog's accessible name. It is the same primitive Select, Popover and DropdownMenu already use.

**Smart dropdown flip: compare space above vs. below the anchor before choosing direction**, and make the dropdown a flex column with a scrollable inner list so it fills whatever space it gets.

## Filters and forms

**Per-column filter checklists must build their option lists (with counts) from the unfiltered pool, not the currently-filtered view.** Otherwise options vanish as you narrow and you can't widen back.

**When several filter dimensions all feed the same aggregate/stats pool, each dimension must exclude only itself when computing its own option list/stats.** Otherwise selecting one value can erase sibling options from its own dropdown.

**A checklist filter that truncates its labels is unusable for anything whose names differ at the end.** Rule names do, so let the label wrap and give the panel real width instead of `w-72` plus `truncate`.

**A `<select>` migrating from a hardcoded list to DB-backed options must still show a record's current value even if it fell out of the DB list.** Union the DB options with the record's own value.

**Resource-type/property-schema form sections only apply at `scopeLevel === 'resource'`**, so wrap them conditionally. They're meaningless at RG/Sub/MG scope.

**Add a `readOnly` prop to an existing form rather than building a separate view-only component** that duplicates its layout, because duplication drifts and misses fields.

**Read-only mode means "show all information, disable interaction", so never hide informational content behind the same guard that disables editing.** Hide only authoring tools; always show information.

**"Duplicate" should navigate to a pre-populated new-record form, not call the API and autosave**, because the user hasn't confirmed the copy yet.

**A feature gated on `channels.length > 0` is invisible to new users, so always render an empty state instead.** Hiding a UI section entirely when its data is empty trains users to think the feature doesn't exist.

**Don't render a URL embedded in a data field as if it were incidental text.** Split it out and render it as a clickable link rather than showing the raw string.
