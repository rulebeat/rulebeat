RuleBeat brand assets
Built 2026-08-12


WHAT THE MARK MEANS

The black is your Azure estate. The red is the one thing that needs attention.

That is the standing description. Use it in the README, on the website, and
anywhere the logo needs explaining.


THE ONE RULE

Only ever one red square in view. Never two.

The tile carries the red square. So when the tile and the name appear together,
the name drops its full stop. That is why there are two cuts of the wordmark:

  rulebeat-wordmark-*        has the red full stop. Use it ALONE.
  rulebeat-wordmark-plain-*  no full stop. Use it BESIDE THE TILE.

If you ever assemble a lockup by hand, use the plain cut. The ready-made
lockups in lockup/ already do this for you.


LIGHT AND DARK

Every asset has a -dark- twin. Pick by the background you are placing it on,
not by the file's own colour:

  no -dark-   for light backgrounds. Black tile, black letters.
  -dark-      for dark backgrounds. Off-white tile, off-white letters.

The wordmarks and lockups have transparent backgrounds, so they sit on any
ground. The icons are solid squares by design.


THE FILES

icon/
  rulebeat-icon-512 down to -16, and the -dark- set.
  Square app icon. 180 is the Apple touch icon, 32 and 16 are browser tab
  sizes. Use 512 as the master anywhere you need to scale down.

favicon.ico
  16, 32 and 48 in one file. This is the one that goes at the site root.

avatar/
  512 square, light and dark. GitHub, LinkedIn, X, Docker Hub.
  Same art as the icon, named separately so you do not have to think about it.

wordmark/
  rulebeat-wordmark-806 / -400 / -200        the name with its red full stop
  rulebeat-wordmark-plain-750 / -400 / -200  the name without it
  rulebeat-wordmark(-plain)(-dark).svg       vector master, see below

  There used to be a third cut here — the name plus an "AZURE GOVERNANCE"
  tagline baked into the PNG. Removed 2026-08-17, see VECTOR MASTERS below.
  Any positioning line now lives as page copy (website hero, README), not
  as pixels in a logo asset.

lockup/
  rulebeat-lockup-611 / -306 / -153, light and dark.
  Tile plus name, correctly spaced and aligned. Use these rather than
  positioning the two pieces yourself.

social/
  rulebeat-social-1200x630, light and dark.
  Open Graph and Twitter card image. This is what shows when someone pastes
  a rulebeat.com link into Slack, Teams, LinkedIn or X.


COLOURS

  Red         #E3000F   same token as --destructive and --sev-critical
  Ink light   #000000
  Ink dark    #F4F4F2
  Page light  #F1F1EF
  Page dark   #0B0C0D

The red in these files is exactly the product's red. It was measured off the
built PNGs, not eyeballed. Do not substitute another red.


VECTOR MASTERS

Both the tile and the wordmark now have vector masters — neither is
redrawn or re-typeset, both are direct traces of the existing artwork's own
pixels.

The wordmark was resolved first (2026-08-17): its letters and full-stop dot
were traced with potrace (bitmap-to-vector tracing, the same technique
behind Illustrator's Image Trace), giving rulebeat-wordmark.svg / -plain.svg
/ -dark variants in wordmark/. Full detail and provenance are in
brand/source/wordmark_vector.py's docstring. The wordmark PNGs (-806/-400/
-200 and the plain cuts) are rasterized straight from that same vector path
data too, via a small pure-Python scanline rasterizer in
brand/source/vectorkit.py — one source of truth for both the SVGs and the
PNGs, rather than two independent derivations of the same artwork.

The tile/icon (the R-in-a-square) followed the same day: its R glyph was
isolated as a clean bitmap and traced with potrace, and the accent square —
a sharp-edged, axis-aligned 70x70 region with no curves — was measured
directly from the coverage data rather than traced, which is both simpler
and truer to the "hard corners everywhere" design system rule than an
approximated path would be. Full detail and provenance are in
brand/source/tile_vector.py's docstring. This gives rulebeat-icon.svg /
-dark.svg in icon/, and every PNG tile (icon set, favicon.ico, avatar,
lockups, social card) now rasterizes from that same vector data, so the
tile stays sharp at any print size or screen use above 500px, not just the
sizes supplied.

There was a third piece here — a tagline composite (name + "AZURE
GOVERNANCE") baked directly into the PNG, built from photographic-style
flat fills rather than clean line art potrace could trace, so it never got
a vector master. It's gone now, not fixed: putting Azure's name in the same
visual weight as RuleBeat's own mark read as if Azure were part of
RuleBeat's brand identity rather than a description of what it targets.
Removed 2026-08-17 rather than reworded — see build.py's module docstring
for the fuller reasoning. Any positioning line is page copy now, never
pixels in a logo asset again.

The typeface question this was blocking is also resolved, and differently
than either "identify and license it" or "convert to outlines" above
assumed: the wordmark's typeface has still never been identified, but
because the vector master is a direct trace of the existing raster
artwork's pixels rather than newly-set type, there is no re-creation event
for a font licence to apply to — nothing was set in that font to produce
these files. (A font's EULA governs setting type with it, not display of
an already-existing flattened image; converting to outlines doesn't
retroactively license anything on its own, but tracing already-existing
pixels never invoked the font in the first place.) Abdo made this call
2026-08-17 after being shown the distinction.
