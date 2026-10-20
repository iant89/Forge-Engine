# Beacon Defense (the playable game demo)

`?scene=beacon` is a complete turret-defense game built out of the engine: twelve waves of four drone
types close on a beacon in a night arena, a turret fights on its own, and the player aims it, fires a
manual cannon, spends credits on six upgrades and triggers three cooldown abilities. Clear wave 12 to
win; lose when the beacon's integrity reaches zero.

Four files, one per layer:

| File | Owns |
| --- | --- |
| `examples/src/scripting/beaconDefenseGame.ts` | **The rules.** Data tables, events, components and five scripts: `GameState`, `Beacon`, `Drone`, `Turret`, `WaveDirector`. Everything that decides an outcome lives here, on the fixed-step clock, with no `Math.random` and no `Date.now`. |
| `examples/src/scenes/beaconDefenseScene.ts` | **The stage.** Arena geometry and models (built with the demo's `meshKit`), lights, HDR/bloom/fog, particle bursts, shot tracers, camera modes, pointer and keyboard input, and the host side of the event bridge. |
| `examples/src/ui/beaconHud.ts` | **The HUD.** Engine-UI widgets drawn by the WebGPU UI pass: vitals, minimap, wave objectives, ability hotbar with cooldown rings, upgrade shop, banner, toasts and a world-space label over the beacon. |
| `examples/src/audio/beaconSounds.ts` | **The sound.** Fifteen effects synthesised from numbers — a pure `renderBeaconSound(name, sampleRate)` and a gesture-gated `BeaconSoundscape` that plays them through `AudioSystem` on the `sfx` bus. |

`tests/examples/beaconDefenseGame.test.ts` (23 checks) plays the whole game on the mock device, draws
it through a real `Renderer`, and checks the DSP and the HUD without a browser.

> **Not the same scene as `?scene=scripting`.** That one is the Phase 18 exit criterion: a smaller
> Beacon Defense written *only* as scripts, kept deliberately minimal to prove the scripting API.
> This one is the game that criterion grew into — same discipline for the rules, plus everything a
> playable demo needs around them. See [SCRIPTING.md](SCRIPTING.md#beacon-defense-the-exit-criterion).

## Playing it

```bash
npm run setup && npm run build && npm run demo
# then open http://localhost:5173/?scene=beacon
```

| Input | Does |
| --- | --- |
| Move the pointer | Aims the cannon; the barrel follows your aim for 2.5 s before returning to its own target |
| Click / `Space` | Fires the manual cannon (hitscan along the aim ray, piercing every drone it touches) |
| `1` `2` `3` | EMP pulse · Overcharge · Field repair |
| `4`–`9` | Buy Warhead · Servo · Optics · Rack · Bulwark · Cooling |
| `Enter` | Call the next wave early (skips the intermission) |
| `C` | Cycle camera: arena → turret → top-down |
| `P` / `Esc` | Pause (freezes the engine clock *and* the HUD's cooldown rings) |
| `R` | Restart the run |
| `M` | Sound on/off |

Query parameters: `?tier=low|medium|high` forces the device tier (shadow map, cascades, particle
capacity, sprite pool), `?sound=0` starts silent. Sound always waits for the first gesture — the
autoplay policy decides, not the scene.

Between waves the arena goes quiet for eight seconds; the HUD counts it down and offers
**CALL NEXT WAVE**. Kills pay credits, clearing a wave pays a bonus that grows with the wave number,
and the shop is the only way to keep up with the armour scaling.

## How the two halves talk

The stage never decides a rule and the rules never draw a pixel. They exchange typed events on the
script runtime's bus — the host posts commands, the game posts outcomes:

| Host → game | Effect |
| --- | --- |
| `PlayerAim {x, z}` | The cannon's aim point on the flight plane; the barrel holds it for `aimHoldSteps` |
| `PlayerFire` | Requests a shot; the turret's own cooldown decides whether one leaves |
| `BuyUpgrade {id}` / `UseAbility {id}` | Spends credits, or refuses with a reason |
| `CallWave` | Ends the intermission now |
| `GameRestart` | Resets the run (also fires itself six seconds after a loss, ten after a win) |

| Game → host | The stage's response |
| --- | --- |
| `ShotFired {source, damage, hits, dirX, dirZ, reach, …}` | A tracer, a muzzle burst, a shot sound, a nudge of camera shake |
| `DroneDown {kind, points, credits, x, y, z}` | An explosion (bigger for bruisers and bombers), debris, a boom |
| `DroneSplit {x, z, wave, tick}` | Notification only — the shards themselves are already on the field |
| `BeaconDamaged {damage, hp, maxHp}` | Red sparks at the core, an alarm, real shake, an integrity banner below 25% |
| `BeaconRepaired {amount, hp, maxHp}` | Green sparks, a chime, a toast |
| `WaveStarted` / `WaveCleared` | Banner, objective update, sting |
| `UpgradeBought {id, level, cost, credits}` / `PurchaseRefused {id, reason}` | A toast (and a refusal buzz with the reason spelled out) |
| `AbilityUsed {id, tick}` / `AbilityReady {id}` | EMP ring, overcharge flare, cooldown ring reset |
| `GameOver {wave, score, kills}` / `GameWon {score, kills}` | End panel, banner, the run's cadence |

The scene queues every request it receives and flushes the queue once per presentation frame, so a
volley of kills cannot stall the frame, and the queue is bounded.

## The numbers

Drones (`DRONE_SPECS`) — hp and speed are scaled per wave by `waveSpec`:

| Kind | HP | Speed | Points | Credits | Radius | Beacon damage | Behaviour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scout | 3 | 3.6 | 12 | 7 | 0.60 | 4 | Fast, fragile, numerous |
| Splitter | 6 | 2.6 | 20 | 11 | 0.75 | 5 | Dies into two scout shards |
| Bruiser | 16 | 1.7 | 45 | 20 | 1.05 | 12 | Armoured, slow, six rotors |
| Bomber | 10 | 2.2 | 60 | 28 | 0.95 | 22 | Worth the most, hurts the most |

Waves (`waveSpec(w)`): `2 + w` scouts always; splitters from wave 3 (`⌊(w−1)/2⌋`), bruisers from 5
(`⌊(w−3)/2⌋`), bombers from 8 (`⌊(w−5)/3⌋`, zero at wave 7 so it is not listed); armour
`1 + 0.16(w−1)`, speed `1 + 0.045(w−1)`, one spawn every `max(14, 42−2w)` steps. A full run sends
**159 drones** before any splitter shards. `FINAL_WAVE` is 12.

Upgrades (`UPGRADES`, cost `round(base · growth^level)`):

| Id | Name | Key | Max | Base | Growth | Per level |
| --- | --- | --- | --- | --- | --- | --- |
| `damage` | Warhead | 4 | 6 | 45 | 1.55 | +30% of base damage, both weapons |
| `rate` | Servo | 5 | 6 | 50 | 1.60 | turret interval ×0.86 |
| `range` | Optics | 6 | 5 | 35 | 1.50 | +3 m, turret and cannon |
| `multishot` | Rack | 7 | 3 | 110 | 2.00 | +1 simultaneous target / pierce |
| `shield` | Bulwark | 8 | 5 | 60 | 1.70 | +25 integrity ceiling, and heals 25 |
| `cooling` | Cooling | 9 | 5 | 40 | 1.55 | cannon interval ×0.82 |

Maxing all six costs 5 310 credits (Warhead 1 054, Servo 1 315, Optics 462, Rack 770, Bulwark
1 131, Cooling 578), which is why a run has to earn them.

Abilities (`ABILITIES`, cooldowns in fixed steps at 60 Hz):

| Id | Name | Key | Cost | Cooldown | Effect |
| --- | --- | --- | --- | --- | --- |
| `emp` | EMP Pulse | 1 | 30 | 1080 (18 s) | Every drone flies at 35% speed for 300 steps |
| `overcharge` | Overcharge | 2 | 45 | 1440 (24 s) | 2.5× damage and half the turret interval for 360 steps |
| `repair` | Field Repair | 3 | 40 | 1800 (30 s) | Heals 30% of the integrity ceiling |

`DEFAULT_GAME_TUNING` holds the rest: 120 beacon integrity, a 34 m spawn ring, a turret that fires
every 26 steps for 3 damage out to 22 m, a cannon every 20 steps for 6 damage out to 30 m, 60
starting credits, an 8 s intermission, and a wave-clear bonus of `25 + 8·wave`.

Balance, measured on the mock device: an unattended run survives 171 s of game time, kills 67 drones,
leaks 18 and falls during wave 8. A player who aims at the nearest drone, holds the trigger and
spends sensibly wins at wave 12 in 170 s — 219 kills, 60 shards cleaned up, no leaks, 3 864 points
and 195 integrity left (three Bulwarks raised the ceiling from 120).

## Stage systems

**Models.** Every drone is one merged mesh (one material, one draw), built from `meshKit`'s
`roundedBoxSource`, the engine's primitive sources and `tubeBetween`, then closed and outward-wound —
`signedVolume` is asserted positive for all seven models. The beacon is a lattice tower plus a
separate emissive core, because the core is the entity the game damages and flashes.

**Particles.** A CPU `ParticleSimulation` (2 600 particles at the high tier) whose emitter rate is
pinned to zero: bursts call `emitter.emit(state, 1/60, count)` directly, which spawns exactly `count`
particles, so an explosion is the size the game asked for. Alive particles are posed onto a pool of
320 tiny emissive sprites, with per-particle colour and age-driven fade and shrink applied while
posing (rather than by a `ColorOverLife` module, which would flatten every burst to one gradient).
Tracers are a 28-slot pool of thin boxes, oriented with `Transform.lookAt` and faded over ~0.1 s.

**HUD.** Engine UI in the `hud` layer: `HealthBar`, `ResourceCounter`, `StatDisplay`,
`MinimapContainer`, `ObjectiveTracker`, `TargetHealthDisplay`, `Hotbar` with `AbilityButton`s and
their `CooldownIndicator` rings, `Button`s for the shop, `Toasts`, `InteractionPrompt` and a
`WorldSpaceLabel` floating over the beacon. The minimap's arena art is generated, not loaded:
`arenaMapPixels(size, rings)` returns RGBA bytes registered with `ui.assets.registerPixels`. Cooldown
rings are *started* when an ability fires and then tick themselves down with `ui.update(dt)` — and
because pausing passes `dt = 0`, a paused game cannot drift a ring.

**Sound.** `renderBeaconSound` is pure: a seeded PRNG, damped tones, filtered noise and MIDI-note
figures, normalised to the effect's mix level. Tests assert lengths, determinism, peak and RMS, and
that the cannon is lower and longer than the servo shot (`spectralCentroid`). `BeaconSoundscape`
builds each buffer once, plays through `AudioSystem` on the `sfx` bus, positions arena events with a
panner, and rate-limits repeats per effect so a multishot volley cannot stack into clipping.

**Camera.** `cameraOverride()` supplies a fixed arena pose, a pose behind the yawing turret head, and
a top-down pose; the demo's orbit controller is bypassed while the scene is loaded. Damage and heavy
detonations add a decaying shake on the render clock — presentation only, never fed back into a rule.

## Determinism, and the one rule that guards it

Gameplay runs only on fixed steps, so a run is a function of its step sequence and not of the frame
rate. The tests pin that: 85 s of game time replayed as 1-step frames, random 0–4-step frames and
steady 4-step frames produces byte-identical kill ticks, score, integrity, shots, leaks and credits.

Building this found one real flaw, now fixed and pinned by a test. A splitter's shards were spawned
by a listener on the **posted** `DroneSplit` event, and posted events are flushed at the start of
*every* phase — so in a one-step frame the shards were created during that frame's render phase,
while in a four-step frame they were created inside the next fixed step. The wave director's clear
check (`Wait.until(() => store(DroneTag).count === 0)`) could therefore see an empty field between a
splitter dying and its shards arriving, and clear the wave a whole frame earlier on some frame
splits. The fix is a rule worth keeping:

> **Anything a rule depends on must happen inside the step that causes it.** Shards are created by
> the dying splitter itself (`spawnDrone`, the same helper the wave director uses), and `DroneSplit`
> survives as a notification for effects only.

The same reasoning is why the scene posts `PlayerAim` and `PlayerFire` once per frame rather than per
pointer event, and why nothing in the stage writes back into `GameState`.

## What the tests pin

- An unattended run leaks, falls and restarts itself with zero script errors.
- Identical runs under three frame splits.
- A bot wins at wave 12 in a single run; a separate check confirms the `GameWon` event and the
  post-victory restart.
- Wave composition (159 drones, the kinds' arrival waves, armour and speed scaling).
- Every upgrade's arithmetic, its price curve, and the four refusal reasons
  (`credits`, `maxLevel`, `cooldown`, `finished`).
- All three abilities: the slow flag on every live drone, the damage/rate window, the heal, and the
  `AbilityReady` event when a cooldown clears.
- Splitters produce exactly two shards at the death point, tallied on the run.
- The cannon kills what it is aimed at, and with a 4 m range kills nothing aimed away.
- Pause freezes kills, shots, drones, integrity, credits, score and the sim tick; restart resets them.
- The intermission is exactly 480 steps, and `CallWave` cuts it to one.
- Events become sparks, tracers, banners and toasts; the HUD mirrors the game (vitals, markers,
  threat, upgrade rows, ability rows, the registered arena map).
- The models are closed solids; a real `Renderer` pass over the mock GPU draws every camera mode and
  a paused frame with no device validation errors; disposing releases every buffer and texture.
- Sound: lengths, determinism, no clipping, spectral character, mixer voices, panners, rate limiting,
  and a scene that stays silent until it has a context.

## Extending it

- **A new drone kind:** add it to `DroneKind` and `DRONE_SPECS`, give it a model in
  `droneSources()`, a material and a spark colour in the scene, and a marker colour in the HUD; then
  decide which waves send it in `waveSpec`.
- **A new upgrade:** one row in `UPGRADES`, one term in the relevant `GameState` derived getter, and
  one hotkey (the scene maps `Digit4`–`Digit9` in table order).
- **A new ability:** one row in `ABILITIES` (icon from the UI's built-in glyph set), its window or
  effect in `GameState.useAbility`, and its sound in `BEACON_SOUNDS`.
- **Different balance:** pass `tuning` to `buildBeaconDefenseScene`; every number above is in
  `DEFAULT_GAME_TUNING`, and the tests accept a custom tuning.
