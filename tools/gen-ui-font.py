#!/usr/bin/env python3
"""
Generate engine/src/ui/text/builtinFont.ts — the UI's built-in signed-distance-field font.

Source: DejaVu Sans (Bitstream Vera licence; DejaVu changes are public domain). The licence allows
redistribution of modified fonts only under a name without "Bitstream" or "Vera", so the generated
face is called "Forge Sans"; the notice is reproduced in engine/src/ui/text/FONT-LICENSE.md.

Method: each glyph is rasterised at HI x the base size, the outline's boundary pixels are collected,
and every atlas texel stores the exact Euclidean distance from its centre (mapped into hi-res space)
to the nearest boundary pixel, signed by inside/outside, scaled so 0.5 is the edge and SPREAD base
pixels span 0.5 in each direction. Kerning pairs come from HarfBuzz via PIL's raqm layout.

Usage: python3 tools/gen-ui-font.py [path/to/DejaVuSans.ttf]
"""
import base64
import math
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BASE = 32  # base pixel size the atlas metrics are in
SPREAD = 4  # distance range in base pixels on each side of the edge
HI = 8  # supersampling factor for the distance computation
ATLAS_W = 512

codepoints = list(range(32, 127)) + list(range(160, 256)) + [
    0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x20AC, 0x2122,
    0x2190, 0x2191, 0x2192, 0x2193, 0x25B2, 0x25BC, 0x25B6, 0x25C0, 0x25CF, 0x25CB, 0x2713, 0x2717, 0x2605, 0x2665,
    # UI icon glyphs (engine/src/ui/render/assets.ts BUILTIN_GLYPH_ICONS)
    0x2261, 0x2630, 0x2699, 0x26A0, 0x2139, 0x2715, 0x2212, 0x203A, 0x2039, 0x25A0, 0x25A1, 0x2606, 0x2661, 0x2694,
    0x26A1, 0x2318, 0x21B5, 0x2302, 0x2714, 0x25C6,
]

hi_font = ImageFont.truetype(FONT, BASE * HI)
base_font = ImageFont.truetype(FONT, BASE * 2)  # kerning measured at 2x for precision
ascent, descent = ImageFont.truetype(FONT, BASE).getmetrics()

glyphs = []
for cp in codepoints:
    ch = chr(cp)
    advance = hi_font.getlength(ch) / HI
    bbox = hi_font.getbbox(ch, anchor="ls")
    x0, y0, x1, y1 = bbox
    if x1 <= x0 or y1 <= y0 or ch.isspace():
        glyphs.append({"cp": cp, "adv": advance, "empty": True})
        continue
    pad = SPREAD * HI
    w = x1 - x0 + 2 * pad
    h = y1 - y0 + 2 * pad
    img = Image.new("L", (w, h), 0)
    ImageDraw.Draw(img).text((pad - x0, pad - y0), ch, font=hi_font, fill=255, anchor="ls")
    mask = np.asarray(img) >= 128
    # Boundary: inside pixels with a 4-neighbour outside.
    padded = np.pad(mask, 1, constant_values=False)
    nb_out = ~padded[:-2, 1:-1] | ~padded[2:, 1:-1] | ~padded[1:-1, :-2] | ~padded[1:-1, 2:]
    edge = mask & nb_out
    ey, ex = np.nonzero(edge)
    edge_pts = np.stack([ex + 0.5, ey + 0.5], axis=1).astype(np.float32)
    # Low-res sample grid in base pixels covering [x0/HI - SPREAD, x1/HI + SPREAD].
    gx0 = math.floor(x0 / HI) - SPREAD
    gy0 = math.floor(y0 / HI) - SPREAD
    gw = math.ceil(x1 / HI) + SPREAD - gx0
    gh = math.ceil(y1 / HI) + SPREAD - gy0
    sx = (np.arange(gw) + gx0 + 0.5) * HI - x0 + pad
    sy = (np.arange(gh) + gy0 + 0.5) * HI - y0 + pad
    px, py = np.meshgrid(sx, sy)
    pts = np.stack([px.ravel(), py.ravel()], axis=1).astype(np.float32)
    best = np.full(len(pts), np.inf, dtype=np.float32)
    for i in range(0, len(edge_pts), 2048):
        e = edge_pts[i : i + 2048]
        d = (pts[:, None, 0] - e[None, :, 0]) ** 2 + (pts[:, None, 1] - e[None, :, 1]) ** 2
        best = np.minimum(best, d.min(axis=1))
    dist = np.sqrt(best) / HI  # base pixels
    ix = np.clip(np.floor(pts[:, 0]).astype(int), 0, w - 1)
    iy = np.clip(np.floor(pts[:, 1]).astype(int), 0, h - 1)
    inside_px = (pts[:, 0] >= 0) & (pts[:, 0] < w) & (pts[:, 1] >= 0) & (pts[:, 1] < h)
    inside = inside_px & mask[iy, ix]
    signed = np.where(inside, dist, -dist)
    val = np.clip(0.5 + signed / (2 * SPREAD), 0, 1)
    sdf = (val * 255 + 0.5).astype(np.uint8).reshape(gh, gw)
    glyphs.append({"cp": cp, "adv": advance, "empty": False, "sdf": sdf, "ox": gx0, "oy": gy0})

# Shelf-pack.
x = y = row_h = 0
for g in glyphs:
    if g["empty"]:
        continue
    gh, gw = g["sdf"].shape
    if x + gw + 1 > ATLAS_W:
        x = 0
        y += row_h + 1
        row_h = 0
    g["ax"], g["ay"] = x, y
    x += gw + 1
    row_h = max(row_h, gh)
atlas_h = y + row_h
atlas_h = (atlas_h + 3) // 4 * 4
atlas = np.zeros((atlas_h, ATLAS_W), dtype=np.uint8)
for g in glyphs:
    if g["empty"]:
        continue
    gh, gw = g["sdf"].shape
    atlas[g["ay"] : g["ay"] + gh, g["ax"] : g["ax"] + gw] = g["sdf"]

# Kerning among printable ASCII.
kern = []
ascii_chars = [chr(c) for c in range(33, 127)]
widths = {c: base_font.getlength(c) for c in ascii_chars}
for a in ascii_chars:
    for b in ascii_chars:
        k = (base_font.getlength(a + b) - widths[a] - widths[b]) / 2
        if abs(k) >= 0.25:
            kern.append((ord(a), ord(b), round(k, 2)))

table = []
for g in glyphs:
    if g["empty"]:
        table += [g["cp"], round(g["adv"], 3), 0, 0, 0, 0, 0, 0]
    else:
        gh, gw = g["sdf"].shape
        table += [g["cp"], round(g["adv"], 3), g["ox"], g["oy"], gw, gh, g["ax"], g["ay"]]

# Run-length encode zero texels (everything farther than SPREAD outside a glyph): a 0 byte is
# followed by the run length (1..255). Non-zero texels are stored verbatim.
raw = atlas.tobytes()
rle = bytearray()
i = 0
while i < len(raw):
    if raw[i] == 0:
        j = i
        while j < len(raw) and raw[j] == 0 and j - i < 255:
            j += 1
        rle += bytes([0, j - i])
        i = j
    else:
        rle.append(raw[i])
        i += 1
b64 = base64.b64encode(bytes(rle)).decode("ascii")
lines = [b64[i : i + 120] for i in range(0, len(b64), 120)]
out = []
out.append("/**")
out.append(" * GENERATED by tools/gen-ui-font.py — do not edit by hand.")
out.append(" *")
out.append(" * \"Forge Sans\": a signed-distance-field atlas rendered from DejaVu Sans (Bitstream Vera licence,")
out.append(" * see ./FONT-LICENSE.md). Metrics are in pixels at BASE_SIZE; glyph rows are")
out.append(" * [codepoint, advance, offsetX, offsetY(from baseline, +down), width, height, atlasX, atlasY].")
out.append(" */")
out.append("")
out.append(f"export const FORGE_SANS_BASE_SIZE = {BASE};")
out.append(f"export const FORGE_SANS_SPREAD = {SPREAD};")
out.append(f"export const FORGE_SANS_ASCENT = {ascent};")
out.append(f"export const FORGE_SANS_DESCENT = {descent};")
out.append(f"export const FORGE_SANS_ATLAS_WIDTH = {ATLAS_W};")
out.append(f"export const FORGE_SANS_ATLAS_HEIGHT = {atlas_h};")
out.append("export const FORGE_SANS_GLYPHS: readonly number[] = [")
for i in range(0, len(table), 8):
    out.append("  " + ", ".join(str(v) for v in table[i : i + 8]) + ",")
out.append("];")
out.append("export const FORGE_SANS_KERNING: readonly number[] = [")
for i in range(0, len(kern), 6):
    out.append("  " + ", ".join(f"{a}, {b}, {k}" for a, b, k in kern[i : i + 6]) + ",")
out.append("];")
out.append("/** Single-channel SDF atlas, row-major; zero runs RLE-encoded as [0, count]; base64. */")
out.append("export const FORGE_SANS_ATLAS_BASE64 =")
for i, l in enumerate(lines):
    out.append(f'  "{l}"' + (" +" if i < len(lines) - 1 else ";"))
out.append("")
open("engine/src/ui/text/builtinFont.ts", "w").write("\n".join(out))
print(f"glyphs {len(glyphs)} atlas {ATLAS_W}x{atlas_h} kerning pairs {len(kern)} base64 {len(b64)} bytes")
Image.fromarray(atlas).save("/tmp/forge-sans-atlas.png")
