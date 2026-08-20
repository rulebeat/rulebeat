import zlib, struct

def load(fn):
    d = open(fn, 'rb').read(); i = 8; idat = b''
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; typ = d[i+4:i+8]; data = d[i+8:i+8+ln]
        if typ == b'IHDR':
            W, H, bd, ct = struct.unpack('>IIBB', data[:10])
        elif typ == b'IDAT':
            idat += data
        i += 12 + ln
    raw = zlib.decompress(idat); nch = {0:1, 2:3, 3:1, 4:2, 6:4}[ct]; stride = W*nch
    out = bytearray(H*stride); prev = bytearray(stride); p = 0
    for y in range(H):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f == 1:
            for x in range(nch, stride): line[x] = (line[x] + line[x-nch]) & 255
        elif f == 2:
            for x in range(stride): line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x-nch] if x >= nch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x-nch] if x >= nch else 0
                b = prev[x]; c = prev[x-nch] if x >= nch else 0
                pa = a + b - c; da = abs(pa-a); db = abs(pa-b); dc = abs(pa-c)
                pr = a if (da <= db and da <= dc) else (b if db <= dc else c)
                line[x] = (line[x] + pr) & 255
        out[y*stride:(y+1)*stride] = line; prev = line
    return W, H, nch, bytes(out)

def write_png(path, W, H, rgba):
    """rgba: flat bytes, 4 channels."""
    raw = bytearray()
    stride = W*4
    for y in range(H):
        raw.append(0)
        raw += rgba[y*stride:(y+1)*stride]
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)
    return len(png)

def decompose(W, H, nch, px, ox, oy, cw, ch, src_red):
    """Every pixel in this artwork is a blend of exactly three source colours:
    white, black, and one red. Solve for the three coverages exactly.

        w_red   = (r - g) / (Rr - Rg)
        w_white = (g - w_red*Rg) / 255
        w_black = 1 - w_red - w_white

    Returns list of (white, red, black) floats per pixel, row major."""
    Rr, Rg, Rb = src_red
    den = float(Rr - Rg)
    lay = []
    for y in range(oy, oy+ch):
        base = y*W*nch
        for x in range(ox, ox+cw):
            o = base + x*nch
            r, g, b = px[o], px[o+1], px[o+2]
            wr = (r - g)/den
            if wr < 0.0: wr = 0.0
            elif wr > 1.0: wr = 1.0
            ww = (g - wr*Rg)/255.0
            if ww < 0.0: ww = 0.0
            if ww + wr > 1.0:
                s = ww + wr; ww /= s; wr /= s
            lay.append((ww, wr, 1.0 - ww - wr))
    return lay

def paint(lay, cw, ch, col_white, col_red, col_black):
    """Map the three coverage layers onto target colours (r,g,b,a) 0-255.
    Returns straight-alpha RGBA bytes at native size."""
    src = bytearray(cw*ch*4)
    for i, (ww, wr, wb) in enumerate(lay):
        a = ww*col_white[3] + wr*col_red[3] + wb*col_black[3]
        pr = ww*col_white[0]*col_white[3] + wr*col_red[0]*col_red[3] + wb*col_black[0]*col_black[3]
        pg = ww*col_white[1]*col_white[3] + wr*col_red[1]*col_red[3] + wb*col_black[1]*col_black[3]
        pb = ww*col_white[2]*col_white[3] + wr*col_red[2]*col_red[3] + wb*col_black[2]*col_black[3]
        o = i*4
        if a > 0.5:
            src[o] = min(255, int(pr/a + .5)); src[o+1] = min(255, int(pg/a + .5))
            src[o+2] = min(255, int(pb/a + .5))
        src[o+3] = min(255, int(a + .5))
    return bytes(src)

def scale(src, sw, sh, dw, dh):
    """Area-average when shrinking, bilinear when growing."""
    if dw >= sw and dh >= sh and (dw, dh) != (sw, sh):
        return _bilinear(src, sw, sh, dw, dh)
    if (dw, dh) == (sw, sh):
        return src
    return resize(src, sw, sh, dw, dh)

def _bilinear(src, sw, sh, dw, dh):
    dst = bytearray(dw*dh*4)
    for dy in range(dh):
        fy = (dy + .5)*sh/dh - .5
        y0 = int(fy) if fy >= 0 else 0
        y1 = min(sh-1, y0+1); ty = max(0.0, fy - y0)
        for dx in range(dw):
            fx = (dx + .5)*sw/dw - .5
            x0 = int(fx) if fx >= 0 else 0
            x1 = min(sw-1, x0+1); tx = max(0.0, fx - x0)
            o = (dy*dw + dx)*4
            for c in range(4):
                p00 = src[(y0*sw + x0)*4 + c]; p01 = src[(y0*sw + x1)*4 + c]
                p10 = src[(y1*sw + x0)*4 + c]; p11 = src[(y1*sw + x1)*4 + c]
                top = p00 + (p01 - p00)*tx
                bot = p10 + (p11 - p10)*tx
                dst[o+c] = int(top + (bot - top)*ty + .5)
    return bytes(dst)

def solid(W, H, rgba):
    row = bytes(rgba)*W
    return row*H

def over(dst, dw, dh, src, sw, sh, px, py):
    """Real source-over of straight-alpha src onto straight-alpha dst."""
    d = bytearray(dst)
    for y in range(sh):
        ty = py + y
        if ty < 0 or ty >= dh: continue
        for x in range(sw):
            tx = px + x
            if tx < 0 or tx >= dw: continue
            so = (y*sw + x)*4
            sa = src[so+3]/255.0
            if sa <= 0: continue
            do = (ty*dw + tx)*4
            da = d[do+3]/255.0
            oa = sa + da*(1-sa)
            if oa <= 0: continue
            for c in range(3):
                d[do+c] = int((src[so+c]*sa + d[do+c]*da*(1-sa))/oa + .5)
            d[do+3] = int(oa*255 + .5)
    return bytes(d)

def resize(src, sw, sh, dw, dh):
    """Area-average resample of premultiplied-safe RGBA. Straight alpha in,
    premultiplied during averaging, straight alpha out."""
    dst = bytearray(dw*dh*4)
    xs = sw/dw; ys = sh/dh
    for dy in range(dh):
        y0 = dy*ys; y1 = y0 + ys
        iy0 = int(y0); iy1 = min(sh, int(y1 - 1e-9) + 1)
        for dx in range(dw):
            x0 = dx*xs; x1 = x0 + xs
            ix0 = int(x0); ix1 = min(sw, int(x1 - 1e-9) + 1)
            ar = ag = ab = aa = wt = 0.0
            for sy in range(iy0, iy1):
                fy = min(y1, sy+1) - max(y0, sy)
                if fy <= 0: continue
                row = sy*sw*4
                for sx in range(ix0, ix1):
                    fx = min(x1, sx+1) - max(x0, sx)
                    if fx <= 0: continue
                    w = fx*fy
                    o = row + sx*4
                    a = src[o+3]/255.0
                    ar += src[o]*a*w; ag += src[o+1]*a*w; ab += src[o+2]*a*w
                    aa += src[o+3]*w; wt += w
            o = (dy*dw + dx)*4
            if wt > 0:
                al = aa/wt
                dst[o+3] = int(al + .5)
                if al > 0.5:
                    k = wt*(al/255.0)
                    dst[o] = min(255, int(ar/k + .5))
                    dst[o+1] = min(255, int(ag/k + .5))
                    dst[o+2] = min(255, int(ab/k + .5))
    return bytes(dst)

def write_ico(path, entries):
    """entries: list of (size, png_bytes)"""
    n = len(entries)
    hdr = struct.pack('<HHH', 0, 1, n)
    off = 6 + 16*n
    dirs = b''; blobs = b''
    for size, data in entries:
        s = 0 if size >= 256 else size
        dirs += struct.pack('<BBBBHHII', s, s, 0, 0, 1, 32, len(data), off)
        blobs += data; off += len(data)
    open(path, 'wb').write(hdr + dirs + blobs)
    return 6 + 16*n + len(blobs)
