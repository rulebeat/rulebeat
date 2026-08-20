"""Pure-Python SVG path parsing + rasterization for potrace-traced vector
sources (see wordmark_vector.py). No new dependency: same philosophy as
pngkit.py — hand-rolled, stdlib only.

Handles exactly the path grammar potrace emits: M/L/C commands, with the
SVG-standard implicit repeat (an extra coordinate set after a command
letter repeats that command without re-stating the letter), and the
evenodd fill rule potrace relies on for holes (see Potrace.js's own
getPathTag, which hardcodes fill-rule="evenodd"). Arcs, quadratics and
relative commands are out of scope — potrace doesn't emit them.
"""
import re

from pngkit import resize

_TOKEN = re.compile(r'[MLC]|-?\d+\.?\d*')


def parse_path(d):
    """Returns a list of closed subpaths, each a flat list of (x, y) point
    tuples with curves already flattened to line segments."""
    tokens = _TOKEN.findall(d)
    i = 0
    n = len(tokens)
    subpaths = []
    cur = None
    cx = cy = 0.0
    cmd = None
    while i < n:
        t = tokens[i]
        if t in ('M', 'L', 'C'):
            cmd = t
            i += 1
            continue
        if cmd == 'M':
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            if cur:
                subpaths.append(cur)
            cur = [(x, y)]
            cx, cy = x, y
            cmd = 'L'  # extra coordinate pairs after M are implicit linetos
        elif cmd == 'L':
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            cur.append((x, y))
            cx, cy = x, y
        elif cmd == 'C':
            x1, y1, x2, y2, x, y = (float(v) for v in tokens[i:i + 6])
            i += 6
            cur.extend(_flatten_cubic(cx, cy, x1, y1, x2, y2, x, y))
            cx, cy = x, y
        else:
            raise ValueError('unexpected token %r in path' % (t,))
    if cur:
        subpaths.append(cur)
    return subpaths


def _flatten_cubic(x0, y0, x1, y1, x2, y2, x3, y3, segments=14):
    pts = []
    for s in range(1, segments + 1):
        t = s / segments
        mt = 1 - t
        a = mt * mt * mt
        b = 3 * mt * mt * t
        c = 3 * mt * t * t
        e = t * t * t
        x = a * x0 + b * x1 + c * x2 + e * x3
        y = a * y0 + b * y1 + c * y2 + e * y3
        pts.append((x, y))
    return pts


def rasterize_alpha(subpaths, vb, dw, dh, supersample=4):
    """Evenodd-fill the given subpaths (in vb = (vx, vy, vw, vh) viewBox
    space) into a dw x dh single-channel coverage mask (0-255), anti-
    aliased by supersampling then area-averaging down through pngkit's
    own resize(). Returns bytes, length dw*dh."""
    vx, vy, vw, vh = vb
    sw, sh = dw * supersample, dh * supersample
    kx = sw / vw
    ky = sh / vh

    edges = []  # (x0, y0, x1, y1) in supersampled canvas space
    for sp in subpaths:
        n = len(sp)
        for i in range(n):
            x0, y0 = sp[i]
            x1, y1 = sp[(i + 1) % n]
            px0 = (x0 - vx) * kx
            py0 = (y0 - vy) * ky
            px1 = (x1 - vx) * kx
            py1 = (y1 - vy) * ky
            if py0 == py1:
                continue
            edges.append((px0, py0, px1, py1))
    edges.sort(key=lambda e: min(e[1], e[3]))

    mask = bytearray(sw * sh)
    active = []
    ei = 0
    ne = len(edges)
    for y in range(sh):
        yc = y + 0.5
        while ei < ne and min(edges[ei][1], edges[ei][3]) <= yc:
            active.append(edges[ei])
            ei += 1
        if active:
            active = [e for e in active if max(e[1], e[3]) > yc]
        xs = []
        for x0, y0, x1, y1 in active:
            ylo, yhi = (y0, y1) if y0 < y1 else (y1, y0)
            if yc < ylo or yc >= yhi:
                continue
            t = (yc - y0) / (y1 - y0)
            xs.append(x0 + t * (x1 - x0))
        xs.sort()
        row = y * sw
        for k in range(0, len(xs) - 1, 2):
            xa = max(0, int(xs[k] + 0.5))
            xb = min(sw, int(xs[k + 1] + 0.5))
            if xb > xa:
                mask[row + xa:row + xb] = b'\xff' * (xb - xa)

    # Reuse pngkit's own area-average downsampler for the antialiasing:
    # a solid-white, alpha=coverage supersampled image resamples down to
    # exactly (255,255,255,avg_alpha) per pixel, so lifting the alpha
    # channel back out gives a correctly antialiased coverage mask.
    white_rgba = bytearray(sw * sh * 4)
    for i in range(sw * sh):
        if mask[i]:
            o = i * 4
            white_rgba[o] = white_rgba[o + 1] = white_rgba[o + 2] = white_rgba[o + 3] = 255
    down = resize(bytes(white_rgba), sw, sh, dw, dh)
    return bytes(down[3::4])


def tint(alpha, color_rgba):
    """Colour a dw*dh alpha-only coverage mask with a flat colour. Returns
    straight-alpha RGBA bytes, same convention as pngkit.paint()."""
    r, g, b, a = color_rgba
    out = bytearray(len(alpha) * 4)
    for i, cov in enumerate(alpha):
        if cov:
            o = i * 4
            out[o] = r
            out[o + 1] = g
            out[o + 2] = b
            out[o + 3] = cov * a // 255
    return bytes(out)
