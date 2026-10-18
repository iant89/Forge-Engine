# Audio

Forge's audio subsystem is a browser-native Web Audio mixer (`engine/src/audio`). It uses the browser's asynchronous decoder, so WAV, MP3, Ogg Vorbis/Opus, AAC and other formats work whenever the current browser advertises the corresponding codec. Unsupported or malformed data rejects `load`/`decode`; Forge does not ship codec binaries.

```ts
const audio = new AudioSystem({ maxVoices: 96 });
await audio.resume(); // call from a click/tap to satisfy autoplay policy
const clip = await audio.load("/audio/engine.ogg");
const engine = audio.play(clip, {
  loop: true, spatial: true, bus: "sfx",
  position: { x: 0, y: 0.7, z: 2 },
  refDistance: 2, maxDistance: 150, fadeIn: 0.25,
});
```

## Mixer and effects

The standard buses are `master`, `music`, `sfx`, `dialogue`, and `ambient`; custom buses can be created. Each bus owns a live `EffectRack`. `FilterEffect`, feedback `DelayEffect`, `ConvolutionReverb`, and `CompressorEffect` can be inserted, removed, bypassed, and parameter-automated through their Web Audio nodes while voices play. Bus and voice gains support ramps to avoid clicks.

## Spatial audio (Phase 20.1)

Spatial voices use an HRTF `PannerNode` by default, with configurable panning/distance models, attenuation, source cones, position and orientation. **All positions and directions are engine space.**

**Handedness.** Forge is left-handed (+X right, +Y up, cameras look down +Z); Web Audio is right-handed (the default listener looks down −Z). Writing engine coordinates straight into a panner mirrors left and right, and before 20.1 every demo did (a strike on the camera's right played in the left ear). `setAudioListener`, `setPannerPosition` and `setPannerOrientation` (`spatial.ts`) negate z and are the only writers; `AudioVoice`, `AudioSystem.setListener` and the vehicle/impact/particle soundscapes all go through them. `pannerAzimuth` and `equalPowerGains` reproduce the spec's azimuth and equal-power panning on the CPU, which is how the suite proves +X is heard on the right of a camera facing +Z. `listenerFromMatrix` reads a camera's world matrix (+Z forward, +Y up).

**Voice chain.** `source → volume gain → occlusion gain → low-pass → panner → bus` (non-spatial voices skip the last two). Occlusion has its own gain so it never fights `setVolume`.

**Propagation** (Web Audio removed its own Doppler):

| Effect | Function | Model |
| --- | --- | --- |
| distance | panner, `distanceGain` twin | the spec's inverse / linear / exponential formulas |
| cone | panner, `coneGain` twin | the spec's inner/outer angle interpolation |
| Doppler | `dopplerRatio` → `playbackRate` | `(c + v_listener)/(c − v_source)` along the source→listener line, `scale` to tame it, clamped 0.25–4 |
| air absorption | `airAbsorptionCutoff` → low-pass | ~20 kHz close, an octave lower every ~350 m, floor 1.5 kHz (typical 20 °C / 50 % RH falloff, not ISO 9613-1) |
| occlusion | caller query (e.g. a physics raycast) | smoothed 0..1 (120 ms) pulling the cutoff toward 900 Hz geometrically and the level to 0.35 |
| delay | `propagationDelay` | distance / c (lightning schedules thunder with it) |

`SpatialAudioSource(voice)` applies Doppler (velocity from the position delta), air absorption and occlusion to one voice per frame. In the ECS, put `AudioListenerComponent` on the camera entity and `AudioEmitterComponent(clip | () => clip | null, playOptions, spatialOptions)` on sounding entities, and register `SpatialAudioSystem(audioSystem, { occlusion })`: band 800, after transforms, it moves the listener, starts emitters once their clip is ready (and the context runs), follows their transforms and cone direction, and stops a voice when its component is removed. A steady frame creates no nodes. `SpatialAudioEmitter` remains for code that moves a voice by hand.

Not modelled: reverb from geometry, sound bending around corners, per-band absorption beyond one low-pass.

## Procedural thunder

`createThunderBuffer` builds a deterministic crack and low-frequency rolling tail without downloading an asset. The weather demo plays it through an HRTF voice at the strike position and delays arrival by `distance / 343`, so distant HDR-emissive lightning is seen before it is heard.

## Audio resources (Phase 20.2)

Decoded clips are `ResourceRegistry` entries (`resources.ts`), so audio has what every other asset has: one load per id shared by concurrent requests, refcounted handles, a byte budget with LRU eviction of idle entries, content-hash invalidation, cancellation and validation. Pass `registry: engine.resources` to `AudioSystem` to share the engine's budget; by default it owns a private one.

* **Ids and bytes.** `audio:<first url>`; `bytes` is the decoded size, frames × channels × 4 (Web Audio keeps float32 PCM — a 3 MB Ogg is ~40 MB resident, and that is what the budget must count). `stats().clipBytes` sums it (`registry.bytesOfKind("audio")`).
* **`acquire(source)`** returns a handle (release it when done); **`load(url)`** keeps one for the life of the system (as before), **`clearCache()`** releases them so they become evictable. A failed load is not kept; the next one retries. Evicting a clip never cuts a voice playing it: Web Audio keeps a playing buffer alive.
* **Formats.** A source can be alternatives, `[{ url: "a.opus", type: "audio/ogg; codecs=opus" }, { url: "a.m4a", type: "audio/mp4" }]`: types the browser refuses (`canPlayType`) are skipped, "probably" outranks "maybe", and a source that fails to fetch or decode falls through to the next. Forge ships no codecs; `decodeAudioData` decides.
* **Validation.** Empty or channel-less output is rejected; clips over `streamAbove` (30 s) are flagged — those belong to streaming (20.3).
* **Procedural clips.** `proceduralClipDescriptor(name, build)` (`audio:procedural/<name>`) caches synthesized buffers like files; the weather demo's thunder variants are registry clips.
* **Banks.** `new AudioBank(name, audio, { key: source, … })` loads a set together (`load()`, `progress`, `failed`), returns clips by key, can `pin()` them against the budget, and `release()`s them together. Clips are tagged `bank:<name>`.

## Lifetime

The voice limit steals the oldest voice. Ended voices disconnect automatically. Call `dispose()` to stop voices, disconnect graph nodes, release held clips (and dispose the registry if the system owns it) and close the context.

## Vehicle audio (Phase 20.7)

Audio that responds to the vehicle simulation rather than to scripted cues. Three layers:

```
Vehicle (stepped) ──▶ VehicleSoundAnalyzer.update(dt) ──▶ VehicleSoundState + events
                                                          │
                          vehicleSoundLevels(state) ◀─────┘   (pure: gains 0..1, Hz)
                                    │
                    VehicleSoundscape.set(state) / play(events)  (WebAudio graph)
```

`VehicleAudio(vehicle, context, destination, options)` wires all three; call `update(dt)` once per
presented frame after the vehicle stepped.

### What is read, and what it drives

| Roadmap item | Read from the simulation | Sound |
| --- | --- | --- |
| Engine RPM | `vehicle.rpm`, normalised idle→redline | Firing frequency `rpm/60 × cylinders/2` (sawtooth + half-order sine + 2nd-order square); an `ElectricMotor` (no idle, a regen torque) is a whine at `rpm/60 × 14` instead |
| throttle | `vehicle.input.throttle` | Engine level, intake noise band rising with rpm |
| load | Σ driven-tyre `longForce × r` back through the ratio and efficiency, **capped by the torque the engine is delivering**, over peak torque | Load opens the engine low-pass and adds combustion grit; lift-off in gear above idle is *overrun* (burble). Revving in neutral or with the clutch open is unloaded; a closed-throttle slide is not load |
| gear | `vehicle.gear`, `transmission.shiftCount` / `shifting` | A `shift` event (from/to, harder at high throttle) plays a clunk; the open clutch dips the engine voice; reverse whines |
| tire slip | per wheel `kappa`, `alpha`, `normalLoad` | Combined slip `hypot(κ/κpeak, tanα/tanαpeak)` against the Pacejka peak (`pacejkaPeakSlip`) — a tyre below 0.7 of its peak is silent — scaled by the wheel's load share; squeal pitch rises with the sliding speed `max(|vLong|, slipReference)·hypot(κ, tanα)` |
| suspension | per wheel `compression` across the frame and the last substep's `compressionRate`; airtime | `impact` (compression speed ≥ 0.9 m/s, re-armed when the wheel settles), `bottomOut` (end of travel), `landing` (contact after ≥ 0.18 s airborne, louder for a faster fall): a pitch-dropping thump plus a surface burst |
| terrain | `surfaceAt(contactX, contactZ)` per wheel | `VEHICLE_SURFACE_SOUND` per surface: roar gain/cutoff, crunch (gravel, snow, sand), slosh (mud, water), squeal factor (asphalt 1, gravel 0.15) |

The terrain classifier has the shape of `TireTrackLayer.followVehicle`'s, so a scene that already
says what the ground is for tyre tracks reuses it (the off-road demo does, adding standing water).

### Contracts

* **The analyzer only reads.** A vehicle stepped with an analyzer reaches the bit-identical snapshot
  of one stepped without (tested), so replays and state hashes do not depend on audio being on.
  Audio is not in `DETERMINISTIC_SOURCES`; it may use `Math`.
* **Per presented frame, not per fixed step.** Events are detected across the frame, plus the last
  substep's compression rate so a sharp hit is not averaged away.
* **No allocation on a quiet frame.** Events are objects only when something happens.
* **`lint:arch`:** `audio/**` may import core, math, vehicles and audio only. Nothing in the
  simulation imports audio.
* **Autoplay.** A context only runs after a user gesture. The off-road demo creates it from the
  SOUND button (or M) and never chains simulation behaviour behind `resume()`.

### Verification

`tests/audio/vehicleAudio.test.ts` drives real `Vehicle`s on flat, bumped, undulating and classified
ground: idle, full-throttle runs through the gears, neutral free-revs, coasting, handbrake slides on
asphalt and gravel, wheelspin with TC off, a bump (front axle a wheelbase ahead of the rear), drops
from two heights, an electric drivetrain, and the WebAudio graph against a recording fake context.
A headless-Chromium smoke of `?scene=offroad` (SOUND clicked, W held) confirmed the context runs and
the state reads gravel and engine load with zero page errors; that is not a committed gate.

### Not done

* Output goes to any `AudioNode` (the context destination in the demo); routing through
  `AudioSystem` buses with ducking/mixing is 20.4.
* Spatial is an optional HRTF panner on the whole car; no per-source placement (exhaust vs tyres)
  — 20.1.
* The engine is synthesized; there is no sample-based (granular RPM-crossfade) engine.

## Particle / impact audio (Phase 20.8)

Collisions and particle effects heard from the simulation.

### Impacts and scrapes

`PhysicsWorld.contactListener` (null by default) is called once per contact manifold after each
step's solve with a reused `ContactReport`: the bodies, mean point, normal, the largest **approach
speed before the solve** (the hit), the **tangential speed after it** (the slide) and the solver's
total normal impulse. It only reads; scratch lives at module scope, so a world with a listener
reaches the identical snapshot (tested).

`ImpactSoundAnalyzer(world, options)` installs it (chaining any listener already there; `dispose()`
restores it) and, per `update()`:

| Output | Rule |
| --- | --- |
| impact | approach ≥ `minImpactSpeed` (0.6 m/s — resting contact is ~g·dt), once per body pair per `cooldown` (80 ms); strength `log1p(E/2)/log1p(fullEnergy/2)` with `E = ½·m_reduced·v²`; the loudest `maxEventsPerFrame` (12) kept, the rest counted in `dropped` |
| scrape | slide ≥ `minScrapeSpeed` (0.3 m/s) under load (mean normal force ≈ the lighter body's weight reads as full); fastest slide per pair per frame; the loudest `maxScrapes` (4) |
| material | `materialOf(body)`, else `setImpactMaterial(body, m)` (a WeakMap — bodies and their snapshots are unchanged), else heightfield/plane → dirt, static → rock, dynamic → wood |
| size | largest extent of the shape (box side, sphere diameter, capsule tip to tip); ground is ∞ |

`impactVoice(event)` (pure) rings each finite body's material modes, scaled by `√(0.5 m / size)`
(smaller rings higher), with higher modes quieter and shorter and brought up by harder hits, plus a
band-passed noise transient coloured by the softer surface (a crate on snow thuds, on rock clacks).
`ImpactSoundscape` plays one decaying sine per mode plus the transient, each one-shot HRTF-panned at
the contact, under a voice cap (24); `setScrapes` drives four looping band-passed friction voices.

### Particles

`ParticleSoundAnalyzer(simulation, { kind, groundAt | groundY, burstBirths })` reads a CPU
`ParticleSimulation`'s state buffer after it stepped: births (`emitted` delta; ≥ `burstBirths` in a
frame is a burst), alive count, mean speed and centroid, and **ground hits** — slots whose height
above `groundAt(x, z)` went from positive to ≤ 0 moving down since the last update (the simulation
has no particle collisions, so the crossing is the hit; a slot reborn this frame has no history).
`particleSoundLevels` maps them per kind (`sparks`, `debris`, `spray`, `dust`) to a flow hiss (louder
with √alive and speed), one grain per hit (capped at 12 a frame, brighter for faster falls) and a
burst one-shot; `ParticleSoundscape` plays them, grains spread across the frame at the hit centroid.

### Demo and verification

Alpine Rescue plays the truck (20.7, six cylinders, on snow) and every physics contact — crates
(wood), boulders (rock), the medical case (plastic), the truck chassis (metal) and the terrain (snow)
— from the SOUND button or M. `tests/audio/impactAudio.test.ts` drops, bounces, piles and slides real
bodies, sprays a real particle simulation onto flat and raised ground, and checks both graphs on a
recording fake context. A headless-Chromium smoke of `?scene=alpine-rescue` at phone width (SOUND
tapped) confirmed the context runs, settling bodies produce impacts and scrapes that play and
release voices, and the truck idles at 40 Hz, with zero page errors; that is not a committed gate.

### Not done

* GPU particle worlds keep their state on the device and are silent (capability: audio.gpuParticles).
* Raycast vehicle wheels are not physics contacts; their hits are 20.7's suspension events.
* A box landing flat on a plane comes off it spinning about its vertical axis (a solver artifact,
  not audio), so it is heard scraping as it settles.
