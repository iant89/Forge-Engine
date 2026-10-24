/**
 * Planet detail patch helpers: the pure maths behind `PlanetGlobe`'s zoomed-in level of detail.
 *
 * A *detail window* is a latitude/longitude rectangle snapped to the globe mesh's cells. Inside it the
 * globe's own triangles are left out of the index buffer and a finer patch is drawn instead: a grid
 * `subdiv` times denser than the globe's cells, displaced by fine elevation and textured with its own
 * high-resolution bake. The patch's border vertices lie exactly on the globe's cell edges (the chord
 * between two globe vertices), so the seam has no cracks, and the fine elevation fades in over the
 * outermost globe cell, so it has no step either.
 *
 * Nothing here touches the GPU; `rendering/planetGlobe.ts` owns the buffers, textures and bake loop.
 */

const DEG = Math.PI / 180;

/** Catmull-Rom weights for the four taps around a fractional position `t` in [0, 1). */
function catmullRom(t: number, out: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
}

const wu = new Float64Array(4);
const wv = new Float64Array(4);

/**
 * Bicubic (Catmull-Rom) lookup in a `cols×rows` cell-centred global lat/lon grid with longitude wrap
 * and latitude clamp — C¹, so a gradient taken from it is continuous (the bilinear lookup's gradient is
 * constant per cell, which bakes a visible tile per grid cell into the shaded relief).
 */
export function planetGridCubic(grid: ArrayLike<number>, cols: number, rows: number, latDeg: number, lonDeg: number): number {
  const u = ((((lonDeg % 360) + 360) % 360) / 360) * cols - 0.5;
  const v = ((90 - latDeg) / 180) * rows - 0.5;
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  catmullRom(u - i0, wu);
  catmullRom(v - j0, wv);
  let sum = 0;
  for (let b = 0; b < 4; b++) {
    const j = Math.min(rows - 1, Math.max(0, j0 - 1 + b));
    let row = 0;
    for (let a = 0; a < 4; a++) {
      const i = ((((i0 - 1 + a) % cols) + cols) % cols);
      row += grid[j * cols + i]! * wu[a]!;
    }
    sum += row * wv[b]!;
  }
  return sum;
}

/** Bicubic lookup in a local `w×h` node grid (clamped at the edges); `x`, `y` in node units. */
export function localGridCubic(grid: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  const i0 = Math.floor(x);
  const j0 = Math.floor(y);
  catmullRom(x - i0, wu);
  catmullRom(y - j0, wv);
  let sum = 0;
  for (let b = 0; b < 4; b++) {
    const j = Math.min(h - 1, Math.max(0, j0 - 1 + b));
    let row = 0;
    for (let a = 0; a < 4; a++) {
      const i = Math.min(w - 1, Math.max(0, i0 - 1 + a));
      row += grid[j * w + i]! * wu[a]!;
    }
    sum += row * wv[b]!;
  }
  return sum;
}

/** A detail window in globe mesh cells: columns `[i0, i0 + cellsX)` (mod the mesh width) × rows `[j0, j1)`. */
export interface PlanetDetailWindow {
  i0: number;
  cellsX: number;
  j0: number;
  j1: number;
  /** West edge longitude, degrees in [0, 360); the window spans `cellsX × 360 / meshW` degrees east of it. */
  lon0: number;
  lonSpan: number;
  /** North edge latitude and span (degrees, southward). */
  lat0: number;
  latSpan: number;
}

/**
 * The window of globe cells covering a cap of `radiusRad` around a unit direction (planet frame:
 * `+Y` north, longitude `atan2(z, x)`). The longitude span widens with latitude so the cap stays
 * covered, and becomes the whole circle when the cap reaches a pole.
 */
export function planetDetailWindow(dx: number, dy: number, dz: number, radiusRad: number, meshW: number, meshH: number): PlanetDetailWindow {
  const lat = Math.asin(Math.max(-1, Math.min(1, dy))) / DEG;
  const lon = (((Math.atan2(dz, dx) / DEG) % 360) + 360) % 360;
  const r = radiusRad / DEG;
  const cellLat = 180 / meshH;
  const cellLon = 360 / meshW;
  const north = Math.min(90, lat + r);
  const south = Math.max(-90, lat - r);
  const j0 = Math.max(0, Math.floor((90 - north) / cellLat));
  const j1 = Math.min(meshH, Math.ceil((90 - south) / cellLat));
  // Longitude half-span: the cap's widest point is at the latitude nearest a pole within it.
  const poleward = Math.max(Math.abs(north), Math.abs(south));
  let cellsX: number;
  let i0: number;
  if (north >= 90 - 1e-9 || south <= -90 + 1e-9 || poleward >= 89) {
    cellsX = meshW;
    i0 = 0;
  } else {
    const half = Math.min(180, r / Math.max(0.02, Math.cos(poleward * DEG)));
    const west = lon - half;
    i0 = Math.floor(west / cellLon);
    const i1 = Math.ceil((lon + half) / cellLon);
    cellsX = Math.min(meshW, i1 - i0);
    i0 = ((i0 % meshW) + meshW) % meshW;
    if (cellsX >= meshW) i0 = 0;
  }
  return {
    i0,
    cellsX,
    j0,
    j1,
    lon0: i0 * cellLon,
    lonSpan: cellsX * cellLon,
    lat0: 90 - j0 * cellLat,
    latSpan: (j1 - j0) * cellLat,
  };
}

/** Whether globe cell (column `i`, row `j`) lies inside `w` (columns wrap). */
export function planetDetailWindowContains(w: PlanetDetailWindow, i: number, j: number, meshW: number): boolean {
  if (j < w.j0 || j >= w.j1) return false;
  const di = (((i - w.i0) % meshW) + meshW) % meshW;
  return di < w.cellsX;
}

/** The patch mesh `planetDetailMesh` builds: `(nx + 1) × (ny + 1)` vertices, north row first, west to east. */
export interface PlanetDetailMesh {
  nx: number;
  ny: number;
  positions: Float32Array;
  uvs: Float32Array;
  tangents: Float32Array;
}

/**
 * Vertices of the detail patch over `window`: each globe cell split `sx × sy`. A vertex is the fine
 * surface — the unit direction at its latitude/longitude times `radius + elevation(...) · exaggeration`
 * — faded, across the outermost globe cell, into the bilinear blend of its globe cell's four corners
 * (`globePositions`: the globe's `(meshW + 1) × (meshH + 1)` vertex grid). On a cell edge that blend is
 * the straight edge between two globe vertices, so the patch border meets the globe without a crack.
 * Edges at a pole, and the east/west edges of a window that wraps the whole circle, have no neighbour
 * and do not fade. `elevation(alongDeg, latDeg)` takes degrees east of the window's west edge.
 */
export function planetDetailMesh(
  window: PlanetDetailWindow,
  globePositions: ArrayLike<number>,
  meshW: number,
  meshH: number,
  sx: number,
  sy: number,
  radius: number,
  exaggeration: number,
  elevation: (alongDeg: number, latDeg: number) => number,
): PlanetDetailMesh {
  const rows = window.j1 - window.j0;
  const nx = window.cellsX * sx;
  const ny = rows * sy;
  const count = (nx + 1) * (ny + 1);
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const tangents = new Float32Array(count * 4);
  const row = meshW + 1;
  const fullCircle = window.cellsX >= meshW;
  let vi = 0;
  for (let b = 0; b <= ny; b++) {
    const l = Math.min(rows - 1, Math.floor(b / sy));
    const fy = b / sy - l;
    const r0 = window.j0 + l;
    const lat = window.lat0 - (b / ny) * window.latSpan;
    const latR = lat * DEG;
    const cl = Math.cos(latR);
    const sl = Math.sin(latR);
    const dLat = Math.min(window.j0 > 0 ? b / sy : Infinity, window.j1 < meshH ? (ny - b) / sy : Infinity);
    for (let a = 0; a <= nx; a++) {
      const k = Math.min(window.cellsX - 1, Math.floor(a / sx));
      const fx = a / sx - k;
      const c0 = (window.i0 + k) % meshW;
      const c1 = (window.i0 + k + 1) % meshW;
      const p00 = (r0 * row + c0) * 3, p10 = (r0 * row + c1) * 3, p01 = ((r0 + 1) * row + c0) * 3, p11 = ((r0 + 1) * row + c1) * 3;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const g = globePositions;
      const coarseX = g[p00]! * w00 + g[p10]! * w10 + g[p01]! * w01 + g[p11]! * w11;
      const coarseY = g[p00 + 1]! * w00 + g[p10 + 1]! * w10 + g[p01 + 1]! * w01 + g[p11 + 1]! * w11;
      const coarseZ = g[p00 + 2]! * w00 + g[p10 + 2]! * w10 + g[p01 + 2]! * w01 + g[p11 + 2]! * w11;
      const along = (a / nx) * window.lonSpan;
      const lonR = (window.lon0 + along) * DEG;
      const rr = radius + elevation(along, lat) * exaggeration;
      const fineX = cl * Math.cos(lonR) * rr;
      const fineY = sl * rr;
      const fineZ = cl * Math.sin(lonR) * rr;
      const dLon = fullCircle ? Infinity : Math.min(a, nx - a) / sx;
      const t = Math.min(1, dLat, dLon);
      const fade = t * t * (3 - 2 * t);
      positions[vi * 3] = coarseX + (fineX - coarseX) * fade;
      positions[vi * 3 + 1] = coarseY + (fineY - coarseY) * fade;
      positions[vi * 3 + 2] = coarseZ + (fineZ - coarseZ) * fade;
      uvs[vi * 2] = a / nx;
      uvs[vi * 2 + 1] = b / ny;
      tangents[vi * 4] = -Math.sin(lonR);
      tangents[vi * 4 + 2] = Math.cos(lonR);
      tangents[vi * 4 + 3] = 1;
      vi++;
    }
  }
  return { nx, ny, positions, uvs, tangents };
}
