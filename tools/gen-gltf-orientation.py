#!/usr/bin/env python3
"""Generate examples/assets/Orientation.gltf (CC0, Forge Engine): a handedness reference.

A 1.6 m panel facing glTF +Z (the asset's front) with a letter "F" texture (asymmetric: a
mirrored F reads backwards), and a red "left-marker" square at glTF +X (the asset's left side,
seen from the front it is on the viewer's RIGHT in any right-handed glTF viewer). Both hang under a
root rotated 30 deg about +Y so node rotations are exercised. TANGENTs are included.
"""
import base64, json, math, struct, sys, zlib

def png(w, h, px):
    raw = b"".join(b"\0" + b"".join(bytes(px(x, y)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")).decode()

F = ["................",
     "..############..",
     "..############..",
     "..###...........",
     "..###...........",
     "..###...........",
     "..##########....",
     "..##########....",
     "..###...........",
     "..###...........",
     "..###...........",
     "..###...........",
     "..###...........",
     "..###...........",
     "................",
     "................"]
image = png(16, 16, lambda x, y: (20, 20, 30, 255) if F[y][x] == "#" else (235, 225, 190, 255))

blob = b""; views = []; accessors = []
def add(values, fmt, comp, typ, count, minmax=None):
    global blob
    data = struct.pack("<" + fmt * len(values), *values)
    views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
    blob += data + b"\0" * ((4 - len(data) % 4) % 4)
    a = {"bufferView": len(views) - 1, "componentType": comp, "count": count, "type": typ}
    if minmax: a["min"], a["max"] = minmax
    accessors.append(a); return len(accessors) - 1

def quad(half_w, h, y0):
    pos = [-half_w, y0, 0, half_w, y0, 0, half_w, y0 + h, 0, -half_w, y0 + h, 0]
    return dict(
        POSITION=add(pos, "f", 5126, "VEC3", 4, ([-half_w, y0, 0], [half_w, y0 + h, 0])),
        NORMAL=add([0, 0, 1] * 4, "f", 5126, "VEC3", 4),
        TANGENT=add([1, 0, 0, 1] * 4, "f", 5126, "VEC4", 4),
        TEXCOORD_0=add([0, 1, 1, 1, 1, 0, 0, 0], "f", 5126, "VEC2", 4))

idx = add([0, 1, 2, 0, 2, 3], "H", 5123, "SCALAR", 6)
panel = quad(0.8, 1.6, 0)
marker = quad(0.15, 0.3, -0.15)
s, c = math.sin(math.radians(15)), math.cos(math.radians(15))
doc = {
    "asset": {"version": "2.0", "generator": "tools/gen-gltf-orientation.py", "copyright": "CC0 1.0, Forge Engine"},
    "scene": 0, "scenes": [{"nodes": [0]}],
    "nodes": [
        {"name": "root", "rotation": [0, s, 0, c], "children": [1, 2]},
        {"name": "panel", "mesh": 0},
        {"name": "left-marker", "mesh": 1, "translation": [1.2, 0.8, 0]},
    ],
    "meshes": [
        {"name": "panel", "primitives": [{"attributes": panel, "indices": idx, "material": 0}]},
        {"name": "left-marker", "primitives": [{"attributes": marker, "indices": idx, "material": 1}]},
    ],
    "materials": [
        {"name": "letter-F", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0, "roughnessFactor": 0.8}},
        {"name": "red", "pbrMetallicRoughness": {"baseColorFactor": [0.9, 0.05, 0.05, 1], "metallicFactor": 0, "roughnessFactor": 0.6}, "emissiveFactor": [0.4, 0, 0]},
    ],
    "textures": [{"source": 0, "sampler": 0}],
    "samplers": [{"magFilter": 9728, "minFilter": 9728}],
    "images": [{"uri": image}],
    "buffers": [{"byteLength": len(blob), "uri": "data:application/octet-stream;base64," + base64.b64encode(blob).decode()}],
    "bufferViews": views, "accessors": accessors,
}
out = sys.argv[1] if len(sys.argv) > 1 else "examples/assets/Orientation.gltf"
open(out, "w").write(json.dumps(doc, indent=1) + "\n"); print("wrote", out)
