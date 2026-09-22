/**
 * Procedural PBR texture generation.
 *
 * Generates 2D textures (albedo, tangent-space normal, metallic-roughness) on the CPU and uploads
 * them via `Texture.fromRgba8`. This allows the PBR showcase to display rich surface detail
 * without external binary assets or asset loaders.
 */
import { Texture, hash2i, type GraphicsDevice } from "@forge/engine";

export interface PbrTextureSet {
  albedo: Texture;
  normal: Texture;
  metallicRoughness: Texture;
}

/** Release a procedural set's GPU textures (call from the owning scene's `dispose`). */
export function disposePbrTextureSet(set: PbrTextureSet | null): void {
  if (!set) return;
  set.albedo.dispose();
  set.normal.dispose();
  set.metallicRoughness.dispose();
}

/**
 * Value noise on a wrapped integer lattice: corners at `ix mod period` hash identically, so the
 * field is continuous across the texture edges and tiles seamlessly under a repeat sampler.
 */
function periodicValueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wrap = (n: number): number => ((n % period) + period) % period;
  const x0 = wrap(xi);
  const x1 = wrap(xi + 1);
  const y0 = wrap(yi);
  const y1 = wrap(yi + 1);
  // Same mapping as engine valueNoise2: uint32 hash → [-1, 1].
  const a = hash2i(x0, y0, seed) / 2147483647.5 - 1;
  const b = hash2i(x1, y0, seed) / 2147483647.5 - 1;
  const c = hash2i(x0, y1, seed) / 2147483647.5 - 1;
  const d = hash2i(x1, y1, seed) / 2147483647.5 - 1;
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Multi-octave periodic fBm; each octave doubles frequency *and* the wrap period. */
function periodicFbm(u: number, v: number, basePeriod: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * periodicValueNoise(u * freq, v * freq, period, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
    period *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Procedural Martian regolith — the terrain demo's PBR set:
 * - Albedo: iron-oxide dust (warm red-orange) over darker basaltic patches, with fine grain and
 *   scattered pebbles. Authored sRGB; the shader multiplies it by the material's base colour factor.
 * - Normal: finite differences of the height field (grain + pebble rims), wrap-around so the map
 *   tiles with the albedo under a repeat sampler.
 * - Metallic-Roughness: dielectric throughout (blue=0), dusty roughness ~0.85–0.97 in green
 *   (the shader multiplies `material.roughness` by this channel, so the material factor is 1).
 *
 * Everything is generated on a wrapped lattice (`periodicValueNoise`), so an integer material
 * tiling (e.g. 16× over a 128 m chunk) repeats without a seam at the texture edge or at chunk
 * borders.
 */
export function createMarsRegolithTextures(device: GraphicsDevice, size = 512): PbrTextureSet {
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const mr = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  // Base lattice period in noise space for one trip across the texture (integer ⇒ tileable).
  const basePeriod = 8;
  const inv = basePeriod / size;

  // 1. Height field: broad dunes + regolith grain + a sparse pebble shell.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const v = y * inv;
      const broad = periodicFbm(u, v, basePeriod, 4, 0x4d415253); // "MARS"
      const grain = periodicFbm(u * 4, v * 4, basePeriod * 4, 3, 0x4d415254);
      // Pebbles: threshold a higher-frequency field into rounded lumps.
      const pebbleField = periodicFbm(u * 6, v * 6, basePeriod * 6, 2, 0x4d415255);
      const pebble = Math.max(0, pebbleField - 0.35) * 2.2;
      height[y * size + x] = broad * 0.55 + grain * 0.28 + Math.min(1, pebble) * 0.45;
    }
  }

  // 2. Albedo + metallic-roughness from the same fields (coherent colour/relief).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const u = x * inv;
      const v = y * inv;
      const h = height[y * size + x]!;
      const dust = periodicFbm(u * 2, v * 2, basePeriod * 2, 3, 0x4d415256); // -1..1
      const basalt = Math.max(0, -dust - 0.15) * 1.4; // darker volcanic patches
      const grainJitter = periodicValueNoise(u * 16, v * 16, basePeriod * 16, 0x4d415257);

      // Iron-oxide palette: dusty orange-red, brighter on raised dust, darker in basalt hollows.
      const lift = 0.72 + h * 0.42 + grainJitter * 0.06;
      let r = 168 * lift;
      let g = 78 * lift;
      let b = 48 * lift;
      // Dust veil: desaturate toward pale ochre where dust accumulates.
      const dustMix = Math.max(0, dust) * 0.35;
      r += (198 - r) * dustMix;
      g += (132 - g) * dustMix;
      b += (86 - b) * dustMix;
      // Basalt: pull toward dark grey-brown.
      const basaltMix = Math.min(1, basalt);
      r += (58 - r) * basaltMix;
      g += (46 - g) * basaltMix;
      b += (40 - b) * basaltMix;

      albedo[idx] = Math.max(0, Math.min(255, Math.round(r)));
      albedo[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      albedo[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      albedo[idx + 3] = 255;

      // Roughness: powder-fine dust is very rough; exposed pebble tops slightly less so.
      const rough = 0.86 + (1 - Math.min(1, Math.max(0, h))) * 0.1 + grainJitter * 0.02;
      mr[idx] = 0; // occlusion channel unused by the standard shader
      mr[idx + 1] = Math.max(0, Math.min(255, Math.round(rough * 255)));
      mr[idx + 2] = 0; // regolith is dielectric
      mr[idx + 3] = 255;
    }
  }

  // 3. Tangent-space normal from the height field (central differences, wrap-around).
  const strength = 2.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size;
      const xr = (x + 1) % size;
      const yu = (y - 1 + size) % size;
      const yd = (y + 1) % size;
      const dhdx = (height[y * size + xr]! - height[y * size + xl]!) * strength;
      const dhdy = (height[yd * size + x]! - height[yu * size + x]!) * strength;
      // Encode: N = normalize(-dhdx, -dhdy, 1) → but +v in the texture points down-image while
      // the engine's terrain UVs put +v along +Z; the standard TBN (B = cross(N,T)·w) expects
      // green = +v direction, so we store -dhdy the same way a typical authoring tool would.
      const nx = -dhdx;
      const ny = -dhdy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const idx = (y * size + x) * 4;
      normal[idx] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      normal[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      normal[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      normal[idx + 3] = 255;
    }
  }

  return {
    albedo: Texture.fromRgba8(device, size, size, albedo, { label: "mars.albedo", srgb: true, mipmaps: false }),
    normal: Texture.fromRgba8(device, size, size, normal, { label: "mars.normal", srgb: false, mipmaps: false }),
    metallicRoughness: Texture.fromRgba8(device, size, size, mr, { label: "mars.mr", srgb: false, mipmaps: false }),
  };
}

/**
 * Procedural cobblestone / pavers:
 * - Albedo: stone colour variation with dark mortar grooves.
 * - Normal: pillowed bevels per stone, perpendicular mortar indentations.
 * - Metallic-Roughness: non-metallic (blue=0), smooth stone tops (green~80), rough mortar (green~230).
 */
export function createCobblestoneTextures(device: GraphicsDevice, size = 256): PbrTextureSet {
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const mr = new Uint8Array(size * size * 4);

  const gridSize = 32; // 8x8 stones
  const mortarWidth = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      const cellY = Math.floor(y / gridSize);
      // Offset alternate rows for running bond pattern
      const xOffset = (cellY % 2 === 1) ? Math.floor(gridSize / 2) : 0;
      const cellX = Math.floor((x + xOffset) % size / gridSize);

      const localX = (x + xOffset) % gridSize;
      const localY = y % gridSize;

      // Distance to cell edge
      const distX = Math.min(localX, gridSize - localX);
      const distY = Math.min(localY, gridSize - localY);
      const edgeDist = Math.min(distX, distY);

      // Hash per stone for colour variation
      const stoneHash = Math.sin(cellX * 12.9898 + cellY * 78.233) * 43758.5453;
      const stoneVar = (stoneHash - Math.floor(stoneHash)) * 0.3 - 0.15; // -0.15 .. +0.15

      const isMortar = edgeDist < mortarWidth;
      const bevel = Math.min(1, Math.max(0, (edgeDist - mortarWidth) / 6));

      if (isMortar) {
        // Mortar: dark grey, rough, dielectric
        const noise = (Math.sin(x * 5.1 + y * 7.7) * 0.5 + 0.5) * 20;
        const c = Math.floor(55 + noise);
        albedo[idx] = c;
        albedo[idx + 1] = c;
        albedo[idx + 2] = c;
        albedo[idx + 3] = 255;

        normal[idx] = 128;
        normal[idx + 1] = 128;
        normal[idx + 2] = 255;
        normal[idx + 3] = 255;

        mr[idx] = 0;       // Occlusion / unread
        mr[idx + 1] = 230; // High roughness
        mr[idx + 2] = 0;   // Dielectric
        mr[idx + 3] = 255;
      } else {
        // Stone: warm reddish-grey with bevel shading
        const baseR = 175 + stoneVar * 80;
        const baseG = 160 + stoneVar * 70;
        const baseB = 145 + stoneVar * 60;
        const shade = 0.7 + bevel * 0.3;

        albedo[idx] = Math.min(255, Math.floor(baseR * shade));
        albedo[idx + 1] = Math.min(255, Math.floor(baseG * shade));
        albedo[idx + 2] = Math.min(255, Math.floor(baseB * shade));
        albedo[idx + 3] = 255;

        // Normal slope from edge distance
        const nx = (localX < gridSize / 2 ? (edgeDist / 8) : -(edgeDist / 8));
        const ny = (localY < gridSize / 2 ? (edgeDist / 8) : -(edgeDist / 8));
        const clampedNx = Math.max(-1, Math.min(1, nx * (1 - bevel)));
        const clampedNy = Math.max(-1, Math.min(1, ny * (1 - bevel)));
        const nz = Math.sqrt(Math.max(0, 1 - clampedNx * clampedNx - clampedNy * clampedNy));

        normal[idx] = Math.floor((clampedNx * 0.5 + 0.5) * 255);
        normal[idx + 1] = Math.floor((clampedNy * 0.5 + 0.5) * 255);
        normal[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
        normal[idx + 3] = 255;

        mr[idx] = 0;
        mr[idx + 1] = Math.floor(80 + (1 - bevel) * 100); // Smoother on top
        mr[idx + 2] = 0;                                 // Dielectric
        mr[idx + 3] = 255;
      }
    }
  }

  return {
    albedo: Texture.fromRgba8(device, size, size, albedo, { label: "cobble.albedo", srgb: true, mipmaps: false }),
    normal: Texture.fromRgba8(device, size, size, normal, { label: "cobble.normal", srgb: false, mipmaps: false }),
    metallicRoughness: Texture.fromRgba8(device, size, size, mr, { label: "cobble.mr", srgb: false, mipmaps: false }),
  };
}

/**
 * Procedural Sci-Fi Hull Plate:
 * - Albedo: dark steel with cyan/orange edge trim.
 * - Normal: beveled plate borders, circular rivets/bolts at corners.
 * - Metallic-Roughness: full metallic (blue=255) on plates, low roughness (green=45) on polished plate.
 */
export function createSciFiPanelTextures(device: GraphicsDevice, size = 256): PbrTextureSet {
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const mr = new Uint8Array(size * size * 4);

  const panelSize = 64; // 4x4 panels
  const border = 4;
  const rivetDist = 8;
  const rivetRadius = 2.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      const lx = x % panelSize;
      const ly = y % panelSize;
      const dx = Math.min(lx, panelSize - lx);
      const dy = Math.min(ly, panelSize - ly);
      const dEdge = Math.min(dx, dy);

      // Check rivet corners
      const corners = [
        [rivetDist, rivetDist],
        [panelSize - rivetDist, rivetDist],
        [rivetDist, panelSize - rivetDist],
        [panelSize - rivetDist, panelSize - rivetDist],
      ];
      let inRivet = false;
      let rivetDx = 0;
      let rivetDy = 0;
      for (const [cx, cy] of corners) {
        const rx = lx - cx!;
        const ry = ly - cy!;
        const dist = Math.hypot(rx, ry);
        if (dist < rivetRadius) {
          inRivet = true;
          rivetDx = rx / rivetRadius;
          rivetDy = ry / rivetRadius;
          break;
        }
      }

      if (dEdge < border) {
        // Seam between panels: dark recessed channel
        albedo[idx] = 20;
        albedo[idx + 1] = 24;
        albedo[idx + 2] = 28;
        albedo[idx + 3] = 255;

        normal[idx] = 128;
        normal[idx + 1] = 128;
        normal[idx + 2] = 255;
        normal[idx + 3] = 255;

        mr[idx] = 0;
        mr[idx + 1] = 200; // Rough rubber seal
        mr[idx + 2] = 40;  // Slightly metallic
        mr[idx + 3] = 255;
      } else if (inRivet) {
        // Rivet head: shiny chrome highlight
        albedo[idx] = 220;
        albedo[idx + 1] = 230;
        albedo[idx + 2] = 240;
        albedo[idx + 3] = 255;

        const nz = Math.sqrt(Math.max(0, 1 - rivetDx * rivetDx - rivetDy * rivetDy));
        normal[idx] = Math.floor((rivetDx * 0.5 + 0.5) * 255);
        normal[idx + 1] = Math.floor((rivetDy * 0.5 + 0.5) * 255);
        normal[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
        normal[idx + 3] = 255;

        mr[idx] = 0;
        mr[idx + 1] = 40;  // Very smooth chrome
        mr[idx + 2] = 255; // 100% metal
        mr[idx + 3] = 255;
      } else {
        // Hull plate: titanium / brushed gunmetal with subtle bevel
        const bevel = Math.min(1, (dEdge - border) / 4);
        const base = Math.floor(130 + bevel * 40);

        albedo[idx] = base;
        albedo[idx + 1] = Math.floor(base * 1.05);
        albedo[idx + 2] = Math.floor(base * 1.15);
        albedo[idx + 3] = 255;

        // Bevel normal
        let nx = 0;
        let ny = 0;
        if (bevel < 1) {
          nx = lx < panelSize / 2 ? (1 - bevel) : -(1 - bevel);
          ny = ly < panelSize / 2 ? (1 - bevel) : -(1 - bevel);
        }
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        normal[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
        normal[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
        normal[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
        normal[idx + 3] = 255;

        mr[idx] = 0;
        mr[idx + 1] = Math.floor(65 + (1 - bevel) * 50); // Polished metal plate
        mr[idx + 2] = 250;                               // 98% metallic
        mr[idx + 3] = 255;
      }
    }
  }

  return {
    albedo: Texture.fromRgba8(device, size, size, albedo, { label: "scifi.albedo", srgb: true, mipmaps: false }),
    normal: Texture.fromRgba8(device, size, size, normal, { label: "scifi.normal", srgb: false, mipmaps: false }),
    metallicRoughness: Texture.fromRgba8(device, size, size, mr, { label: "scifi.mr", srgb: false, mipmaps: false }),
  };
}
