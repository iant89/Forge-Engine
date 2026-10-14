# Mars Dust Storm Survival: wind and difficulty

`?scene=mars-dust-storm` · code: `examples/src/scenes/dustStorm.ts` (game model) and
`examples/src/scenes/marsDustStormScene.ts` (scene).

## Wind is real drag, exaggerated by one hidden multiplier

Every wind effect on the rover (storm gusts, a dust devil's swirl push and inward pull, its
updraft lift, and the yaw and roll torques those forces cause) is aerodynamic drag

    F = ½ · ρ · v² · Cd · A        a = F · STORM_STRENGTH / mass

- ρ = 0.020 kg/m³, Mars surface air (about 1/60 of Earth's).
- Side push: Cd 1.2, A 6 m². Updraft on the belly: Cd 1.1, A 8.5 m².
- mass is read from the rover's vehicle config (Perseverance, 1025 kg). A heavier rover is
  pushed, spun and lifted proportionally less.
- Wind speeds are in the measured Mars range: storm mean up to 20 m/s with gusts up to 30 m/s;
  devil swirl 10–26 m/s × a size factor, capped at 31 m/s for wide or merged devils.

At `STORM_STRENGTH = 1` (real Mars) a 30 m/s gust is about 65 N on the rover's side, roughly
0.06 m/s². You would never feel it, and no devil could lift the rover. Real Mars wind is far too
thin to make a game, so each difficulty multiplies the force by a hidden factor. It isn't shown
in the UI.

| Difficulty | Multiplier | Mean 20 m/s wind | 30 m/s gust | Devils lift the rover? | Buried / flipped | Blown away |
|---|---|---|---|---|---|---|
| Easy | 30× | ≈0.8 m/s² | ≈1.9 m/s² | never (the strongest 31 m/s devil gives ≈2.6 m/s² of lift, under Mars g of 3.72) | rock free / righted, +15 s | respawn at last safe spot |
| Advanced | 50× | ≈1.4 m/s² | ≈3.1 m/s² | only the strongest (≳29 m/s) devils, right at the eye | rock free / righted, +15 s | respawn at last safe spot |
| Expert | 65× | ≈1.8 m/s² | ≈4.0 m/s² | strong (≳25 m/s) devils near the eye | back to last beam | run lost ("Blown away") |
| Unreal | 120× | ≈3.3 m/s² | ≈7.4 m/s² | any devil over ≈19 m/s near the eye | back to last beam | run lost ("Blown away") |

`?difficulty=easy|advanced|expert|unreal` sets the starting level (`hard` still works and means
Expert). The toolbar buttons and the touch pad (which cycles through the levels) switch it live and
restart the run.

## Guidance and beacons

On Easy and Advanced the route to the current beacon is drawn as small glowing white spheres,
spaced 2.2 m apart and floating just above the ground. They share one sphere geometry and two
materials, so the renderer draws them as instanced batches. A brightness and size wave travels
along them from the rover to the beacon. The route is the pathfinder's obstacle-aware path,
rounded by three Chaikin passes. A corner is only cut where the new chord stays clear of every
boulder. The off-screen arrow also shows on Easy and Advanced. Easy shows every beacon still ahead.
The other difficulties show only the current beacon.

A rover standing still on all six wheels is held by static friction against storm gusts. Updraft
lift is full strength up to 5 m above ride height and fades to zero at 16 m, with vertical air
drag on the climb. A strong devil can hold the rover aloft while it stays in the eye, but it
cannot carry it off forever. Once the rover leaves the vortex it falls.

## Blown away

The game tracks the last safe spot: the position and heading where at least five of six wheels
were down, the rover was upright, and no devil was acting on it, for 1 s. A wind episode starts
only when a devil lifts the rover (or shoves it at more than 2 m/s²) while it's mostly off the
ground. Driving off a ridge in still air never starts one. During an episode, the rover counts as
blown away once it's more than 30 m horizontally, or 8 m lower, from the safe spot. Easy and
Advanced respawn there with a short fade and 3 s without wind forces. Expert and Unreal end the
run with "Blown away".
