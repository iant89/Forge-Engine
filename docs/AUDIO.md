# Audio (Phase 20)

Forge's audio is Web Audio, organised as a mixer: buses, decoded clips, voices and streams, owned by
one `AudioSystem`. The code is `engine/src/audio/`; `tests/audio/audioSystem.test.ts` checks it on a
strict mock context (`engine/src/testing/mockAudio.ts`).

```ts
import { AudioSystem } from "@forge/engine";

const audio = new AudioSystem({ masterVolume: 0.8, maxVoices: 32 });
button.onclick = () => audio.resume();               // browsers start audio only after a gesture

const clip = await audio.load("/sfx/door.ogg");     // fetched and decoded once per URL
const door = audio.play(clip, { spatial: true, position: doorPos, refDistance: 2 });
audio.setListener({ position: eye, forward, up });   // every frame, from the camera

const music = audio.stream("/music/theme.ogg", { loop: true, fadeIn: 2 });
await music.play();                                  // "blocked" until a gesture, then resume() plays it
audio.setBusVolume("music", 0.3, 1.5);               // duck the music over 1.5 s
```

## Buses (20.4)

| Bus | Feeds | Use |
| --- | --- | --- |
| `master` | the speakers | everything |
| `music`, `sfx`, `dialogue`, `ambient` | `master` | the defaults; voices go to `sfx`, streams to `music` |
| your own: `createBus("radio", "sfx")` | its parent | grouping you can fade or process together |

Each bus has an `EffectRack` (`audio.bus(name)`): filters, delay, convolution reverb and a compressor
can be added and removed while sounds play, and bypassed. An unknown bus or parent is a `UsageError`,
never a silent route to the speakers.

## Clips (20.2)

- `load(url)` fetches and decodes a URL once. Concurrent loads share the request.
- A 404 or an undecodable file rejects and is **evicted**, so a later load retries.
- `release(url)` and `clearCache()` drop clips; voices already playing them carry on.
- `stats()` reports `cachedClips` and `decodedSeconds` (seconds × channels) for the clips `load`
  keeps, and `clipBytes` for every audio clip in the registry. Codec support is the browser's `decodeAudioData` (WAV, MP3, AAC; Ogg/Opus outside Safari).

Under `load` the clips are registry resources — see *Audio resources (20.2)* below.

## Voices (20.1)

`play(clip, options)` starts a voice: buffer source → gain → (low-pass → panner, when `spatial`) → bus.

- **Fades start where the sound is.** Every gradual change — `setVolume(v, ramp)`, `stop(fadeOut)`,
  `setBusVolume`, a listener glide — is an anchored ramp (`rampParam`). An unanchored
  `linearRampToValueAtTime` starts from the previous automation event, which after a cancel can be
  long ago: the fade jumps, which is a click.
- **The voice limit holds.** Past `maxVoices`, the oldest voice is stolen: it fades out over 10 ms
  (`VOICE_STEAL_FADE`) and stops counting at once. `stats()` shows `activeVoices`, `releasingVoices`
  and `stolenVoices`. `stopVoice(voice, fade)` frees a slot the same way.
- **Spatial voices** use an HRTF panner by default (`distanceModel`, `refDistance`, `rolloffFactor`
  and cones are options). Positions are **engine space** (see *Spatial audio* below for the
  handedness conversion). `setListener` moves the ear; it falls back to the deprecated setters on
  Safari before 14.1. `SpatialAudioEmitter` moves a looping voice with an entity.
- **Occlusion** (`setOcclusion(0..1)`) scales the voice's own volume down to `OCCLUSION_FLOOR` (25 %)
  and closes its low-pass from the Nyquist frequency to `OCCLUSION_CUTOFF` (800 Hz), evenly in octaves.
  A quiet voice stays quiet behind a wall. The same low-pass carries air absorption
  (`setAirAbsorption(cutoff)`): the cutoff is the air cutoff, closed further toward 800 Hz by occlusion.

## Spatial audio (20.1)

Spatial voices use an HRTF `PannerNode` by default, with configurable panning/distance models, attenuation, source cones, position and orientation. **All positions and directions are engine space.**

**Handedness.** Forge is left-handed (+X right, +Y up, cameras look down +Z); Web Audio is right-handed (the default listener looks down −Z). Writing engine coordinates straight into a panner mirrors left and right, and before 20.1 every demo did (a strike on the camera's right played in the left ear). `setAudioListener`, `setPannerPosition` and `setPannerOrientation` (`spatial.ts`) negate z and are the only writers; `AudioVoice`, `AudioSystem.setListener` and the vehicle/impact/particle soundscapes all go through them. `pannerAzimuth` and `equalPowerGains` reproduce the spec's azimuth and equal-power panning on the CPU, which is how the suite proves +X is heard on the right of a camera facing +Z. `listenerFromMatrix` reads a camera's world matrix (+Z forward, +Y up).

**Propagation** (Web Audio removed its own Doppler):

| Effect | Function | Model |
| --- | --- | --- |
| distance | panner, `distanceGain` twin | the spec's inverse / linear / exponential formulas |
| cone | panner, `coneGain` twin | the spec's inner/outer angle interpolation |
| Doppler | `dopplerRatio` → `playbackRate` | `(c + v_listener)/(c − v_source)` along the source→listener line, `scale` to tame it, clamped 0.25–4 |
| air absorption | `airAbsorptionCutoff` → low-pass | ~20 kHz close, an octave lower every ~350 m, floor 1.5 kHz (typical 20 °C / 50 % RH falloff, not ISO 9613-1) |
| occlusion | caller query (e.g. a physics raycast) → `setOcclusion` | smoothed 0..1 (120 ms); the voice's gain floor (25 %) and low-pass toward 800 Hz |
| delay | `propagationDelay` | distance / c (lightning schedules thunder with it) |

`SpatialAudioSource(voice)` applies Doppler (velocity from the position delta), air absorption (`setAirAbsorption`) and occlusion (`setOcclusion`) to one voice per frame. In the ECS, put `AudioListenerComponent` on the camera entity and `AudioEmitterComponent(clip | () => clip | null, playOptions, spatialOptions)` on sounding entities, and register `SpatialAudioSystem(audioSystem, { occlusion })`: band 800, after transforms, it moves the listener, starts emitters once their clip is ready (and the context runs), follows their transforms and cone direction, and stops a voice when its component is removed. A steady frame creates no nodes. `SpatialAudioEmitter` remains for code that moves a voice by hand.

Not modelled: reverb from geometry, sound bending around corners, per-band absorption beyond one low-pass.

## Audio resources (20.2)

Decoded clips are `ResourceRegistry` entries (`resources.ts`), so audio has what every other asset has: one load per id shared by concurrent requests, refcounted handles, a byte budget with LRU eviction of idle entries, content-hash invalidation, cancellation and validation. Pass `registry: engine.resources` to `AudioSystem` to share the engine's budget; by default it owns a private one.

* **Ids and bytes.** `audio:<first url>`; `bytes` is the decoded size, frames × channels × 4 (Web Audio keeps float32 PCM — a 3 MB Ogg is ~40 MB resident, and that is what the budget must count). `stats().clipBytes` sums it (`registry.bytesOfKind("audio")`).
* **`acquire(source)`** returns a handle (release it when done); **`load(url)`** keeps one until **`release(url)`** (which also evicts the entry unless something else holds it, so the next load fetches again) or **`clearCache()`** (which leaves them to idle eviction). `AudioSystemOptions.fetch` is used for every fetch. A failed load is not kept; the next one retries. Evicting a clip never cuts a voice playing it: Web Audio keeps a playing buffer alive.
* **Formats.** A source can be alternatives, `[{ url: "a.opus", type: "audio/ogg; codecs=opus" }, { url: "a.m4a", type: "audio/mp4" }]`: types the browser refuses (`canPlayType`) are skipped, "probably" outranks "maybe", and a source that fails to fetch or decode falls through to the next. Forge ships no codecs; `decodeAudioData` decides.
* **Validation.** Empty or channel-less output is rejected; clips over `streamAbove` (30 s) are flagged — those belong in `stream()` (20.3). With a single source, a failure rejects with that source's own error (an `EncodingError` stays one).
* **Procedural clips.** `proceduralClipDescriptor(name, build)` (`audio:procedural/<name>`) caches synthesized buffers like files; the weather demo's thunder variants are registry clips.
* **Banks.** `new AudioBank(name, audio, { key: source, … })` loads a set together (`load()`, `progress`, `failed`), returns clips by key, can `pin()` them against the budget, and `release()`s them together. Clips are tagged `bank:<name>`.

## Streams (20.3)

`stream(url, options)` plays long audio — music, ambience beds — from a media element through a
`MediaElementAudioSourceNode`, so it streams and decodes progressively but still mixes on a bus.

- `play()` resolves with the state. A refusal by the autoplay policy leaves the stream `blocked`,
  and `audio.resume()` (from a gesture) retries it.
- `fadeIn`, `setVolume(v, ramp)`, `pause()`, `stop()` (rewinds), `onEnded`.
- Cross-origin streams need CORS (`crossOrigin` defaults to `"anonymous"`): without it the browser
  outputs silence through Web Audio.
- `dispose()` releases the element's network stream and its listeners.


## Procedural thunder

`createThunderBuffer` builds a deterministic crack and low-frequency rolling tail without downloading an
asset. The weather demo keeps four variants as registry clips (`proceduralClipDescriptor`), plays them
through an HRTF voice at the strike position, closes the voice's low-pass by the strike's distance
(air absorption), and the lightning simulation delays arrival by `distance / c`, so distant lightning
is seen before it is heard. (Web Audio's panner does distance
attenuation and HRTF, not Doppler: the spec removed it, so a moving source's pitch shift is the
game's to apply through `playbackRate`.)

## Lifecycle

`resume()` and `suspend()` follow the context. `dispose()` stops every voice and stream, disconnects
every node (the suite checks that nothing is left connected), releases kept clips (disposing the
registry when the system owns it) and closes the context.

## The mock (how this is tested)

`createMockAudio()` returns a `MockAudioContext` typed as `AudioContext`:

- **Graph.** Nodes record their connections. `paths(node)`, `reachesDestination(node)` and
  `pathGain(node, t)` (the product of the gains along every path to the speakers) say whether a
  sound is audible and how loud. `connectedNodes()` is the leak check.
- **Automation.** `AudioParam.valueAt(t)` evaluates the event timeline: set, linear and exponential
  ramps, `setTargetAtTime`, cancel, and cancel-and-hold. An unanchored ramp starts from time 0, the
  worst case.
- **Time.** `advance(seconds)` only moves while the context is `running`. Sources end once, at their
  stop or natural end.
- **Decoding.** `decodeAudioData` accepts `encodeMockAudio({ seconds, channels })` and rejects
  anything else with `EncodingError`.
- **Media elements.** `play()` can be refused (`autoplayBlocked`).

It proves the graph, the timing and the bookkeeping, not what anything sounds like: no gate plays
audio on a device yet. The 20.1/20.2/20.7/20.8 suites use a lighter recording fake
(`tests/support/fakeAudio.ts`) for graph shape and parameter targets.

## Environmental and weather audio (20.5, 20.6)

`EnvironmentSoundscape` (`ambience.ts`) is the world's ambience, driven by plain data
(`AmbienceInput`) that `ambienceSoundInput(weather.state, weather.surface, context)`
(`environment/soundInput.ts`) builds from the weather, the ground's memory of it (17.4) and the
listener's situation; audio and the environment never import each other. Call `update(input, dt)`
each frame; `ambienceLevels(input)` is the pure mapping the suite tests.

| Driven by | Sound |
| --- | --- |
| wind speed, gustiness | roar and a whistling gust howl, both rising with speed |
| wind direction vs `listenerYaw` | stereo pan toward the side the wind comes from |
| rain (liquid part of precipitation; snowfall is silent) | rain hiss; **wet ground and puddles** make it louder and brighter (splashes), **snow cover** duller |
| `enclosure` | the outdoor bed low-passed and quieter; rain becomes roof drumming |
| snow cover | the whole outdoor bed loses its highs (snow absorbs) |
| `underwater` | everything muffled to 350 Hz plus a low rumble; no birds |
| `surf` × storm | breaking waves |
| sun elevation, rain, wind, temperature | **birds**: none at night, a dawn chorus a few degrees above the horizon, steady by day; quiet in rain, wind over ~10 m/s and frost. Phrases of 2–5 swept chirps at random points around the listener |
| sun elevation, temperature | **crickets** on warm nights (> 8 °C), chirping at Dolbear's rate (≈ (7·T + 30)/min) |
| `reflectivity`, `enclosure` | reverb decay 0.3–2.7 s and mix: procedural impulses, rebuilt only when the decay crosses a 0.25 s bucket |

`soundscape.reverb` is an `AudioEffect`: add it to a bus (`audio.bus("sfx").add(scape.reverb)`) so
engines and impacts ring like the place they are in. The weather, off-road and Alpine demos now run
on an `AudioSystem`: ambience on `ambient`, vehicles and impacts on `sfx` with the reverb. The older
`StormSoundscape` (fe-34) stays for the hurricane demo, which still plays it straight to the speakers.

Not modelled: positional ambient emitters (a river, wind in particular trees), recorded beds, and
weather on surfaces under cover (the surface state is scene-wide).

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
| Engine RPM | `vehicle.rpm`, normalised idle→redline | Firing frequency `rpm/60 × firingsPerRev` (sawtooth + half-order sine + 2nd-order square), where `firingsPerRev = cylinders × 2/strokes` — a four-stroke fires each cylinder every other revolution, a two-stroke every one; an `ElectricMotor` (no idle, a regen torque) is a whine at `rpm/60 × 14` instead |
| throttle | `vehicle.input.throttle` | Engine level, intake noise band rising with rpm |
| load | Σ driven-tyre `longForce × r` back through the ratio and efficiency, **capped by the torque the engine is delivering**, over peak torque | Load opens the engine low-pass and adds combustion grit; lift-off in gear above idle is *overrun* (burble). Revving in neutral or with the clutch open is unloaded; a closed-throttle slide is not load |
| gear | `vehicle.gear`, `transmission.shiftCount` / `shifting` | A `shift` event (from/to, harder at high throttle) plays a clunk; the open clutch dips the engine voice; reverse whines |
| tire slip | per wheel `kappa`, `alpha`, `normalLoad` | Combined slip `hypot(κ/κpeak, tanα/tanαpeak)` against the Pacejka peak (`pacejkaPeakSlip`) — a tyre below 0.7 of its peak is silent — scaled by the wheel's load share; squeal pitch rises with the sliding speed `max(|vLong|, slipReference)·hypot(κ, tanα)` |
| suspension | per wheel `compression` across the frame and the last substep's `compressionRate`; airtime | `impact` (compression speed ≥ 0.9 m/s, re-armed when the wheel settles), `bottomOut` (end of travel), `landing` (contact after ≥ 0.18 s airborne, louder for a faster fall): a pitch-dropping thump plus a surface burst |
| terrain | `surfaceAt(contactX, contactZ)` per wheel | `VEHICLE_SURFACE_SOUND` per surface: roar gain/cutoff, crunch (gravel, snow, sand), slosh (mud, water), squeal factor (asphalt 1, gravel 0.15) |

The terrain classifier has the shape of `TireTrackLayer.followVehicle`'s, so a scene that already
says what the ground is for tyre tracks reuses it (the off-road demo does, adding standing water).

`{ cylinders, strokes }` are the whole engine character: `strokes: 2` doubles the firing frequency of
the same cylinder count (a single-cylinder two-stroke buzzes an octave above a single-cylinder
four-stroke), opens the engine low-pass further and brightens it with rpm (`+600 + 1400 × rpmNorm`),
and cuts the combustion grit to 0.55 — a two-stroke buzzes rather than rumbles. Above 42% of the rev
range and under throttle it also puts an **expansion-chamber ring** at `4 ×` the firing frequency on
the whine voice (the one a four-stroke leaves free in forward gear, where it only carries reverse
whine), capped at 0.3. The off-road hill demo runs `{ cylinders: 1, strokes: 2 }`. No nodes are added:
the graph stays 12 sources, which `tests/audio/vehicleAudio.test.ts` pins.

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

* Output goes to any `AudioNode`; the demo uses the context destination rather than a bus
  (`audio.bus("sfx").input` works), so nothing ducks it.
* Spatial is an optional HRTF panner on the whole car; no per-source placement (exhaust vs tyres).
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
