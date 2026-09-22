/**
 * Orbit camera controller for interactive scene inspection.
 *
 * Input: drag to orbit, right/middle/shift-drag to pan, wheel / trackpad scroll to zoom, two-finger
 * touch drag to pan and pinch to zoom, arrow keys / WASD to pan (in the direction the same drag would
 * move the scene), `+` / `-` to zoom.
 *
 * Three properties the demo scenes rely on:
 *
 *  - **Zoom is exponential and always bounded by the scene's own limits.** `distance` is in world
 *    units, so a scene has to say what a sensible range is (`configure`): the material grid lives in
 *    tens of metres, the terrain in thousands. A preset distance outside those limits is clamped on
 *    the way in, because otherwise the *first* wheel event teleports the camera to the limit.
 *  - **Panning is screen-space, in the camera's own basis.** A dragged pixel moves the same world
 *    distance under the cursor at any zoom (`2·distance·tan(fovY/2) / viewportHeight`), and the motion
 *    follows the camera's right/up axes rather than a fixed world axis, so it stays correct at any
 *    azimuth or elevation.
 *  - **Optional surface constraint.** When a scene supplies `groundHeight`, the orbit target and the
 *    eye are both held `groundClearance` above it: the camera glides over hills instead of burrowing
 *    through them, and the controls — not the scene — own `cameraEntity.transform`, so nothing else
 *    has to fight for the position.
 *
 * `update()` recomputes the camera from the stored state, so it is safe (and cheap) to call every
 * frame: the surface constraint then tracks terrain that streams in underneath a stationary camera.
 * `dispose()` detaches every listener — a demo that swaps scenes must call it, or the abandoned
 * controller keeps orbiting a dead camera.
 */
import { Camera, Mat4, Quat, Vec3, type Entity, type TransformHandle } from "@forge/engine";

/** Scene-supplied camera policy. Everything is optional so a scene only states what it cares about. */
export interface OrbitCameraSetup {
  target?: Vec3;
  distance?: number;
  azimuth?: number;
  elevation?: number;
  minDistance?: number;
  maxDistance?: number;
  minElevation?: number;
  maxElevation?: number;
  /** Metres kept between the camera (and orbit target) and `groundHeight`. */
  groundClearance?: number;
  /** World surface height at an XZ position. Set it to stop the camera going under the surface. */
  groundHeight?: ((x: number, z: number) => number) | null;
}

/** Serialisable camera snapshot, used by `window.__forge` in the browser gate. */
export interface OrbitCameraState {
  eye: [number, number, number];
  target: [number, number, number];
  distance: number;
  /** The scene's zoom range, so a gate can tell a clamp from a broken controller. */
  minDistance: number;
  maxDistance: number;
  azimuth: number;
  elevation: number;
  /** Metres between the eye and the surface below it, or `null` without a ground query. */
  altitude: number | null;
}

const UP = new Vec3(0, 1, 0);
const ORBIT_RADIANS_PER_PIXEL = 0.008;
const ZOOM_PIXELS_PER_LINE = 16;
const ZOOM_PIXELS_PER_PAGE = 100;
const KEY_PAN_PIXELS = 24;
const FALLBACK_VIEWPORT_HEIGHT = 720;

export class OrbitControls {
  target = new Vec3(0, 1.2, 0);
  distance = 12;
  azimuth = 0.4;
  elevation = 0.35;

  minDistance = 2;
  maxDistance = 50;
  minElevation = -Math.PI / 2 + 0.05;
  maxElevation = Math.PI / 2 - 0.05;

  /** Fraction of the current distance added per wheel pixel: `distance *= exp(pixels * zoomSpeed)`. */
  zoomSpeed = 0.0025;

  /** Surface query; when set, the target and the eye are held above it. */
  groundHeight: ((x: number, z: number) => number) | null = null;
  groundClearance = 3;

  private mode: "orbit" | "pan" = "orbit";
  private lastX = 0;
  private lastY = 0;
  private pinchDistance = 0;
  private pinchX = 0;
  private pinchY = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();

  /** Every listener is registered against this controller's signal, so `dispose()` is total. */
  private readonly listeners = new AbortController();
  private readonly handle: TransformHandle;
  private readonly canvas: HTMLElement;

  // Scratch: `update()` runs every frame and must not allocate.
  private readonly scratchView = new Mat4();
  private readonly scratchQuat = new Quat();
  private readonly scratchEye = new Vec3();
  private readonly scratchForward = new Vec3();
  private readonly scratchRight = new Vec3();
  private readonly scratchUp = new Vec3();
  private readonly scratchProbe = new Vec3();

  constructor(
    private readonly cameraEntity: Entity,
    canvas: HTMLElement,
  ) {
    this.handle = cameraEntity.transform;
    this.canvas = canvas;
    this.bindEvents();
    this.update();
  }

  // ------------------------------------------------------------------ configuration

  /** Apply a scene's camera policy. Distances are clamped into the (possibly new) limits. */
  configure(setup: OrbitCameraSetup): this {
    if (setup.minDistance !== undefined) this.minDistance = setup.minDistance;
    if (setup.maxDistance !== undefined) this.maxDistance = setup.maxDistance;
    if (setup.minElevation !== undefined) this.minElevation = setup.minElevation;
    if (setup.maxElevation !== undefined) this.maxElevation = setup.maxElevation;
    if (setup.groundClearance !== undefined) this.groundClearance = setup.groundClearance;
    if (setup.groundHeight !== undefined) this.groundHeight = setup.groundHeight;
    if (setup.target) this.target.set(setup.target.x, setup.target.y, setup.target.z);
    if (setup.azimuth !== undefined) this.azimuth = setup.azimuth;
    if (setup.elevation !== undefined) this.elevation = setup.elevation;
    if (setup.distance !== undefined) this.distance = setup.distance;
    // An out-of-range preset would otherwise leave the camera pinned to a limit and make the first
    // wheel event a teleport (the bug that made the terrain demo impossible to zoom out of).
    this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, this.distance));
    this.elevation = Math.min(this.maxElevation, Math.max(this.minElevation, this.elevation));
    this.update();
    return this;
  }

  dispose(): void {
    this.listeners.abort();
    this.pointers.clear();
  }

  // ------------------------------------------------------------------ state

  /** Eye position for the current state, with the surface constraint applied. */
  eyePosition(out: Vec3 = new Vec3()): Vec3 {
    const cosEle = Math.cos(this.elevation);
    const sinEle = Math.sin(this.elevation);
    const cosAzi = Math.cos(this.azimuth);
    const sinAzi = Math.sin(this.azimuth);

    // +Z is in front of the camera's default heading, so the eye sits toward -Z at azimuth 0.
    out.set(
      this.target.x + this.distance * cosEle * sinAzi,
      this.target.y + this.distance * sinEle,
      this.target.z - this.distance * cosEle * cosAzi,
    );

    if (this.groundHeight) {
      const floor = this.groundHeight(out.x, out.z) + this.groundClearance;
      if (out.y < floor) out.y = floor;
    }
    return out;
  }

  state(): OrbitCameraState {
    const eye = this.eyePosition(this.scratchProbe);
    return {
      eye: [eye.x, eye.y, eye.z],
      target: [this.target.x, this.target.y, this.target.z],
      distance: this.distance,
      minDistance: this.minDistance,
      maxDistance: this.maxDistance,
      azimuth: this.azimuth,
      elevation: this.elevation,
      altitude: this.groundHeight ? eye.y - this.groundHeight(eye.x, eye.z) : null,
    };
  }

  /** Metres of screen at the orbit distance, used to keep panning screen-accurate. */
  private worldPerPixel(viewportHeight: number): number {
    const fovY = this.cameraEntity.get(Camera)?.fovY ?? Math.PI / 3;
    const height = viewportHeight > 0 ? viewportHeight : FALLBACK_VIEWPORT_HEIGHT;
    return (2 * this.distance * Math.tan(Math.max(fovY, 1e-3) * 0.5)) / height;
  }

  // ------------------------------------------------------------------ camera transforms

  update(): void {
    // The orbit centre tracks the surface, so a zoomed-in camera orbits a point on the ground rather
    // than a point buried under it.
    if (this.groundHeight) {
      const floor = this.groundHeight(this.target.x, this.target.z) + this.groundClearance;
      if (this.target.y < floor) this.target.y = floor;
    }

    const eye = this.eyePosition(this.scratchEye);
    this.handle.position = eye;

    // Same basis as `Mat4.setLookAt` (view = world→camera, so the object rotation is its transpose).
    // Deriving yaw/pitch by hand would be a second source of truth for the engine's convention.
    this.scratchView.setLookAt(eye, this.target, UP).transpose();
    Quat.fromRotationMatrix(this.scratchView, this.scratchQuat);
    this.handle.rotation = this.scratchQuat;
  }

  // ------------------------------------------------------------------ input math

  /** Orbit. Drag directions follow the cursor: the scene moves with the pointer, not against it. */
  orbitBy(dxPixels: number, dyPixels: number): void {
    this.azimuth -= dxPixels * ORBIT_RADIANS_PER_PIXEL;
    this.elevation = Math.min(
      this.maxElevation,
      Math.max(this.minElevation, this.elevation + dyPixels * ORBIT_RADIANS_PER_PIXEL),
    );
  }

  /**
   * Pan the orbit target parallel to the screen: `dx`/`dy` are pointer pixels, `viewportHeight` is
   * the canvas height in CSS pixels (panning must not change with device pixel ratio).
   */
  panBy(dxPixels: number, dyPixels: number, viewportHeight: number): void {
    const scale = this.worldPerPixel(viewportHeight);
    // The basis has to come from where the camera actually is (the surface clamp moves it), matched to
    // the renderer: forward = target − eye, right = up × forward, camUp = forward × right.
    const forward = this.scratchForward.copyFrom(this.target).sub(this.eyePosition(this.scratchEye));
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
    forward.normalize();
    const right = this.scratchRight;
    const camUp = this.scratchUp;
    Vec3.crossInto(UP, forward, right);
    right.normalize();
    Vec3.crossInto(forward, right, camUp);
    camUp.normalize();

    this.target.x += (-right.x * dxPixels + camUp.x * dyPixels) * scale;
    this.target.y += (-right.y * dxPixels + camUp.y * dyPixels) * scale;
    this.target.z += (-right.z * dxPixels + camUp.z * dyPixels) * scale;

    if (this.groundHeight) {
      const floor = this.groundHeight(this.target.x, this.target.z) + this.groundClearance;
      if (this.target.y < floor) this.target.y = floor;
    }
  }

  /** Zoom by wheel pixels (positive scrolls away from the target). */
  zoomBy(pixels: number): void {
    this.zoomByFactor(Math.exp(pixels * this.zoomSpeed));
  }

  /** Zoom by an explicit factor (`> 1` moves away from the target). */
  zoomByFactor(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, this.distance * factor));
  }

  // ------------------------------------------------------------------ events

  private viewportHeight(): number {
    return this.canvas.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
  }

  private bindEvents(): void {
    const c = this.canvas;
    const signal = this.listeners.signal;

    c.addEventListener("pointerdown", (e: PointerEvent) => {
      this.mode = e.button === 1 || e.button === 2 || e.shiftKey ? "pan" : "orbit";
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        if (a && b) {
          this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
          this.pinchX = (a.x + b.x) * 0.5;
          this.pinchY = (a.y + b.y) * 0.5;
        }
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }, { signal });

    c.addEventListener("pointermove", (e: PointerEvent) => {
      const pointer = this.pointers.get(e.pointerId);
      if (!pointer) return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        if (!a || !b) return;
        const span = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) * 0.5;
        const cy = (a.y + b.y) * 0.5;
        if (this.pinchDistance > 0 && span > 0) {
          // Fingers moving apart (ratio < 1) move the camera closer.
          this.zoomByFactor(this.pinchDistance / span);
          this.panBy(cx - this.pinchX, cy - this.pinchY, this.viewportHeight());
        }
        this.pinchDistance = span;
        this.pinchX = cx;
        this.pinchY = cy;
        this.update();
        return;
      }

      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.mode === "pan") this.panBy(dx, dy, this.viewportHeight());
      else this.orbitBy(dx, dy);
      this.update();
    }, { signal });

    const endPointer = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      c.releasePointerCapture(e.pointerId);
      if (this.pointers.size < 2) this.pinchDistance = 0;
      const [remaining] = [...this.pointers.values()];
      if (remaining) {
        this.lastX = remaining.x;
        this.lastY = remaining.y;
      }
    };
    c.addEventListener("pointerup", endPointer, { signal });
    c.addEventListener("pointercancel", endPointer, { signal });

    c.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const perUnit = e.deltaMode === 1 ? ZOOM_PIXELS_PER_LINE : e.deltaMode === 2 ? ZOOM_PIXELS_PER_PAGE : 1;
      this.zoomBy(e.deltaY * perUnit);
      this.update();
    }, { passive: false, signal });

    c.addEventListener("contextmenu", (e: Event) => e.preventDefault(), { signal });

    // Keyboard binds on the window: the canvas is not focusable in the demo layout.
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("keydown", (e: KeyboardEvent) => this.onKeyDown(e), { signal });
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const pan = (dx: number, dy: number): void => {
      e.preventDefault();
      this.panBy(dx * KEY_PAN_PIXELS, dy * KEY_PAN_PIXELS, this.viewportHeight());
      this.update();
    };
    switch (e.key) {
      case "ArrowLeft": case "a": case "A": return pan(1, 0);
      case "ArrowRight": case "d": case "D": return pan(-1, 0);
      case "ArrowDown": case "s": case "S": return pan(0, 1);
      case "ArrowUp": case "w": case "W": return pan(0, -1);
      case "+": case "=": case "Add":
        e.preventDefault();
        this.zoomBy(-ZOOM_PIXELS_PER_LINE * 2);
        return this.update();
      case "-": case "_": case "Subtract":
        e.preventDefault();
        this.zoomBy(ZOOM_PIXELS_PER_LINE * 2);
        return this.update();
      default:
    }
  }
}
