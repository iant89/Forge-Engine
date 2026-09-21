/**
 * Procedural PBR texture generation.
 *
 * Generates 2D textures (albedo, tangent-space normal, metallic-roughness) on the CPU and uploads
 * them via `Texture.fromRgba8`. This allows the PBR showcase to display rich surface detail
 * without external binary assets or asset loaders.
 */
import { Texture, type GraphicsDevice } from "@forge/engine";

export interface PbrTextureSet {
  albedo: Texture;
  normal: Texture;
  metallicRoughness: Texture;
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
