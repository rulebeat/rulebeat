# Lessons: the "Grid" design system

Read this before any visual change: colour, type, severity, charts, spacing, borders.
Component and CSS *mechanics* live in [ui.md](ui.md). The design system itself is described in
`CLAUDE.md` under "Design system"; this file is the record of what went wrong getting there.

---

## Colour and tokens

**Hardcoded dark-theme color classes (e.g. `text-red-400`) survive a light-theme migration invisibly** since only CSS-variable tokens auto-flip. Grep for `-(red|green|blue|amber|orange|slate)-(300|400)` after any theme change.

**A colour audit that greps `.tsx` for palette classes misses three hiding places:** hex literals inside `style={{}}` and SVG props, shared `*-constants.ts` files, and a mapped semantic alias that looks identical to a literal but is the only one that flips.

**A permanently-dark region inside a light app forces every component in it to hardcode `text-white/50`-style opacity, all of which breaks the moment real dark mode arrives.** The dark sidebar was retired for exactly this: one token set that flips is cheaper than a second palette that cannot.

**A flash-free theme needs both halves: a cookie the server reads to stamp the class in the first byte, and a pre-paint inline script for the "follow the OS" case.** localStorage cannot be read during server rendering, and the server cannot know the OS setting. Drop either half and dark-mode users get a white flash.

**Never give the primary action and the destructive action the same colour token.** A red Create button beside a red Delete button trains people to stop reading red; make primary ink and spend the accent on the focus ring, which is transient.

**A headless-browser pass that probes for text-colour-equals-background, `scrollWidth > clientWidth` and console errors catches theme bugs no grep or typecheck can.** Render every screen in both themes; the probe is cheap and the failures are invisible in source.

**An `opacity-*` utility stacked on top of an already-contrast-safe token (`ink-2`/`ink-muted`/`ink-faint`) silently undoes that token's measured contrast guarantee.** The token was tuned to clear 4.5:1 on its own; multiplying it by 60% opacity for a "more secondary" look dropped a scans-tab badge to 3.35:1 and shipped invisibly until axe caught it. De-emphasize with a lighter token, never `opacity-*` on top of one that already carries a contrast budget.

**`ink-muted` (captions/timestamps/helper text) and `ink-faint` (placeholder/disabled/decorative/status-ramp only) are each gated by their own architecture-test guardrail**: an `ALLOWED_FAINT_FILES` allowlist for the latter, a hardcoded `INK_MUTED_CEILING` count for the former, both in `type-hierarchy-balance.test.ts`. A new legitimate caption call site needs the right tier picked by role, not by which check is easier to satisfy, plus the ceiling bumped with a one-line rationale.

## Severity and encoding

**Encoding an ordered scale by weight alone does not survive contact with a real screen.** Greyscale severity made High a solid black square (the loudest mark on a page that must lead with red) and left Medium and Low as two greys with no readable order; a hot-to-neutral hue ramp plus weight is still one scale, not a rainbow.

**A large filled shape in the darkest available colour outshouts whatever the alarm colour is.** Bars, area fills and the lead chart series must sit below the severity palette in weight, so black belongs to type and hairlines, never to a chart.

**Encode a taxonomy by shape and letter, not by hue, when the palette already spends colour on severity.** Two colour scales on one screen means neither reads; a filled-vs-hollow mark carries the same bit for free.

**A state that is merely normal should be a quiet chip, never a filled coloured panel.** Reserve callouts for problems or something the reader can act on, or the page cries wolf on every load.

**Only flag a warning status for states the user can actually act on.** Stale individual schema-cache entries are normal and unactionable, so reserve non-green status for states with a concrete remediation (nothing cached at all, or main type list stale).

## Type

**Never use sub-12px text.** `text-xs` (12px) is the floor; fix violations in one sweep, not per-file, or two chip sizes on the same screen look more broken than the original. `label-grid`/`label-grid-strong` (11px, `app/globals.css`) are the one deliberate, contained exception, verified at that size in a full type sweep and enforced by `type-hierarchy-balance.test.ts`'s `TYPE_FLOOR_ALLOWLIST`; nothing else gets to be smaller without a named file:line entry there.

**Set text tiers from a measured contrast ratio, not by eye.** The muted and faint tiers came out at 5.10:1 and 2.78:1 on white and read as washed out on the sidebar, table headers and widget captions, the three surfaces that use them most.

**11px uppercase letterspaced type needs a stronger colour than its size suggests, not a weaker one.** The shared micro-label utility takes the secondary ink tier, not the muted one; a caption can be quieter than its value without being faint.

**The name of a panel is a title, not a caption: `title-grid`, never `label-grid`.** The widget header used the caption style, so a widget's own name rendered lighter than the column headers inside it; sentence case at 14px is also 14% narrower than 11px uppercase at 0.1em tracking, so it truncates less.

**Count how often a codebase applies weight versus colour before trusting its type scale.** 583 ink-tier applications against 168 weight ones (130 of them the same value) means hierarchy is riding on the channel the design system reserves for severity. A grep answers this in seconds and no amount of squinting does.

## Borders, ground and repetition

**A border that is defensible on one element is fussy on the twenty that repeat.** Separate panels by ground (fill on a sunken canvas) and make small elements soft fills; keep a line only where it does structural work.

**When every hairline is the same weight, none of them reads as structure.** Softening the shared rule token quiets all 85 call sites at once, but it also flattens the one line that gave the layout its spine. Add a separate anchor token used at a single call site rather than leaving the ramp flat.

**Dropping a chip's border is not safe until you know what it sits on.** The same `bg-surface-sunken` chip is invisible inside a sunken panel. The fill has to contrast with its actual parent, so a blanket find-and-replace across chip call sites will erase a few of them.

**A hover token borrowed from a white surface moves a grey chip the wrong way, and the wrong way again in dark.** A filled element needs its own hover token defined per theme, not a reused `surface-hover`.

**A row of gap-separated flex items whose first cell varies in width means no two rows in a list ever line up.** Reserve fixed-width slots, including for the badge most rows do not have.

**A control faded to 50% when disabled becomes unreadable on screens where everything is disabled** (read-only role, demo mode). Someone who cannot press a switch still has to be able to tell what it says.

## Charts

**Recharts takes neither a Tailwind class for SVG paint nor the theme's colour for its own chrome.** Use `fill`/`stroke="var(--color-…)"`, and pass axis-tick and legend styles explicitly from shared constants, or they stay a fixed grey in both themes.

**An area fill encodes "quantity under the curve" and only reads for a single series.** Force plain lines the moment a second series can appear, or the overlap reads as a stacked total nobody computed.
