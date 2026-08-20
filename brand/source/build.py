"""Regenerates the whole RuleBeat brand kit from its source artwork.

    python brand/source/build.py

The tile and the wordmark itself ("RuleBeat." and its full-stop dot) are
both rasterized straight from traced vector paths (tile_vector.py /
wordmark_vector.py — see each file's docstring for provenance). Nothing is
redrawn or newly typeset. Paths resolve against this file, so it runs the
same from any working directory.

There used to be a third wordmark cut here — the name plus an "AZURE
GOVERNANCE" tagline baked directly into the PNG. It was removed 2026-08-17:
putting Azure's name in the same visual weight as the product's own mark
read as if Azure were part of RuleBeat's brand identity, not a description
of what it targets. The fix was to drop the baked-in slogan entirely rather
than reword it — any positioning line now lives as page copy (website hero,
README), never as pixels in a logo asset, so wording can change without
touching this pipeline. See brand/README.txt.

Set RULEBEAT_WEB="" to skip writing the copies into packages/web."""
import os
from pngkit import write_png, write_ico, scale, solid, over
from vectorkit import parse_path, rasterize_alpha, tint
from wordmark_vector import (
    WM_VECTOR_W, WM_VECTOR_H, WM_VECTOR_PLAIN_W,
    WM_LETTERS_PATH, WM_DOT_PATH,
)
from tile_vector import TILE_VECTOR_W, TILE_VECTOR_H, TILE_DOT_RECT, TILE_R_PATH

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.normpath(os.path.join(HERE, '..'))
for sub in ['icon', 'wordmark', 'lockup', 'social', 'avatar']:
    os.makedirs(os.path.join(OUT, sub), exist_ok=True)

# ---- tokens -------------------------------------------------------------
RED        = (227, 0, 15, 255)      # --destructive / --sev-critical
INK_L      = (0, 0, 0, 255)         # --ink light
SURFACE_L  = (255, 255, 255, 255)   # --surface light
INK_D      = (244, 244, 242, 255)   # --ink dark
SURFACE_D  = (23, 25, 27, 255)      # --surface dark
BG_L       = (241, 241, 239, 255)   # --background light
BG_D       = (11, 12, 13, 255)      # --background dark
CLEAR      = (0, 0, 0, 0)

# ---- source geometry ----------------------------------------------------
# TILE_CROP (294, 276, 470, 470) and WM_CROP (109, 191, 806, 132) no longer
# feed a decompose() call — both were traced once (tile_vector.py,
# wordmark_vector.py) and everything below rasterizes from that instead.
# Letters end at local x=858 of WM_CROP; the red full stop sits at 875..914.
# Cropping the 806-wide vector to 750 wide (WM_VECTOR_PLAIN_W, below) drops
# the stop with no redrawing — that's why WM_LETTERS_PATH covers roughly
# [0, 750] and WM_DOT_PATH sits past it, in [766, 805] (wordmark_vector.py).
# The former WMT_CROP/WMTP_CROP tagline crops (name + raw-pixel "AZURE
# GOVERNANCE" caption) are gone along with the tagline cut itself — see the
# module docstring above.

# ---- tile: rasterized straight from the traced vector path, plus a
# literal rect for the accent square (see tile_vector.py) -----------------
print('rasterizing tile vector')
_tile_r_sp = parse_path(TILE_R_PATH)
_tile_r_alpha = rasterize_alpha(_tile_r_sp, (0, 0, TILE_VECTOR_W, TILE_VECTOR_H),
                                 TILE_VECTOR_W, TILE_VECTOR_H)
_dot_x, _dot_y, _dot_w, _dot_h = TILE_DOT_RECT

def _tile_layer(r_alpha, w, h, ink_rgba, surface_rgba):
    base = solid(w, h, ink_rgba)
    base = over(base, w, h, tint(r_alpha, surface_rgba), w, h, 0, 0)
    base = over(base, w, h, solid(_dot_w, _dot_h, RED), _dot_w, _dot_h, _dot_x, _dot_y)
    return base

tile_light = _tile_layer(_tile_r_alpha, TILE_VECTOR_W, TILE_VECTOR_H, INK_L, SURFACE_L)
tile_dark  = _tile_layer(_tile_r_alpha, TILE_VECTOR_W, TILE_VECTOR_H, INK_D, SURFACE_D)

# ---- wordmark: rasterized straight from the traced vector paths ---------
# One source of truth for both the SVGs (below) and these PNGs, instead of
# an independent resample of the raw rwm.png pixels — see wordmark_vector.py.
print('rasterizing wordmark vector (this takes a few seconds)')
_letters_sp = parse_path(WM_LETTERS_PATH)
_dot_sp     = parse_path(WM_DOT_PATH)
_vb = (0, 0, WM_VECTOR_W, WM_VECTOR_H)
_letters_alpha_806 = rasterize_alpha(_letters_sp, _vb, WM_VECTOR_W, WM_VECTOR_H)
_dot_alpha_806     = rasterize_alpha(_dot_sp,     _vb, WM_VECTOR_W, WM_VECTOR_H)

def _crop_alpha(alpha, w, h, cw):
    """Crop a row-major alpha buffer's width from w down to cw."""
    out = bytearray(cw * h)
    for y in range(h):
        out[y*cw:(y+1)*cw] = alpha[y*w:y*w+cw]
    return bytes(out)

_letters_alpha_750 = _crop_alpha(_letters_alpha_806, WM_VECTOR_W, WM_VECTOR_H, WM_VECTOR_PLAIN_W)

def _wordmark_layer(letters_alpha, dot_alpha, w, h, ink_rgba):
    letters = tint(letters_alpha, ink_rgba)
    if dot_alpha is None:
        return letters
    dot = tint(dot_alpha, RED)
    return over(letters, w, h, dot, w, h, 0, 0)

wm_light  = _wordmark_layer(_letters_alpha_806, _dot_alpha_806, WM_VECTOR_W, WM_VECTOR_H, INK_L)
wm_dark   = _wordmark_layer(_letters_alpha_806, _dot_alpha_806, WM_VECTOR_W, WM_VECTOR_H, INK_D)
wmp_light = tint(_letters_alpha_750, INK_L)
wmp_dark  = tint(_letters_alpha_750, INK_D)

man = []
def emit(path, W, H, data):
    sz = write_png(path, W, H, data)
    man.append((path.replace('\\', '/'), '%dx%d' % (W, H), sz))

# ---- icons --------------------------------------------------------------
ICON_SIZES = [512, 256, 180, 128, 96, 64, 48, 32, 16]
ico_parts = []
for s in ICON_SIZES:
    l = scale(tile_light, 470, 470, s, s)
    d = scale(tile_dark,  470, 470, s, s)
    emit('%s/icon/rulebeat-icon-%d.png' % (OUT, s), s, s, l)
    emit('%s/icon/rulebeat-icon-dark-%d.png' % (OUT, s), s, s, d)
    if s in (16, 32, 48):
        ico_parts.append((s, open('%s/icon/rulebeat-icon-%d.png' % (OUT, s), 'rb').read()))
    print('  icon', s)

n = write_ico('%s/favicon.ico' % OUT, ico_parts)
man.append(('%s/favicon.ico' % OUT, '16+32+48', n))

# ---- avatars (same tile, named for where they go) -----------------------
for name, data in [('rulebeat-avatar-512.png', scale(tile_light, 470, 470, 512, 512)),
                   ('rulebeat-avatar-dark-512.png', scale(tile_dark, 470, 470, 512, 512))]:
    emit('%s/avatar/%s' % (OUT, name), 512, 512, data)

# ---- wordmarks ----------------------------------------------------------
for w in [806, 400, 200]:
    h = round(132*w/806)
    emit('%s/wordmark/rulebeat-wordmark-%d.png' % (OUT, w), w, h,
         scale(wm_light, 806, 132, w, h))
    emit('%s/wordmark/rulebeat-wordmark-dark-%d.png' % (OUT, w), w, h,
         scale(wm_dark, 806, 132, w, h))
    print('  wordmark', w)
# no-full-stop cut, for use beside the tile
for w in [750, 400, 200]:
    h = round(132*w/750)
    emit('%s/wordmark/rulebeat-wordmark-plain-%d.png' % (OUT, w), w, h,
         scale(wmp_light, 750, 132, w, h))
    emit('%s/wordmark/rulebeat-wordmark-plain-dark-%d.png' % (OUT, w), w, h,
         scale(wmp_dark, 750, 132, w, h))

# ---- wordmark SVGs (vector master, see wordmark_vector.py) --------------
# Traced from the same rwm.png pixels the PNG wordmarks above are built
# from, not redrawn or re-typeset — see wordmark_vector.py's docstring for
# why.
def wordmark_svg(w, h, ink_hex, dot_hex, include_dot):
    # fill-rule="evenodd": potrace emits holes (the bowls of R/B, the
    # counters of e/a) as extra subpaths that only cut the shape correctly
    # under evenodd — this is potrace's own output convention (see
    # Potrace.js's getPathTag), not an arbitrary choice made here. Without
    # it every counter fills in solid.
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d">' % (w, h),
        '<path d="%s" fill="%s" fill-rule="evenodd"/>' % (WM_LETTERS_PATH, ink_hex),
    ]
    if include_dot:
        parts.append('<path d="%s" fill="%s" fill-rule="evenodd"/>' % (WM_DOT_PATH, dot_hex))
    parts.append('</svg>\n')
    return ''.join(parts)

def emit_svg(path, w, h, svg_text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(svg_text)
    man.append((path.replace('\\', '/'), '%dx%d' % (w, h), len(svg_text.encode('utf-8'))))

RED_HEX = '#E3000F'
INK_L_HEX = '#000000'
INK_D_HEX = '#F4F4F2'

emit_svg('%s/wordmark/rulebeat-wordmark.svg' % OUT, WM_VECTOR_W, WM_VECTOR_H,
         wordmark_svg(WM_VECTOR_W, WM_VECTOR_H, INK_L_HEX, RED_HEX, True))
emit_svg('%s/wordmark/rulebeat-wordmark-dark.svg' % OUT, WM_VECTOR_W, WM_VECTOR_H,
         wordmark_svg(WM_VECTOR_W, WM_VECTOR_H, INK_D_HEX, RED_HEX, True))
emit_svg('%s/wordmark/rulebeat-wordmark-plain.svg' % OUT, WM_VECTOR_PLAIN_W, WM_VECTOR_H,
         wordmark_svg(WM_VECTOR_PLAIN_W, WM_VECTOR_H, INK_L_HEX, RED_HEX, False))
emit_svg('%s/wordmark/rulebeat-wordmark-plain-dark.svg' % OUT, WM_VECTOR_PLAIN_W, WM_VECTOR_H,
         wordmark_svg(WM_VECTOR_PLAIN_W, WM_VECTOR_H, INK_D_HEX, RED_HEX, False))
print('  wordmark svg (vector)')

# ---- tile SVG (vector master, see tile_vector.py) ------------------------
# Icons are solid squares by design (see brand/README.txt), so unlike the
# wordmark SVG this one paints a full-bleed background rect first, then the
# R shape in the surface colour on top, then the accent square — the same
# three-layer order the PNG tile above is built in.
def tile_svg(size, ink_hex, surface_hex, red_hex):
    dx, dy, dw, dh = TILE_DOT_RECT
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d">' % (size, size),
        '<rect width="%d" height="%d" fill="%s"/>' % (size, size, ink_hex),
        '<path d="%s" fill="%s" fill-rule="evenodd"/>' % (TILE_R_PATH, surface_hex),
        '<rect x="%d" y="%d" width="%d" height="%d" fill="%s"/>' % (dx, dy, dw, dh, red_hex),
        '</svg>\n',
    ]
    return ''.join(parts)

SURFACE_L_HEX = '#FFFFFF'
SURFACE_D_HEX = '#17191B'

emit_svg('%s/icon/rulebeat-icon.svg' % OUT, TILE_VECTOR_W, TILE_VECTOR_H,
         tile_svg(TILE_VECTOR_W, INK_L_HEX, SURFACE_L_HEX, RED_HEX))
emit_svg('%s/icon/rulebeat-icon-dark.svg' % OUT, TILE_VECTOR_W, TILE_VECTOR_H,
         tile_svg(TILE_VECTOR_W, INK_D_HEX, SURFACE_D_HEX, RED_HEX))
print('  tile svg (vector)')

# ---- horizontal lockup, transparent ground ------------------------------
# The tile carries the red square, so the wordmark beside it drops its full
# stop. One red square per lockup, never two.
def lockup(tile_src, wm_src, tile_px, wm_w, gap):
    wm_h = round(132*wm_w/750)
    t = scale(tile_src, 470, 470, tile_px, tile_px)
    w = scale(wm_src, 750, 132, wm_w, wm_h)
    W = tile_px + gap + wm_w
    H = max(tile_px, wm_h)
    canvas = solid(W, H, CLEAR)
    ty = (H - tile_px)//2
    wy = ty + tile_px//2 - wm_h//2
    canvas = over(canvas, W, H, t, tile_px, tile_px, 0, ty)
    canvas = over(canvas, W, H, w, wm_w, wm_h, tile_px + gap, wy)
    return W, H, canvas

for tag, tsrc, wsrc in [('', tile_light, wmp_light), ('-dark', tile_dark, wmp_dark)]:
    for tpx, ww, gp in [(128, 447, 36), (64, 224, 18), (32, 112, 9)]:
        W, H, c = lockup(tsrc, wsrc, tpx, ww, gp)
        emit('%s/lockup/rulebeat-lockup%s-%d.png' % (OUT, tag, W), W, H, c)
    print('  lockup', tag or 'light')

# ---- social card 1200x630 ----------------------------------------------
def card(bg, tsrc, wsrc):
    CW, CH = 1200, 630
    tpx, gap, ww = 128, 40, 447
    wh = round(132*ww/750)
    t = scale(tsrc, 470, 470, tpx, tpx)
    w = scale(wsrc, 750, 132, ww, wh)
    total = tpx + gap + ww
    x = (CW - total)//2
    ty = (CH - tpx)//2
    wy = ty + tpx//2 - wh//2
    c = solid(CW, CH, bg)
    c = over(c, CW, CH, t, tpx, tpx, x, ty)
    c = over(c, CW, CH, w, ww, wh, x + tpx + gap, wy)
    return CW, CH, c

for tag, bg, tsrc, wsrc in [('', BG_L, tile_light, wmp_light),
                            ('-dark', BG_D, tile_dark, wmp_dark)]:
    W, H, c = card(bg, tsrc, wsrc)
    emit('%s/social/rulebeat-social%s-1200x630.png' % (OUT, tag), W, H, c)
    print('  social', tag or 'light')

# ---- deploy the copies the app needs -----------------------------------
# Next.js finds these four by filename and position and writes the <link> and
# <meta> tags itself, so they cannot live in brand/ with everything else.
# Generated here rather than copied by hand so the kit and the app can never
# drift apart: rerunning this script rewrites both.
import shutil

WEB = os.environ.get('RULEBEAT_WEB',
                     os.path.normpath(os.path.join(HERE, '..', '..', 'packages', 'web')))
if WEB:
    app = os.path.join(WEB, 'app')
    pub = os.path.join(WEB, 'public', 'brand')
    os.makedirs(pub, exist_ok=True)
    DEPLOY = [
        ('%s/favicon.ico' % OUT,                    '%s/favicon.ico' % app),
        ('%s/icon/rulebeat-icon-512.png' % OUT,     '%s/icon.png' % app),
        ('%s/icon/rulebeat-icon-180.png' % OUT,     '%s/apple-icon.png' % app),
        ('%s/social/rulebeat-social-1200x630.png' % OUT,
                                                    '%s/opengraph-image.png' % app),
        # 2x sources for the sidebar, drawn at 32px high
        ('%s/icon/rulebeat-icon-64.png' % OUT,      '%s/mark.png' % pub),
        ('%s/icon/rulebeat-icon-dark-64.png' % OUT, '%s/mark-dark.png' % pub),
        ('%s/lockup/rulebeat-lockup-306.png' % OUT, '%s/lockup.png' % pub),
        ('%s/lockup/rulebeat-lockup-dark-306.png' % OUT,
                                                    '%s/lockup-dark.png' % pub),
    ]
    print()
    for src, dst in DEPLOY:
        shutil.copyfile(src, dst)
        print('  deployed %s' % dst.replace('\\', '/'))

print()
tot = 0
for p, dim, sz in man:
    print('%-52s %-10s %7d' % (p, dim, sz)); tot += sz
print('%d files, %.1f KB total' % (len(man), tot/1024))
