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

## Spatial audio

Spatial voices use an HRTF `PannerNode` by default, with configurable panning/distance models, attenuation, source cones, position and orientation. Update the `AudioVoice` or use `SpatialAudioEmitter` each simulation frame. Call `setListener` with the active camera transform. Web Audio handles HRTF, distance attenuation and Doppler processing on its audio thread. `setOcclusion` supplies a lightweight attenuation hook; richer geometry-driven obstruction can automate a bus `FilterEffect`.

## Procedural thunder

`createThunderBuffer` builds a deterministic crack and low-frequency rolling tail without downloading an asset. The weather demo plays it through an HRTF voice at the strike position and delays arrival by `distance / 343`, so distant HDR-emissive lightning is seen before it is heard.

## Lifetime

Loads are URL-deduplicated and cached, failed loads are evicted, and the voice limit steals the oldest voice. Ended voices disconnect automatically. Call `dispose()` to stop voices, disconnect graph nodes, clear decoded buffers and close the context.

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
