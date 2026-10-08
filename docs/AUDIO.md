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
