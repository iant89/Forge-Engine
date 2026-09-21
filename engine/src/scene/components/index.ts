/**
 * Engine built-in components.
 *
 * Where per-frame access is hot (Transform), the component is a *view* over the world's flat
 * structure-of-arrays storage rather than a container of its own values: the renderer, physics and
 * animation all need the same floats, and a copy per component would either drift or force a sync
 * pass. Where access is cold (camera parameters, material references), plain fields are the honest
 * choice — they are cheaper to read in a debugger and to serialize.
 *
 * Importing this module registers the engine's component types with the component registry.
 */

import { Component, registerComponent } from "../components.js";
import { Mat4, Quat } from "../../math/mat.js";
import { Vec3 } from "../../math/vec.js";
import { AABB } from "../../math/geometry.js";
import type { EntityWorld } from "../world.js";
import type { Material } from "../../rendering/material.js";
import type { Geometry } from "../../rendering/geometry.js";
import type { SkinBinding } from "../../rendering/mesh.js";

/**
 * Local position/rotation/scale relative to the parent (or to the scene's render origin when
 * unparented). Values live in `world.transforms`; the fields here mirror the storage so that
 * `transform.position.x` reads are free, and every setter writes both.
 *
 * Large-world note: these are float32 values relative to `Scene.coordinateSpace.origin`, which is
 * double precision. Write through `Scene.setEntityWorldPosition` for coordinates beyond ~10^4 to
 * avoid losing precision in the conversion; see docs/ARCHITECTURE.md#large-world.
 */
export class Transform extends Component {
  /** @internal */ private world: EntityWorld | null = null;
  /** @internal */ private slot = 0;

  readonly position = new Vec3();
  readonly rotation = new Quat();
  readonly scale = new Vec3(1, 1, 1);

  override onAttach(world: EntityWorld): void {
    this.world = world;
    this.slot = world.transformSlot(this.entity, true);
    world.transforms.writeTRS(this.slot, this as unknown as never);
  }

  override onDetach(): void {
    this.world = null;
    this.slot = 0;
  }

  /** @internal Called by TransformSystem after world matrices are recomputed. */
  override onTransformChanged(world: EntityWorld): void {
    void world;
  }

  private t(): number {
    if (this.world === null) {
      throw new Error("Transform used before attach (or after detach)");
    }
    if (this.slot === 0) this.slot = this.world.transformSlot(this.entity, true);
    return this.slot;
  }

  private write(): void {
    const w = this.world!;
    w.transforms.setLocalTRS(this.t(), this.position, this.rotation, this.scale);
  }

  setPosition(x: number, y: number, z: number): this {
    this.position.set(x, y, z);
    if (this.world) this.world.transforms.setPosition(this.t(), x, y, z);
    return this;
  }

  setRotation(q: Quat): this {
    this.rotation.copyFrom(q);
    if (this.world) this.world.transforms.setRotation(this.t(), this.rotation);
    return this;
  }

  setRotationEuler(radX: number, radY: number, radZ: number): this {
    this.rotation.setEulerComponents(radX, radY, radZ);
    if (this.world) this.world.transforms.setRotation(this.t(), this.rotation);
    return this;
  }

  setScale(x: number, y = x, z = x): this {
    this.scale.set(x, y, z);
    if (this.world) this.world.transforms.setScale(this.t(), x, y, z);
    return this;
  }

  /** Re-write all of local TRS into storage (after mutating the mirror fields directly). */
  sync(): this {
    this.write();
    return this;
  }

  /** Local TRS is authoritative in the mirror fields; storage follows on write. */
  get positionWorld(): Vec3 {
    const out = new Vec3();
    const w = this.world;
    if (w) w.transforms.getWorldPosition(this.t(), out);
    else out.copyFrom(this.position);
    return out;
  }

  get rotationWorld(): Quat {
    const q = new Quat();
    const w = this.world;
    if (w) w.getWorldRotation(this.t(), q);
    else q.copyFrom(this.rotation);
    return q;
  }

  /** World matrix, freshly copied out of storage (allocation: fine for authoring, not per frame). */
  get worldMatrix(): Mat4 {
    if (!this.world) return new Mat4().setCompose(this.position, this.rotation, this.scale);
    return new Mat4(this.world.transforms.worldView(this.t()));
  }

  /** The storage view itself — pass this to the renderer instead of copying. */
  get worldMatrixView(): Float32Array {
    return this.world!.transforms.worldView(this.t());
  }

  /** @internal storage slot (renderer/culling read this directly). */
  get transformSlot(): number {
    return this.t();
  }

  translate(dx: number, dy: number, dz: number): this {
    return this.setPosition(this.position.x + dx, this.position.y + dy, this.position.z + dz);
  }

  /** Move along the entity's own axes. */
  translateLocal(x: number, y: number, z: number): this {
    const v = this.rotation.rotateVector(new Vec3(x, y, z), SCRATCH_LOCAL);
    return this.setPosition(v.x + this.position.x, v.y + this.position.y, v.z + this.position.z);
  }

  /** Rotate by `radians` about a world-space axis (post-multiplied onto the local rotation). */
  rotate(axis: Vec3, radians: number): this {
    const q = Quat.fromAxisAngle(axis, radians);
    q.multiply(this.rotation);
    return this.setRotation(q);
  }

  lookAt(target: Vec3, up = new Vec3(0, 1, 0)): this {
    const eye = this.positionWorld;
    const view = new Mat4().setLookAt(eye, target, up);
    const q = new Quat();
    // The look-at matrix is the *view* orientation (world→view). The object's orientation is its
    // inverse, which for an orthonormal rotation is the transpose.
    Quat.fromRotationMatrix(new Mat4().copyFrom(view).transpose(), q);
    return this.setRotation(q);
  }

  /** Local +Z, rotated into world space (the engine's "forward" convention). */
  forward(out = new Vec3()): Vec3 {
    return this.rotationWorld.rotateVector(FORWARD, out);
  }

  right(out = new Vec3()): Vec3 {
    return this.rotationWorld.rotateVector(RIGHT, out);
  }

  up(out = new Vec3()): Vec3 {
    return this.rotationWorld.rotateVector(UP, out);
  }

  applyMatrixWorld(m: Mat4): this {
    const p = new Vec3();
    const s = new Vec3();
    const q = new Quat();
    m.decompose(p, q, s);
    this.position.copyFrom(p);
    this.rotation.copyFrom(q);
    this.scale.copyFrom(s);
    return this.sync();
  }
}

/**
 * Draw state for an entity: which geometry, which material, and the flags that decide its bucket
 * in the render pass. `visible` is the authoring switch; `wasCulled`/`isVisible` are per-frame
 * results written by the visibility system and read by debug overlays.
 */
export class Renderable extends Component {
  geometry: Geometry | null = null;
  material: Material | null = null;
  /** Present when the geometry is skinned; resolved against the scene's skeleton entities. */
  skin: SkinBinding | null = null;
  castShadow = true;
  receiveShadow = true;
  doubleSided = false;
  /** Alpha-blended: drawn after opaques, back-to-front, without depth writes. */
  transparent = false;
  /** Drawn without depth testing (HUD/overlay geometry). */
  overlay = false;
  /** Manual tiebreak within a bucket (larger draws later). */
  order = 0;
  /** Authoring switch. */
  visible = true;
  /** Culling result for the current frame (written by the visibility system). */
  isVisible = false;
  /** Instanced colour tint (0xAARRGGBB); 0 means "no tint". */
  tint = 0;
  /** Extra emissive strength folded into the instance stream. */
  emissive = 0;
  /** Culling-mask layer bit; cameras combine their mask with this. */
  layer = 1;
  /** Local-space bounds override (used when geometry bounds are wrong or intentionally loose). */
  boundsOverride: AABB | null = null;

  setGeometry(geometry: Geometry | null): this {
    this.geometry = geometry;
    return this;
  }

  setMaterial(material: Material | null): this {
    this.material = material;
    return this;
  }

  /** Local bounds to test against, preferring the explicit override. */
  resolveBounds(out: AABB): AABB {
    if (this.boundsOverride) return out.setFrom(this.boundsOverride.min, this.boundsOverride.max);
    if (this.geometry) return out.setFrom(this.geometry.bounds.min, this.geometry.bounds.max);
    return out.setFrom(Vec3.zero, Vec3.zero);
  }
}

/**
 * View + projection state for the renderer. The renderer, not the component, owns the matrices: it
 * writes them once per frame from the entity's world transform (`writeMatrices`), and everything
 * else (culling, LOD, audio, picking) reads them from here.
 */
export class Camera extends Component {
  fovY = Math.PI / 3;
  near = 0.1;
  far = 1000;
  orthoHeight = 10;
  orthographic = false;
  /** 0 → derive from the canvas aspect ratio. */
  aspectOverride = 0;
  /** Highest-priority enabled camera renders; ties resolve by entity creation order. */
  priority = 0;
  clearColor = 0x0a0e14;
  /** Post-processing chain key resolved by the renderer ("none" | "default" | demo chain). */
  postChain = "default";
  /** Culling mask: `layer & cullingMask` must be non-zero for a Renderable to draw. */
  cullingMask = 0xffffffff;

  readonly view = new Mat4();
  readonly projection = new Mat4();
  readonly viewProjection = new Mat4();
  /** Camera position in render-local coordinates (float32, relative to the coordinate-space origin). */
  readonly positionRender = new Vec3();

  setPerspective(fovYRad: number, aspect: number, near: number, far: number): this {
    this.fovY = fovYRad;
    this.aspectOverride = aspect;
    this.near = near;
    this.far = far;
    this.orthographic = false;
    return this;
  }

  setOrthographic(height: number, aspect: number, near: number, far: number): this {
    this.orthoHeight = height;
    this.aspectOverride = aspect;
    this.near = near;
    this.far = far;
    this.orthographic = true;
    return this;
  }

  get aspect(): number {
    return this.aspectOverride > 0 ? this.aspectOverride : 16 / 9;
  }

  /** @internal Called by the renderer with the frame's authoritative matrices. */
  writeMatrices(view: Mat4, projection: Mat4, positionRender: Vec3): void {
    this.view.copyFrom(view);
    this.projection.copyFrom(projection);
    this.viewProjection.multiplyMatrices(projection, view);
    this.positionRender.copyFrom(positionRender);
  }

  /** Distance (squared) from the camera to a render-local point — LOD + audio both use this. */
  distanceSqToPoint(renderLocal: Vec3): number {
    return Vec3.distanceSqBetween(this.positionRender, renderLocal);
  }

  distanceTo(renderLocal: Vec3): number {
    return Math.sqrt(this.distanceSqToPoint(renderLocal));
  }
}

export type LightKind = "directional" | "point" | "spot";

/**
 * Light source. Up to `MAX_SHADOWED_LIGHTS` (see rendering/lights.ts) cast shadows per frame;
 * beyond that, lights still contribute analytically.
 */
export class Light extends Component {
  kind: LightKind = "directional";
  /** Linear RGB, 0..1 per channel, multiplied by `intensity`. */
  readonly color = new Vec3(1, 1, 1);
  intensity = 1;
  /** Point/spot falloff range in metres (0 = infinite for directional). */
  range = 0;
  /** Spot cone cosines (outer < inner for a soft edge). */
  innerCone = 0.85;
  outerCone = 0.6;
  castShadow = true;
  shadowMapSize = 2048;
  /** Depth bias in normalized device units. */
  shadowBias = 0.0008;
  /** World-space normal offset, kills acne on low-poly surfaces without over-biasing. */
  shadowNormalBias = 0.6;
  /** Directional lights: normalized travel direction, written by the rotation sync when enabled. */
  readonly direction = new Vec3(0, -1, 0);
  /** Derive `direction` from the entity's rotation each frame (light shines along -Y by default). */
  followRotation = true;
  /** Shadow cascade split count for directional lights (1..3). */
  cascades = 1;
  /** Excludes this light from the light accumulation pass (used by the editor). */
  affectScene = true;

  setColor(r: number, g: number, b: number): this {
    this.color.set(r, g, b);
    return this;
  }

  /** @internal */
  computeDirectionFromRotation(transform: Transform): void {
    const f = transform.forward(SCRATCH_DIR);
    this.setDirectionFromForward(f);
  }

  /**
   * @internal Light travels along the entity's local +Z — the same axis `Transform.forward()` and
   * `Transform.lookAt()` use — so `sun.transform.lookAt(target)` shines *at* `target`. The renderer
   * calls this each frame while `followRotation` is set.
   */
  setDirectionFromForward(forward: Vec3): void {
    const len = forward.length();
    if (len < 1e-8) return;
    this.direction.set(forward.x / len, forward.y / len, forward.z / len);
  }
}

const SCRATCH_DIR = new Vec3();
const SCRATCH_LOCAL = new Vec3();
const FORWARD = new Vec3(0, 0, 1);
const RIGHT = new Vec3(1, 0, 0);
const UP = new Vec3(0, 1, 0);

/** Minimal audio source; the 3D audio system lands in phase 8 and consumes these fields. */
export class AudioSource extends Component {
  clip: unknown = null;
  volume = 1;
  loop = false;
  autoplay = false;
  playing = false;
  spatial = true;
  refDistance = 1;
  maxDistance = 200;
  rolloffFactor = 1;

  play(): this {
    this.playing = true;
    return this;
  }

  stop(): this {
    this.playing = false;
    return this;
  }
}

registerComponent(Transform as never, { name: "Transform", allowMultiple: false, singleton: true, editorGroup: "Core" });
registerComponent(Renderable as never, { name: "Renderable", allowMultiple: false, editorGroup: "Rendering" });
registerComponent(Camera as never, { name: "Camera", allowMultiple: false, singleton: true, editorGroup: "Rendering" });
registerComponent(Light as never, { name: "Light", allowMultiple: true, editorGroup: "Rendering" });
registerComponent(AudioSource as never, { name: "AudioSource", allowMultiple: true, editorGroup: "Audio" });

export const BUILTIN_COMPONENT_NAMES = ["Transform", "Renderable", "Camera", "Light", "AudioSource"] as const;

/** Convenience used by demos and the editor: an AABB that covers `radius` around `center`. */
export function sphereBounds(center: Vec3, radius: number, out = new AABB()): AABB {
  return out.setFrom(
    new Vec3(center.x - radius, center.y - radius, center.z - radius),
    new Vec3(center.x + radius, center.y + radius, center.z + radius),
  );
}

/** Re-export so scene users do not have to import three modules to build a cube. */
export { Mat4 };
