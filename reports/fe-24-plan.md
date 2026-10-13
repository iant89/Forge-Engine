# fe-24 — Phase 16 Animation: implementation plan

## Where Phase 16 actually stands (main @ e94fbeb)

The task brief assumed Phase 16 was NOT STARTED. It is not: the CURRENT ENGINE STATE block marks
Phase 16 `[~] IN PROGRESS` (registry `"16": "inProgress"`), and every checkbox in the Phase 16
section is already `[x]`:

| Sub-phase | Roadmap items | State |
|-----------|---------------|-------|
| 16.1 Animation Clips | glTF animation import, clip sampling, AnimationSystem, skeleton node mapping | `[x]` (tests/animation/animation.test.ts) |
| 16.2 State Machines | states, transitions, blending | `[x]` |
| 16.3 Blend Trees | 1D, 2D | `[x]` |
| 16.4 IK | two-bone, FABRIK | `[x]` |
| 16.5 Skinning | palette, validation, GPU upload/render (browser-verified) | `[x]` |
| 16.6 Mechanical | rig, MechanicalSystem, wheel rig, rover arm | `[x]` |

The only reason the phase stays `[~]` is capability `assets.gltfAdvanced` (planned, closesWith 16.1):
extended glTF import. The Phase 9.1 decoder (`engine/src/core/tasks/gltfMesh.ts`) still *rejects*
skins, JOINTS/WEIGHTS, morph targets, EXT_mesh_gpu_instancing and Draco/meshopt, and it does not
decode images or build GPU materials. So a skinned GLB cannot reach the (already working) GPU
skinning path today; skinning data is authored in code.

The stale summary line at the top of ROADMAP.md ("Phases 16 through 28 remain NOT STARTED") is what
misled the brief; it contradicts the state block. This PR corrects it.

## Remaining work: 16.1 extended import, split into slices

- **16.1a Skin import (this PR).** Accept `skins[]` (joints, inverseBindMatrices, skeleton), `node.skin`,
  and JOINTS_0/WEIGHTS_0 vertex streams; validate per spec (unsigned joint indices, float or
  normalized weights, IBM MAT4 FLOAT count ≥ joints, joint indices in range of every skin that uses
  the mesh); emit `SkinningVertexData`-shaped arrays so a decoded primitive feeds the existing 16.5
  GPU path. More than four influences (JOINTS_1+) stays explicitly rejected.
- **16.1b Morph targets.** POSITION/NORMAL/TANGENT targets + default weights + `weights` animation
  channel; needs a renderer path (CPU blend first, GPU later) — the larger follow-up.
- **16.1c Images / material assembly.** decode `images[]` (bufferView + URI), samplers/textures, build
  engine materials (base colour, metal-rough, normal) on the main thread.
- **16.1d EXT_mesh_gpu_instancing.** Decode instance TRS streams into the existing instanced batches.
- **16.1e Draco / meshopt.** WASM decoders, lazy-loaded like Basis.
- **16.1f Skinned GLB end-to-end.** Load a real skinned+animated GLB into a scene (entities per joint,
  SkinBinding, clip playback) with a browser gate. Depends on 16.1a; makes `assets.gltfAdvanced`
  closable together with b–e.

`assets.gltfAdvanced` stays `planned` until those land; this PR adds a separate `assets.gltfSkins`
capability for what it verifies (unit + worker tests; no browser claim).

## Next

16.1f (skinned GLB through to the GPU path, with a browser gate) is the natural next PR, then 16.1c
(images/materials), which the Mars and population GLBs would benefit from.
