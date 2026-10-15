/**
 * @suite terrain:tireTracks
 * @group unit
 * @covers engine/src/terrain/tireTracks.ts
 * @desc Pins persistent tyre tracks: capsule stamping, per-surface styles (mud holds water), depth cap and load, tile ring eviction, fade, and the layer's follow/bind/release GPU lifetime
 */

export const suite = {
  name: "terrain:tireTracks",
  group: "unit",
  covers: ["engine/src/terrain/tireTracks.ts"],
  desc: "Pins persistent tyre tracks: capsule stamping, per-surface styles (mud holds water), depth cap and load, tile ring eviction, fade, and the layer's follow/bind/release GPU lifetime",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { GraphicsDevice, Renderable, Scene, TIRE_MARK_STYLES, TireTrackLayer, TireTrackMap, type TireSurface } from "@forge/engine";

/** Texel (i, j) of the tile containing (x, z), as the map indexes it. */
function texel(map: TireTrackMap, x: number, z: number): { tile: { albedo: Uint8Array; mr: Uint8Array }; o: number } {
  const ix = Math.floor(x / map.tileSize), iz = Math.floor(z / map.tileSize);
  const tile = map.tiles.get(`${ix},${iz}`)!;
  const i = Math.floor(((x - ix * map.tileSize) / map.tileSize) * map.res);
  const j = Math.floor(((z - iz * map.tileSize) / map.tileSize) * map.res);
  return { tile, o: (j * map.res + i) * 4 };
}

group("tyre track map", () => {
  test("a stamp marks a capsule of its width along the segment and nothing beside it", () => {
    const map = new TireTrackMap({ tileSize: 8, tileResolution: 128 });
    map.stamp(1, 4, 6, 4, 0.3, "gravel");
    assert.ok(map.depthAt(3.5, 4) > 0, "centre of the segment is marked");
    assert.ok(map.depthAt(1, 4.1) > 0, "inside the half-width");
    assert.equal(map.depthAt(3.5, 4.3), 0, "beyond the half-width");
    assert.equal(map.depthAt(7, 4), 0, "beyond the end cap");
    assert.equal(map.depthAt(100, 100), 0, "an untouched tile reads 0 and is not created");
    assert.equal(map.tiles.size, 1);
  });

  test("repeated passes deepen up to twice the style depth; load scales each pass", () => {
    const map = new TireTrackMap({ tileSize: 8, tileResolution: 64 });
    const depth = TIRE_MARK_STYLES.mud.depth;
    map.stamp(2, 4, 6, 4, 0.4, "mud");
    const one = map.depthAt(4, 4);
    // Half the style depth on the tread centreline (the texel centre sits just off it, so ~1%).
    assert.ok(Math.abs(one - depth * 0.5) < depth * 0.01, `one full-load pass cuts half the style depth (${one})`);
    for (let k = 0; k < 10; k++) map.stamp(2, 4, 6, 4, 0.4, "mud");
    assert.ok(Math.abs(map.depthAt(4, 4) - depth * 2) < 1e-6, "capped at 2x the style depth");

    const light = new TireTrackMap({ tileSize: 8, tileResolution: 64 });
    light.stamp(2, 4, 6, 4, 0.4, "mud", 0.5);
    assert.ok(light.depthAt(4, 4) < one, "a lighter wheel cuts a shallower rut");
  });

  test("styles: only mud ruts hold standing water; coverage never exceeds the style alpha", () => {
    for (const surface of ["gravel", "grass", "mud", "snow"] as TireSurface[]) {
      const map = new TireTrackMap({ tileSize: 8, tileResolution: 64 });
      for (let k = 0; k < 4; k++) map.stamp(2, 4, 6, 4, 0.4, surface);
      const { tile, o } = texel(map, 4, 4);
      const style = TIRE_MARK_STYLES[surface];
      assert.ok(tile.albedo[o + 3]! > 0, `${surface} leaves a visible mark`);
      assert.ok(tile.albedo[o + 3]! <= Math.round(style.alpha * 255), `${surface} coverage ${tile.albedo[o + 3]} within its alpha`);
      assert.equal(tile.mr[o + 1], Math.round(style.roughness * 255), `${surface} roughness`);
      assert.equal(tile.mr[o + 2], 0, "never metallic");
      assert.equal(tile.mr[o + 3]! < 255, style.holdsWater, `${surface} water mark`);
    }
    // Untouched texels are fully transparent, dry (MR alpha 255) and non-metallic.
    const map = new TireTrackMap({ tileSize: 8, tileResolution: 64 });
    map.stamp(2, 4, 3, 4, 0.3, "mud");
    const { tile, o } = texel(map, 7, 7);
    assert.deepEqual([tile.albedo[o + 3], tile.mr[o + 2], tile.mr[o + 3]], [0, 0, 255]);
  });

  test("tiles are a ring: past maxTiles the least recently stamped tile is recycled", () => {
    const map = new TireTrackMap({ tileSize: 4, tileResolution: 16, maxTiles: 2 });
    const evicted: string[] = [];
    map.onEvict = (t) => evicted.push((t as { key: string }).key);
    map.stamp(1, 1, 2, 1, 0.3, "gravel"); // tile 0,0
    map.stamp(5, 1, 6, 1, 0.3, "gravel"); // tile 1,0
    map.stamp(1.5, 1, 2.5, 1, 0.3, "gravel"); // touch 0,0 again: now 1,0 is the oldest
    map.stamp(9, 1, 10, 1, 0.3, "gravel"); // tile 2,0 evicts 1,0
    assert.equal(map.tiles.size, 2);
    assert.deepEqual(evicted, ["1,0"]);
    assert.equal(map.recycled, 1);
    assert.ok(map.depthAt(2, 1) > 0, "the recently driven tile survives");
    assert.equal(map.depthAt(5.5, 1), 0, "the recycled tile's marks are gone");
  });

  test("a segment crossing a tile edge marks both tiles seamlessly", () => {
    const map = new TireTrackMap({ tileSize: 4, tileResolution: 32 });
    map.stamp(3, 2, 5, 2, 0.3, "grass");
    assert.equal(map.tiles.size, 2);
    assert.ok(map.depthAt(3.95, 2) > 0 && map.depthAt(4.05, 2) > 0);
  });

  test("fade: 0 keeps marks forever; a fade time decays depth and coverage", () => {
    const keep = new TireTrackMap({ tileSize: 8, tileResolution: 32 });
    keep.stamp(2, 4, 6, 4, 0.4, "gravel");
    const d0 = keep.depthAt(4, 4);
    keep.fade(1000);
    assert.equal(keep.depthAt(4, 4), d0);

    const fading = new TireTrackMap({ tileSize: 8, tileResolution: 32, fadeTime: 10 });
    fading.stamp(2, 4, 6, 4, 0.4, "gravel");
    const { tile, o } = texel(fading, 4, 4);
    const a0 = tile.albedo[o + 3]!;
    fading.fade(10);
    assert.ok(Math.abs(fading.depthAt(4, 4) - d0 / Math.E) < 1e-6, "depth falls by 1/e per fadeTime");
    assert.ok(tile.albedo[o + 3]! < a0, "coverage fades with it");
  });
});

group("tyre track layer", () => {
  test("follows a vehicle's contacts, binds one transparent tile per map tile, and leaks nothing", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock!;
    const scene = new Scene();
    const layer = new TireTrackLayer(device, { heightAt: () => 0, tileSize: 8, tileResolution: 32, maxTiles: 2, uploadInterval: 0 });
    const wheels = [
      { inContact: true, contactX: 1, contactZ: 1, normalLoad: 2500 },
      { inContact: false, contactX: 1, contactZ: 3, normalLoad: 0 },
    ];
    const surfaces: TireSurface[] = [];
    layer.followVehicle({ wheels, config: { mass: 500 } }, (x) => {
      const s: TireSurface = x < 8 ? "gravel" : "mud";
      surfaces.push(s);
      return s;
    });
    scene.add(layer);
    const ctx = {} as never;

    layer.update(ctx, 0.016); // first contact only seeds the wheel's last position
    assert.equal(layer.tileCount, 0);
    wheels[0]!.contactX = 3;
    layer.update(ctx, 0.016);
    assert.equal(layer.tileCount, 1, "the grounded wheel stamped");
    assert.ok(layer.map.depthAt(2, 1) > 0);
    assert.equal(layer.map.depthAt(1, 3), 0, "the airborne wheel did not");
    assert.deepEqual(surfaces, ["gravel"]);

    const tiles = () => scene.world.store(Renderable).liveValues().filter((r) => (r.material?.label ?? "").startsWith("tireTracks."));
    assert.equal(tiles().length, 1, "one renderable per bound tile");
    const rend = tiles()[0]!;
    assert.equal(rend.transparent, true);
    assert.equal(rend.castShadow, false);

    // A teleport (> 3 m in one step) re-seeds instead of painting a streak across the map.
    wheels[0]!.contactX = 30;
    layer.update(ctx, 0.016);
    assert.equal(layer.map.depthAt(15, 1), 0);
    assert.equal(layer.tileCount, 1);

    // Two more tiles with maxTiles 2: the oldest is evicted and its GPU side released.
    wheels[0]!.contactX = 31;
    layer.update(ctx, 0.016);
    wheels[0]!.contactX = 41;
    wheels[0]!.contactZ = 1.5;
    layer.update(ctx, 0.016); // > 3 m: re-seed
    wheels[0]!.contactX = 42;
    layer.update(ctx, 0.016);
    assert.equal(layer.tileCount, 2);
    assert.equal(layer.map.recycled, 1);
    assert.equal(tiles().length, 2, "the evicted tile's renderable is gone");

    scene.removeObject(layer);
    assert.equal(tiles().length, 0);
    scene.dispose();
    await device.dispose();
    assert.equal(mock.outstanding.buffers.length, 0);
    assert.equal(mock.outstanding.textures.length, 0);
  });
});

await finish();
