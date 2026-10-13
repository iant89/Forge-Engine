#!/usr/bin/env python3
"""Generate examples/assets/MaterialFeatures.gltf (CC0, made for Forge Engine Phase 16.1c).

Four upright 1.6 m quads facing -Z (the demo orbit camera's side; nodes turned 180 deg about Y), one per material feature, each with a 16x16 data-URI PNG:
  0 emissive   - grey base, emissiveFactor 1, red/black checker emissiveTexture
  1 occlusion  - grey base, stripe occlusionTexture (R), strength 1
  2 mask       - white base, alpha checker, alphaMode MASK, cutoff 0.5, doubleSided
  3 sampler    - colour checker, UV 0..3, sampler CLAMP_TO_EDGE + NEAREST (vs default repeat)
"""
import base64, json, struct, sys, zlib

def png(w, h, px):  # px(x,y) -> (r,g,b,a)
    raw = b"".join(b"\0" + b"".join(bytes(px(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(data).decode()

checker = lambda x, y: ((x // 4) + (y // 4)) % 2
images = [
    png(16, 16, lambda x, y: (255, 0, 0, 255) if checker(x, y) else (0, 0, 0, 255)),
    png(16, 16, lambda x, y: (0, 0, 0, 255) if (x // 4) % 2 else (255, 255, 255, 255)),
    png(16, 16, lambda x, y: (255, 255, 255, 255 if checker(x, y) else 0)),
    png(16, 16, lambda x, y: (40, 200, 255, 255) if checker(x, y) else (255, 200, 40, 255)),
]

def quad(uv_scale):
    pos = [-0.8, 0, 0, 0.8, 0, 0, 0.8, 1.6, 0, -0.8, 1.6, 0]
    nrm = [0, 0, 1] * 4
    s = uv_scale
    uv = [0, s, s, s, s, 0, 0, 0]
    return pos, nrm, uv

blob = b""
views, accessors, meshes = [], [], []
def add(values, fmt, comp, typ, count, target=None, minmax=None):
    global blob
    data = struct.pack("<" + fmt * len(values), *values)
    views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), **({"target": target} if target else {})})
    blob += data + b"\0" * ((4 - len(data) % 4) % 4)
    acc = {"bufferView": len(views) - 1, "componentType": comp, "count": count, "type": typ}
    if minmax: acc["min"], acc["max"] = minmax
    accessors.append(acc)
    return len(accessors) - 1

idx = add([0, 1, 2, 0, 2, 3], "H", 5123, "SCALAR", 6, 34963)
for i, s in enumerate([1, 1, 1, 3]):
    p, n, u = quad(s)
    a_p = add(p, "f", 5126, "VEC3", 4, 34962, ([-0.8, 0, 0], [0.8, 1.6, 0]))
    a_n = add(n, "f", 5126, "VEC3", 4, 34962)
    a_u = add(u, "f", 5126, "VEC2", 4, 34962)
    meshes.append({"name": ["emissive", "occlusion", "mask", "sampler"][i], "primitives": [{"attributes": {"POSITION": a_p, "NORMAL": a_n, "TEXCOORD_0": a_u}, "indices": idx, "material": i}]})

grey = {"baseColorFactor": [0.5, 0.5, 0.5, 1], "metallicFactor": 0, "roughnessFactor": 0.8}
doc = {
    "asset": {"version": "2.0", "generator": "tools/gen-gltf-material-features.py", "copyright": "CC0 1.0, Forge Engine"},
    "scene": 0,
    "scenes": [{"nodes": [0, 1, 2, 3]}],
    "nodes": [{"name": m["name"], "mesh": i, "translation": [2.7 - i * 1.8, 0, 0], "rotation": [0, 1, 0, 0]} for i, m in enumerate(meshes)],
    "meshes": meshes,
    "materials": [
        {"name": "emissive", "pbrMetallicRoughness": grey, "emissiveFactor": [1, 1, 1], "emissiveTexture": {"index": 0}},
        {"name": "occlusion", "pbrMetallicRoughness": grey, "occlusionTexture": {"index": 1, "strength": 1}},
        {"name": "mask", "pbrMetallicRoughness": {"baseColorTexture": {"index": 2}, "metallicFactor": 0, "roughnessFactor": 0.8}, "alphaMode": "MASK", "alphaCutoff": 0.5, "doubleSided": True},
        {"name": "sampler", "pbrMetallicRoughness": {"baseColorTexture": {"index": 3}, "metallicFactor": 0, "roughnessFactor": 0.8}},
    ],
    "textures": [{"source": 0}, {"source": 1}, {"source": 2}, {"source": 3, "sampler": 0}],
    "samplers": [{"magFilter": 9728, "minFilter": 9728, "wrapS": 33071, "wrapT": 33071}],
    "images": [{"uri": u} for u in images],
    "buffers": [{"byteLength": len(blob), "uri": "data:application/octet-stream;base64," + base64.b64encode(blob).decode()}],
    "bufferViews": views,
    "accessors": accessors,
}
out = sys.argv[1] if len(sys.argv) > 1 else "examples/assets/MaterialFeatures.gltf"
open(out, "w").write(json.dumps(doc, indent=1) + "\n")
print("wrote", out)
