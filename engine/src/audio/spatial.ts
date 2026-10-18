/**
 * Spatial audio (Phase 20.1): where a sound is, heard from where the listener is.
 *
 * **Coordinates.** Forge is left-handed (+X right, +Y up, cameras look down +Z); Web Audio is
 * right-handed (+X right, +Y up, the default listener looks down −Z). Writing engine coordinates
 * straight into a `PannerNode`/`AudioListener` mirrors left and right — a strike on the camera's
 * right plays in the left ear. Every position and direction crosses into Web Audio through
 * {@link toAudioSpace} (z negated): {@link setAudioListener}, {@link setPannerPosition} and
 * {@link setPannerOrientation} are the only writers, and `AudioVoice`, `AudioSystem.setListener`
 * and the vehicle/impact/particle soundscapes use them. {@link pannerAzimuth} and
 * {@link equalPowerGains} are CPU twins of the Web Audio spec's panning so the convention is tested.
 *
 * **Propagation** on top of the panner's own distance gain: {@link dopplerRatio} (classic Doppler
 * from the source and listener velocities along the line between them — Web Audio dropped its own),
 * {@link airAbsorptionCutoff} (high frequencies die with distance) and occlusion (a blocker between
 * source and listener: quieter and duller). {@link distanceGain} and {@link coneGain} are twins of
 * the panner's distance models and cone, for culling and tests. {@link SpatialAudioSource} applies
 * all of it to one voice per frame; {@link SpatialAudioSystem} does it for every
 * {@link AudioEmitterComponent} relative to the {@link AudioListenerComponent} (band 800, after
 * transforms).
 */

import { Component, registerComponent } from "../scene/components.js";
import { Transform } from "../scene/components/index.js";
import { System, type SystemContext } from "../scene/systems.js";
import type { Vec3Ops } from "../math/vec.js";
import type { AudioVoice } from "./source.js";
import type { AudioSystem } from "./system.js";
import type { AudioClip, PlayOptions } from "./types.js";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Engine (left-handed) → Web Audio (right-handed): negate z. Alias-safe. */
export function toAudioSpace(v: Vec3Ops, out: Vec3Like = { x: 0, y: 0, z: 0 }): Vec3Like {
  const x = v.x, y = v.y, z = v.z;
  out.x = x;
  out.y = y;
  out.z = -z;
  return out;
}

function write(param: AudioParam, value: number, time: number, smoothing: number): void {
  if (smoothing > 0) param.setTargetAtTime(value, time, smoothing);
  else param.setValueAtTime(value, time);
}

/** Place a panner at an engine-space position. */
export function setPannerPosition(panner: PannerNode, p: Vec3Ops, time: number, smoothing = 0): void {
  write(panner.positionX, p.x, time, smoothing);
  write(panner.positionY, p.y, time, smoothing);
  write(panner.positionZ, -p.z, time, smoothing);
}

/** Aim a panner's cone along an engine-space direction. */
export function setPannerOrientation(panner: PannerNode, d: Vec3Ops, time: number, smoothing = 0): void {
  write(panner.orientationX, d.x, time, smoothing);
  write(panner.orientationY, d.y, time, smoothing);
  write(panner.orientationZ, -d.z, time, smoothing);
}

/** Place the context's listener from engine-space position, forward and up. */
export function setAudioListener(context: BaseAudioContext, position: Vec3Ops, forward: Vec3Ops, up: Vec3Ops, time = context.currentTime, smoothing = 0): void {
  const l = context.listener;
  if (l.positionX) {
    write(l.positionX, position.x, time, smoothing);
    write(l.positionY, position.y, time, smoothing);
    write(l.positionZ, -position.z, time, smoothing);
    write(l.forwardX, forward.x, time, smoothing);
    write(l.forwardY, forward.y, time, smoothing);
    write(l.forwardZ, -forward.z, time, smoothing);
    write(l.upX, up.x, time, smoothing);
    write(l.upY, up.y, time, smoothing);
    write(l.upZ, -up.z, time, smoothing);
  } else {
    // Older WebKit: the deprecated setters.
    const legacy = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void };
    legacy.setPosition(position.x, position.y, -position.z);
    legacy.setOrientation(forward.x, forward.y, -forward.z, up.x, up.y, -up.z);
  }
}

/** Listener pose from a camera's world matrix (column-major; the camera looks down its local +Z). */
export function listenerFromMatrix(m: ArrayLike<number>): { position: Vec3Like; forward: Vec3Like; up: Vec3Like } {
  const norm = (x: number, y: number, z: number): Vec3Like => {
    const l = Math.hypot(x, y, z) || 1;
    return { x: x / l, y: y / l, z: z / l };
  };
  return {
    position: { x: m[12]!, y: m[13]!, z: m[14]! },
    forward: norm(m[8]!, m[9]!, m[10]!),
    up: norm(m[4]!, m[5]!, m[6]!),
  };
}

export interface ListenerPose {
  position: Vec3Ops;
  forward: Vec3Ops;
  up: Vec3Ops;
}

/**
 * Web Audio's azimuth (degrees, −180..180; + is to the listener's right) of an engine-space
 * source, computed exactly as the spec's "Azimuth and Elevation" does after the conversion into
 * audio space. Elevation is not needed for the equal-power panner and is not returned.
 */
export function pannerAzimuth(listener: ListenerPose, source: Vec3Ops): number {
  const p = toAudioSpace(listener.position), s = toAudioSpace(source);
  const f = toAudioSpace(listener.forward), u0 = toAudioSpace(listener.up);
  let sx = s.x - p.x, sy = s.y - p.y, sz = s.z - p.z;
  const sl = Math.hypot(sx, sy, sz);
  if (sl === 0) return 0;
  sx /= sl; sy /= sl; sz /= sl;
  const fl = Math.hypot(f.x, f.y, f.z) || 1;
  const fx = f.x / fl, fy = f.y / fl, fz = f.z / fl;
  // listenerRight = normalize(forward × up)
  let rx = fy * u0.z - fz * u0.y, ry = fz * u0.x - fx * u0.z, rz = fx * u0.y - fy * u0.x;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // up = right × forward
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const upProj = sx * ux + sy * uy + sz * uz;
  let px = sx - upProj * ux, py = sy - upProj * uy, pz = sz - upProj * uz;
  const pl = Math.hypot(px, py, pz);
  if (pl === 0) return 0;
  px /= pl; py /= pl; pz /= pl;
  let azimuth = (180 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, px * rx + py * ry + pz * rz)));
  const frontBack = px * fx + py * fy + pz * fz;
  if (frontBack < 0) azimuth = 360 - azimuth;
  azimuth = azimuth >= 0 && azimuth <= 270 ? 90 - azimuth : 450 - azimuth;
  return azimuth > 180 ? azimuth - 360 : azimuth;
}

/** The spec's equal-power panning gains for a mono source at `azimuth` degrees. */
export function equalPowerGains(azimuth: number): { left: number; right: number } {
  let a = Math.max(-180, Math.min(180, azimuth));
  // Sources behind the listener fold to the front, as the spec does.
  if (a < -90) a = -180 - a;
  else if (a > 90) a = 180 - a;
  const x = (a + 90) / 180;
  return { left: Math.cos((x * Math.PI) / 2), right: Math.sin((x * Math.PI) / 2) };
}

/** The panner's distance gain (Web Audio spec formulas). */
export function distanceGain(model: DistanceModelType, distance: number, refDistance = 1, maxDistance = 10_000, rolloff = 1): number {
  const ref = Math.max(0, refDistance);
  if (model === "linear") {
    const max = Math.max(ref, maxDistance);
    const d = Math.max(ref, Math.min(max, distance));
    const r = Math.max(0, Math.min(1, rolloff));
    return max === ref ? 1 : 1 - (r * (d - ref)) / (max - ref);
  }
  const d = Math.max(ref, distance);
  if (ref === 0) return 0;
  if (model === "exponential") return Math.pow(d / ref, -Math.max(0, rolloff));
  return ref / (ref + Math.max(0, rolloff) * (d - ref));
}

/** The panner's cone gain for a source facing `orientation`, heard from `listener` (spec). */
export function coneGain(source: Vec3Ops, orientation: Vec3Ops, listener: Vec3Ops, innerAngle = 360, outerAngle = 360, outerGain = 0): number {
  if (innerAngle >= 360 && outerAngle >= 360) return 1;
  const ox = orientation.x, oy = orientation.y, oz = orientation.z;
  const ol = Math.hypot(ox, oy, oz);
  if (ol === 0) return 1;
  const dx = listener.x - source.x, dy = listener.y - source.y, dz = listener.z - source.z;
  const dl = Math.hypot(dx, dy, dz);
  if (dl === 0) return 1;
  const angle = (180 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, (dx * ox + dy * oy + dz * oz) / (dl * ol))));
  const absInner = Math.abs(innerAngle) / 2, absOuter = Math.abs(outerAngle) / 2;
  if (angle <= absInner) return 1;
  if (angle >= absOuter) return outerGain;
  const x = (angle - absInner) / (absOuter - absInner);
  return (1 - x) + outerGain * x;
}

/**
 * Doppler pitch ratio `(c + v_listener) / (c − v_source)` with both velocities along the line from
 * the source to the listener (positive = approaching). `scale` exaggerates (games often use < 1 to
 * tame it); the ratio is clamped to [0.25, 4].
 */
export function dopplerRatio(source: Vec3Ops, sourceVelocity: Vec3Ops, listener: Vec3Ops, listenerVelocity: Vec3Ops, speedOfSound = 343, scale = 1): number {
  const dx = listener.x - source.x, dy = listener.y - source.y, dz = listener.z - source.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6 || scale === 0) return 1;
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const c = Math.max(1, speedOfSound);
  // Source moving toward the listener, listener moving toward the source (each capped below c).
  const vs = Math.min(c * 0.9, (sourceVelocity.x * ux + sourceVelocity.y * uy + sourceVelocity.z * uz) * scale);
  const vl = Math.max(-c * 0.9, -(listenerVelocity.x * ux + listenerVelocity.y * uy + listenerVelocity.z * uz) * scale);
  return Math.max(0.25, Math.min(4, (c + vl) / (c - vs)));
}

/**
 * Low-pass cutoff (Hz) standing in for air absorption over `distance` metres: about 20 kHz up close,
 * an octave lower for every ~350 m (`halfDistance`), floored at 1.5 kHz. Humid, warm air absorbs
 * less; this is the typical ~20 °C / 50 % RH falloff, not a full ISO 9613-1 model.
 */
export function airAbsorptionCutoff(distance: number, halfDistance = 350): number {
  return Math.max(1500, 20_000 * Math.pow(2, -Math.max(0, distance) / Math.max(1, halfDistance)));
}

/** Seconds for sound to travel `distance` metres. */
export function propagationDelay(distance: number, speedOfSound = 343): number {
  return Math.max(0, distance) / Math.max(1, speedOfSound);
}

export interface SpatialAudioOptions {
  /** Doppler exaggeration (0 disables). Default 1. */
  doppler?: number;
  speedOfSound?: number;
  /** Air absorption half distance (m); 0 disables. Default 350. */
  airAbsorption?: number;
  /** Gain and cutoff at full occlusion. Defaults 0.35 and 900 Hz. */
  occludedGain?: number;
  occludedCutoff?: number;
  /** Seconds for occlusion to settle (a blocker passing should not click). Default 0.12. */
  occlusionSmoothing?: number;
}

/**
 * Per-frame spatial state of one playing voice: position (and the velocity it implies), Doppler,
 * air absorption and occlusion. Needs a spatial voice (`PlayOptions.spatial`), which carries the
 * low-pass `filter` this drives.
 */
export class SpatialAudioSource {
  /** Smoothed 0..1 occlusion. */
  occlusion = 0;
  /** Doppler ratio applied last update. */
  doppler = 1;
  /** Low-pass cutoff applied last update (Hz). */
  cutoff = 20_000;
  distance = 0;
  readonly velocity = { x: 0, y: 0, z: 0 };
  private readonly position = { x: 0, y: 0, z: 0 };
  private hasPosition = false;
  private readonly options: Required<SpatialAudioOptions>;

  constructor(readonly voice: AudioVoice, options: SpatialAudioOptions = {}, readonly baseRate = 1) {
    this.options = {
      doppler: options.doppler ?? 1,
      speedOfSound: options.speedOfSound ?? 343,
      airAbsorption: options.airAbsorption ?? 350,
      occludedGain: options.occludedGain ?? 0.35,
      occludedCutoff: options.occludedCutoff ?? 900,
      occlusionSmoothing: options.occlusionSmoothing ?? 0.12,
    };
  }

  /**
   * Move the voice to `position` (engine space) for a frame of `dt` seconds, heard from
   * `listener` moving at `listenerVelocity`; `occluded` is this frame's raw 0..1 blockage.
   */
  update(dt: number, position: Vec3Ops, listener: Vec3Ops, listenerVelocity: Vec3Ops = ZERO, occluded = 0, forward?: Vec3Ops): void {
    const o = this.options;
    if (this.hasPosition && dt > 1e-6) {
      this.velocity.x = (position.x - this.position.x) / dt;
      this.velocity.y = (position.y - this.position.y) / dt;
      this.velocity.z = (position.z - this.position.z) / dt;
    }
    this.position.x = position.x;
    this.position.y = position.y;
    this.position.z = position.z;
    this.hasPosition = true;
    this.distance = Math.hypot(position.x - listener.x, position.y - listener.y, position.z - listener.z);
    const k = o.occlusionSmoothing > 0 ? 1 - Math.exp(-Math.max(0, dt) / o.occlusionSmoothing) : 1;
    this.occlusion += (Math.max(0, Math.min(1, occluded)) - this.occlusion) * k;
    this.doppler = o.doppler > 0 ? dopplerRatio(position, this.velocity, listener, listenerVelocity, o.speedOfSound, o.doppler) : 1;
    const air = o.airAbsorption > 0 ? airAbsorptionCutoff(this.distance, o.airAbsorption) : 20_000;
    // Occlusion pulls the cutoff toward `occludedCutoff` geometrically (an octave scale).
    this.cutoff = air * Math.pow(Math.min(1, o.occludedCutoff / air), this.occlusion);
    const v = this.voice;
    const t = v.context.currentTime;
    v.setPosition(position);
    if (forward) v.setOrientation(forward);
    v.source.playbackRate.setTargetAtTime(this.baseRate * this.doppler, t, 0.03);
    v.filter?.frequency.setTargetAtTime(this.cutoff, t, 0.03);
    v.setOcclusionGain(1 - (1 - o.occludedGain) * this.occlusion);
  }
}

const ZERO = { x: 0, y: 0, z: 0 };

/** Marks the entity whose Transform is the ears (normally the camera). The first one found is used. */
export class AudioListenerComponent extends Component {
  static readonly typeName = "AudioListener";
}
registerComponent(AudioListenerComponent, { name: "AudioListener", allowMultiple: false, editorGroup: "Audio" });

/** A sound that lives on an entity: started when its clip is ready, moved with the entity. */
export class AudioEmitterComponent extends Component {
  static readonly typeName = "AudioEmitter";
  /** The clip, or a function the system calls until it returns one (e.g. a resource handle's value). */
  clip: AudioClip | (() => AudioClip | null) | null;
  /** Play options; `spatial` is forced on. Loop for engines and ambiences. */
  options: PlayOptions;
  spatial: SpatialAudioOptions;
  /** Raycast-style blockage query (0..1) from the listener to this emitter, or null. */
  occlusion: ((from: Vec3Ops, to: Vec3Ops) => number) | null = null;
  /** Start as soon as the clip is ready. Default true. */
  autoplay = true;
  /** @internal */ voice: AudioVoice | null = null;
  /** @internal */ spatialSource: SpatialAudioSource | null = null;
  /** @internal */ started = false;

  constructor(clip: AudioClip | (() => AudioClip | null) | null = null, options: PlayOptions = {}, spatial: SpatialAudioOptions = {}) {
    super();
    this.clip = clip;
    this.options = options;
    this.spatial = spatial;
  }

  /** The voice playing now, if any. */
  get playing(): AudioVoice | null {
    return this.voice;
  }

  stop(fadeOut = 0): void {
    const voice = this.voice;
    this.voice = null;
    this.spatialSource = null;
    voice?.stop(fadeOut);
  }

  override onDetach(): void {
    this.stop(0.05);
  }
}
registerComponent(AudioEmitterComponent, { name: "AudioEmitter", allowMultiple: true, editorGroup: "Audio" });

export interface SpatialAudioSystemOptions {
  /** Default occlusion query for emitters without their own. */
  occlusion?: (from: Vec3Ops, to: Vec3Ops) => number;
}

/**
 * Band 800: put the listener on the {@link AudioListenerComponent}'s Transform, start emitters whose
 * clips are ready, and update every playing emitter's {@link SpatialAudioSource}. Does nothing while
 * the context is not running (autoplay policy), so no voice piles up before a gesture.
 */
export class SpatialAudioSystem extends System {
  readonly name = "audio";
  override readonly order = 800;
  override readonly after = ["transforms"];
  /** Emitters updated last frame. */
  active = 0;
  private readonly listenerPosition = { x: 0, y: 0, z: 0 };
  private readonly listenerVelocity = { x: 0, y: 0, z: 0 };
  private readonly emitterPosition = { x: 0, y: 0, z: 0 };
  private readonly emitterForward = { x: 0, y: 0, z: 1 };
  private hasListener = false;

  constructor(readonly audio: AudioSystem, private readonly options: SpatialAudioSystemOptions = {}) {
    super();
  }

  update(context: SystemContext): void {
    const audio = this.audio;
    if (audio.context.state !== "running") return;
    const world = context.world;
    const dt = context.dt;
    const listeners = world.store(AudioListenerComponent);
    if (listeners.count > 0) {
      const id = world.idForSlot(listeners.slotAt(0));
      const t = world.getComponent(id, Transform);
      if (t) {
        const pose = listenerFromMatrix(t.worldMatrixView);
        if (this.hasListener && dt > 1e-6) {
          this.listenerVelocity.x = (pose.position.x - this.listenerPosition.x) / dt;
          this.listenerVelocity.y = (pose.position.y - this.listenerPosition.y) / dt;
          this.listenerVelocity.z = (pose.position.z - this.listenerPosition.z) / dt;
        }
        this.listenerPosition.x = pose.position.x;
        this.listenerPosition.y = pose.position.y;
        this.listenerPosition.z = pose.position.z;
        this.hasListener = true;
        audio.setListener(pose);
      }
    }
    const emitters = world.store(AudioEmitterComponent);
    let active = 0;
    for (let i = 0; i < emitters.count; i++) {
      const e = emitters.valueAt(i);
      const id = world.idForSlot(emitters.slotAt(i));
      const t = world.getComponent(id, Transform);
      if (!t) continue;
      const m = t.worldMatrixView;
      const pos = this.emitterPosition;
      pos.x = m[12]!;
      pos.y = m[13]!;
      pos.z = m[14]!;
      if (!e.voice && e.autoplay && !e.started) {
        const clip = typeof e.clip === "function" ? e.clip() : e.clip;
        if (!clip) continue;
        e.voice = audio.play(clip, { ...e.options, spatial: true, position: { x: pos.x, y: pos.y, z: pos.z } });
        e.spatialSource = new SpatialAudioSource(e.voice, e.spatial, e.options.playbackRate ?? 1);
        e.started = true;
      }
      if (!e.voice || !e.spatialSource) continue;
      if (e.voice.ended) {
        e.voice = null;
        e.spatialSource = null;
        continue;
      }
      const query = e.occlusion ?? this.options.occlusion;
      const blocked = query && this.hasListener ? query(this.listenerPosition, pos) : 0;
      const f = this.emitterForward;
      f.x = m[8]!;
      f.y = m[9]!;
      f.z = m[10]!;
      e.spatialSource.update(dt, pos, this.listenerPosition, this.listenerVelocity, blocked, f);
      active++;
    }
    this.active = active;
  }
}
