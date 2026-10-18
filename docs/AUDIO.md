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
- `stats()` reports `cachedClips` and `decodedSeconds` (seconds × channels), the memory the cache
  holds. Codec support is the browser's `decodeAudioData` (WAV, MP3, AAC; Ogg/Opus outside Safari).

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
  and cones are options). `setListener` moves the ear; it falls back to the deprecated setters on
  Safari before 14.1. `SpatialAudioEmitter` moves a looping voice with an entity.
- **Occlusion** (`setOcclusion(0..1)`) scales the voice's own volume down to `OCCLUSION_FLOOR` (25 %)
  and closes its low-pass from the Nyquist frequency to `OCCLUSION_CUTOFF` (800 Hz), evenly in octaves.
  A quiet voice stays quiet behind a wall.

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
asset. The weather demo plays it through an HRTF voice at the strike position and delays arrival by
`distance / 343`, so distant lightning is seen before it is heard. (Web Audio's panner does distance
attenuation and HRTF, not Doppler: the spec removed it, so a moving source's pitch shift is the
game's to apply through `playbackRate`.)

## Lifecycle

`resume()` and `suspend()` follow the context. `dispose()` stops every voice and stream, disconnects
every node (the suite checks that nothing is left connected) and closes the context.

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
audio on a device yet.

## Still to come

Environmental (20.5), weather (20.6), vehicle (20.7) and impact (20.8) audio driven by simulation
state. The storm soundscape (`StormSoundscape`, fe-34) already maps weather to synthesized wind, rain,
surf and thunder, but plays straight into a node rather than through the buses.
