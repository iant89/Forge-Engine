# Forge Engine performance history

This is the audited human-readable history for Roadmap Phase 22. Raw snapshots come from:

```sh
npm run build
npm run bench -- --json /tmp/forge-bench.json
```

The JSON file is schema-versioned and records stable metric IDs, every result, every shape/correctness
check, repeated raw samples, total run time, and the Node/OS/CPU/memory identity. Do not compare timings
from unlike hosts as if they were a regression. `npm run bench` enforces algorithmic shape, correctness,
deliberately broad catastrophe bounds, and—when the host fingerprint and metric manifest match—the
Phase 22.7 repeated-sample policy: a timing regression must exceed both 15% and z=3. Use
`--record benchmarks/history/benchmark-history.json` only when intentionally accepting a new baseline.

## 2026-10-20 — Phase 22.1 baseline

**Source:** `arena/2ebfc0bb-forge-engine`, Phase 22.1 change based on `2e41efb`  
**UTC start:** 2026-10-20 07:05:15  
**Host:** Linux x64, Node v22.22.3, Intel Xeon Processor @ 2.60 GHz, 2 logical CPUs,
4,131,278,848 bytes RAM (Arena sandbox)  
**Runner:** snapshot schema 1; 2,458.04 ms inside the benchmark process; all guards passed  
**GPU:** none used — these are CPU and mock/fallback workloads

### Phase 22.1 core matrix

| Workload | Operations | Time | Throughput |
| --- | ---: | ---: | ---: |
| ECS entity creation + component attach | 100,000 | 297.98 ms | 335,597/s |
| ECS world-transform update | 100,000 | 21.71 ms | 4,606,582/s |
| ECS frustum culling + bounds query | 100,000 | 90.18 ms | 1,108,915/s |
| Vec3 cross + normalize (allocation-free) | 1,000,000 | 78.91 ms | 12,673,051/s |
| Mat4 multiply | 250,000 | 20.96 ms | 11,928,652/s |
| Inline scheduler unique dispatch | 8,192 | 52.94 ms | 154,744/s |
| Scheduler subscribers sharing one task | 4,096 | 1.23 ms | 3,331,007/s |
| ResourceRegistry unique load + acquire | 10,000 | 55.39 ms | 180,551/s |
| ResourceRegistry cached acquire + release | 10,000 | 13.21 ms | 757,115/s |
| ResourceRegistry handle release + LRU eviction | 10,000 | 17.10 ms | 584,761/s |

Correctness/accounting from the same run: 8,193 scheduler tasks completed with no failures (4,095
fan-out dedup hits); 10,000 resources loaded, hit, evicted and disposed; resource accounting peaked at
625 KiB and returned to zero entries/bytes; math checksums were finite and nonzero.

### Existing matrix, same process

These rows predate Phase 22 but ran after the core matrix in the same snapshot. They are retained so a
future comparator has an initial reference rather than a selectively reported result.

| Workload | Time / result |
| --- | ---: |
| 100k CPU particles × 30 integration steps | 157.85 ms; analytic error 1.05e-8 |
| 256-light dense CPU cluster fill | 52.52 ms; 98,304 entries |
| 8,192-batch CPU object cull (frustum + distance + HiZ lookup) | 4.29 ms |
| 1280×720 four-level CPU HiZ pyramid | 20.03 ms |
| UI build + layout (1,000 buttons) | 61.75 ms |
| UI steady update + render (300 frames) | 0.46 ms total; zero measures/style resolves/rebuilds |
| UI virtualized 100k-row scroll (600 frames) | 109.33 ms; 37 elements instantiated |
| UI text layout (800 misses / 800 warmed hits) | 26.73 ms / 0.77 ms |

### Interpretation

This historical entry is one run, not a confidence interval; it establishes the workload definitions
and a traceable starting measurement. The current Phase 22.7 runner uses schema-2 snapshots, stable
metric IDs, three raw samples, host-compatibility rules and a checked-in same-host comparator. This
older schema-1 entry remains human-readable provenance and is not itself a rejection baseline.

## 2026-10-23 — Phase 22.2 rendering baseline

**Source:** `arena/ef30a06e-forge-engine`, Phase 22.2 change based on `2993afdf`
**UTC start:** 2026-10-23 04:20:54
**Host:** Linux x64, Node v22.22.3, Intel Xeon Processor @ 2.60 GHz, 2 logical CPUs,
4,131,278,848 bytes RAM (Arena sandbox)
**Runner:** snapshot schema 1; 4,650.71 ms inside the benchmark process; all guards passed
**GPU:** mock WebGPU device for draw/graph/allocation rows; CPU twins for culling, lighting and shadow fits

### Phase 22.2 rendering matrix

| Workload | Operations | Time | Throughput |
| --- | ---: | ---: | ---: |
| Mock draw submission, 16 batches | 16 draw calls | 2.52 ms | 6,348/s |
| Mock draw submission, 64 batches | 64 draw calls | 3.16 ms | 20,264/s |
| Mock draw submission, 256 batches | 256 draw calls | 5.36 ms | 47,746/s |
| Render graph compile + submit, 10 declared passes | 10 passes | 30.32 ms | 330/s |
| Render graph compile + submit, 34 declared passes | 34 passes | 108.47 ms | 313/s |
| Render graph compile + submit, 66 declared passes | 66 passes | 208.68 ms | 316/s |
| Object culling, 8,192 batches (CPU twin) | 8,192 batches | 4.23 ms | 1,935,813/s |
| HiZ pyramid, 1280×720 / 4 levels (CPU twin) | 921,600 pixels | 19.12 ms | 48,198,477/s |
| Cluster fill, 256-light dense rig (CPU twin) | 98,304 list entries | 58.49 ms | 1,680,773/s |
| Shadow cascade fit ×4 | 1,024 cascade fits | 3.06 ms | 335,049/s |
| Spot shadow fit | 256 fits | 0.66 ms | 385,554/s |
| Point shadow fit ×6 faces | 1,536 face fits | 1.83 ms | 839,196/s |
| GPU allocation accounting | 2,048 texture/buffer allocations | 0.36 ms | 5,640,646/s |

Shape/correctness from the same run: the 66-pass graph executed 65 passes after culling one dead
pass, used 2 physical textures for 64 transient textures and aliased 57,139,200 bytes; the adaptive
10-layer shadow atlas reduced to 512 px and 10,485,760 bytes within the 16 MiB budget; and all 2,048
mock texture/buffer allocations returned to zero live resources and zero live bytes. The full raw
snapshot was written to `/tmp/forge-bench-22.2.json` during validation and is intentionally not
tracked in Git.

This is a mock/CPU baseline, not a real-device GPU timing claim. The browser gate remains the
real-WebGPU evidence for shader compilation and device execution; the current schema-2 runner compares
repeated timings only when the stored host and metric manifest are compatible.

## 2026-10-23 — Phase 22.3 terrain baseline

**Source:** `arena/5b6c310c-forge-engine`, Phase 22.3 change based on `5de4adccc231c8c411e59a8ca1865a7fbc2c8309`
**UTC start:** 2026-10-23 06:52:23
**Host:** Linux x64, Node v22.22.3, Intel Xeon Processor @ 2.60 GHz, 2 logical CPUs,
4,131,278,848 bytes RAM (Arena sandbox)
**Runner:** snapshot schema 1; 4,517.20 ms inside the benchmark process; all guards passed
**GPU:** none used; terrain rows are deterministic CPU generation/erosion/LOD/streaming/mesh work

### Phase 22.3 terrain matrix

| Workload | Operations | Time | Throughput |
| --- | ---: | ---: | ---: |
| Deterministic terrain generation, 33×33 | 1,089 grid samples | 5.67 ms | 192,155/s |
| Deterministic terrain generation, 65×65 | 4,225 grid samples | 4.28 ms | 987,761/s |
| Deterministic terrain generation, 129×129 | 16,641 grid samples | 16.40 ms | 1,014,657/s |
| Thermal erosion, 65×65 × 3 iterations | 12,675 cell-iterations | 6.80 ms | 1,863,786/s |
| Hydraulic erosion, 65×65 × 5 iterations | 21,125 cell-iterations | 28.28 ms | 747,094/s |
| LOD selection + resolution/geomorph | 896 visible-cell selections | 0.60 ms | 1,484,560/s |
| TerrainWorld cold streaming update | 12 generated chunks | 13.58 ms | 884/s |
| TerrainWorld resident streaming update | 4 steady frames | 0.12 ms | 34,267/s |
| TerrainWorld camera move + cache return | 24 generated/cache-return chunks | 10.68 ms | 2,248/s |
| Skirted mesh source, 17×17 | 357 vertices | 0.48 ms | 742,958/s |
| Skirted mesh source, 33×33 | 1,221 vertices | 1.22 ms | 997,981/s |
| Skirted mesh source, 65×65 | 4,485 vertices | 8.56 ms | 523,821/s |

Shape/correctness from the same run: all generation grids reproduced identical float digests; the
LOD selector covered levels 0/1/2/3/4 with 3/5/9/17/33 nested resolutions and 216 geomorph transition
samples; the streaming scenario stayed within a 12-chunk budget, generated 12 cold and 12 moved
chunks, and returned to the original view with 12 cache hits; and the 65×65 skirted mesh contained
4,485 vertices and 26,112 indices, matching the exact grid-plus-four-edge-skirts topology.

This is a CPU baseline, not a real-device GPU timing claim. The browser gate remains the evidence for
terrain shader compilation and device execution; the current schema-2 runner compares repeated timings
only when the stored host and metric manifest are compatible.

## 2026-10-23 — Phase 22.4 physics baseline

**Source:** `arena/5b6c310c-forge-engine`, Phase 22.4 change based on `5de4adccc231c8c411e59a8ca1865a7fbc2c8309`
**UTC start:** 2026-10-23 14:49:02.329
**Host:** Linux x64, Node v22.22.3, Intel Xeon Processor @ 2.60 GHz, 2 logical CPUs,
4,131,278,848 bytes RAM (Arena sandbox)
**Runner:** snapshot schema 1; 8,100.24 ms inside the benchmark process; all guards passed
**GPU:** none used; physics rows are deterministic CPU/API workloads

### Phase 22.4 physics matrix

| Workload | Operations | Time | Throughput |
| --- | ---: | ---: | ---: |
| Sweep-and-prune pair generation + pruning, 128 bodies | 128 bodies | 0.27 ms | 481,304/s |
| Sweep-and-prune pair generation + pruning, 512 bodies | 512 bodies | 0.47 ms | 1,094,270/s |
| Sweep-and-prune pair generation + pruning, 2,048 bodies | 2,048 bodies | 4.65 ms | 440,223/s |
| Narrowphase sphere-sphere manifolds | 512 pairs | 1.19 ms | 429,731/s |
| Narrowphase sphere-box manifolds | 512 pairs | 0.97 ms | 526,751/s |
| Narrowphase box-box manifolds | 512 pairs | 3.29 ms | 155,513/s |
| Narrowphase sphere-plane manifolds | 512 pairs | 0.61 ms | 844,233/s |
| Narrowphase box-plane manifolds | 512 pairs | 1.83 ms | 279,749/s |
| Narrowphase sphere-heightfield manifolds | 512 pairs | 0.91 ms | 561,256/s |
| Narrowphase box-heightfield manifolds | 512 pairs | 4.54 ms | 112,801/s |
| Sequential-impulse solver, 64 bodies / 256 contacts | 256 contacts | 4.45 ms | 57,508/s |
| Fixed-step resting-contact stability, 32 bodies × 90 steps | 2,880 body-steps | 39.57 ms | 72,781/s |
| Physics-world spatial raycasts, 256 colliders | 512 rays | 13.52 ms | 37,868/s |
| Registered heightfield queries, 256 colliders | 4,096 samples | 0.85 ms | 4,793,048/s |
| Vehicle simulation, 8 vehicles × 120 steps | 960 vehicle-steps | 30.41 ms | 31,568/s |
| Vehicle simulation, 32 vehicles × 120 steps | 3,840 vehicle-steps | 112.83 ms | 34,033/s |
| Vehicle simulation, 64 vehicles × 120 steps | 7,680 vehicle-steps | 222.79 ms | 34,471/s |

Shape/correctness from the same run: the largest broadphase workload generated 1,984 full AABB
pairs from 191,005 X-axis candidates out of 2,096,128 possible pairs; all seven supported
narrowphase shape pairs produced 8,192 deterministic contacts; the solver applied 181.124 total
normal impulse and the resting-contact pass held maximum penetration to 0.0118 m with maximum speed
0.050 m/s. All 512 raycasts hit a collider or the heightfield; 4,096 height samples ranged from
-0.644 to 0.618; and the largest deterministic fleet maintained 256 wheel contacts.

This is a CPU/API baseline, not a real-device physics timing claim. The benchmark guards establish
shape, finite-state, determinism and catastrophe bounds; the current schema-2 runner compares
repeated timings only when the stored host and metric manifest are compatible.

## 2026-10-23 — Phase 22.5 particle baseline

**Source:** `arena/5b6c310c-forge-engine`, Phase 22.5 change based on `5de4adccc231c8c411e59a8ca1865a7fbc2c8309`
**UTC start:** 2026-10-23 15:37:18.449
**Host:** Linux x64, Node v22.22.3, Intel Xeon Processor @ 2.60 GHz, 2 logical CPUs,
4,131,278,848 bytes RAM (Arena sandbox)
**Runner:** snapshot schema 1; 9,387.28 ms inside the benchmark process; all guards passed

### Phase 22.5 CPU matrix

| Workload | Operations | Time | Throughput |
| --- | ---: | ---: | ---: |
| Setup, 10K particles | 10,000 particles | 1.03 ms | 9,673,790/s |
| Fixed-step integration, 10K × 30 | 300,000 particle-steps | 14.99 ms | 20,020,012/s |
| Setup, 100K particles | 100,000 particles | 2.55 ms | 39,248,563/s |
| Fixed-step integration, 100K × 30 | 3,000,000 particle-steps | 89.04 ms | 33,691,238/s |
| Setup, 500K particles | 500,000 particles | 12.56 ms | 39,823,731/s |
| Fixed-step integration, 500K × 30 | 15,000,000 particle-steps | 482.60 ms | 31,081,725/s |
| Setup, 1M particles | 1,000,000 particles | 39.86 ms | 25,086,217/s |
| Fixed-step integration, 1M × 30 | 30,000,000 particle-steps | 906.93 ms | 33,078,770/s |

Every CPU band retained all particles, matched the semi-implicit analytic gravity reference within
`2.67e-7` at worst, and produced a deterministic state digest. The authoritative state is 64 bytes
per particle: 0.64 MB, 6.4 MB, 32 MB and 64 MB for the four bands.

### Phase 22.5 mock-GPU allocation and preparation matrix

| Workload | Storage bytes | Peak live bytes | Time |
| --- | ---: | ---: | ---: |
| Allocate, 10K particles | 640,000 | 1,320,768 | 4.62 ms |
| Prepare 3 frames, 10K | 640,000 | 1,320,768 | 0.63 ms |
| Allocate, 100K particles | 6,400,000 | 13,200,768 | 9.31 ms |
| Prepare 3 frames, 100K | 6,400,000 | 13,200,768 | 0.13 ms |
| Allocate, 500K particles | 32,000,000 | 66,000,768 | 69.45 ms |
| Prepare 3 frames, 500K | 32,000,000 | 66,000,768 | 0.29 ms |
| Allocate, 1M particles | 64,000,000 | 132,000,768 | 103.68 ms |
| Prepare 3 frames, 1M | 64,000,000 | 132,000,768 | 0.21 ms |

Each preparation row emitted deterministically with zero GPU simulation steps and zero ECS entities;
all rows had zero mock validation errors and returned live bytes to the device baseline after disposal.
These are strict mock-device allocation and
command/uniform-preparation measurements only: the mock does not execute WGSL, so they are not GPU
shader-throughput claims. Real browser/device timing remains the authoritative GPU gate. The current
schema-2 runner compares repeated rows only when the stored host and metric manifest are compatible.


## 2026-10-23 — Phase 22.6 world-scale object baseline

**Source:** `arena/fa9d54d2-forge-engine`, Phase 22.6 world benchmark change
**UTC start:** 2026-10-23 16:16:13.354
**Host:** Linux x64, Node v22.22.3, Intel Xeon Processor @ 2.60 GHz, 2 logical CPUs,
4,131,278,848 bytes RAM (Arena sandbox)
**Runner:** snapshot schema 1; 15,007.12 ms inside the benchmark process; all guards passed
**GPU:** none used; world rows are deterministic CPU/ECS workloads

### Phase 22.6 world-scale object matrix

| Workload | Operations | Time | Throughput |
| --- | ---: | ---: | ---: |
| Entity/component setup, 10K objects | 10,000 objects | 29.21 ms | 342,404/s |
| Flat transform composition, 10K objects | 10,000 transforms | 2.75 ms | 3,634,627/s |
| Frustum visibility query, 10K objects | 10,000 objects | 8.64 ms | 1,157,335/s |
| Entity/component setup, 100K objects | 100,000 objects | 139.79 ms | 715,342/s |
| Flat transform composition, 100K objects | 100,000 transforms | 14.80 ms | 6,758,435/s |
| Frustum visibility query, 100K objects | 100,000 objects | 61.32 ms | 1,630,705/s |
| Entity/component setup, 500K objects | 500,000 objects | 910.53 ms | 549,133/s |
| Flat transform composition, 500K objects | 500,000 transforms | 36.55 ms | 13,680,197/s |
| Frustum visibility query, 500K objects | 500,000 objects | 247.87 ms | 2,017,202/s |
| Entity/component setup, 1M objects | 1,000,000 objects | 2,063.53 ms | 484,606/s |
| Flat transform composition, 1M objects | 1,000,000 transforms | 233.33 ms | 4,285,737/s |
| Frustum visibility query, 1M objects | 1,000,000 objects | 518.10 ms | 1,930,141/s |

Shape/correctness from the same run: every band attached exactly one `Transform` and one
`Renderable` per object, updated all transform slots, and queried all objects. The 1M view contained
279,292 visible and 720,708 culled objects; every band had both visible and culled results and a
repeatable state digest. Typed transform storage measured 2,228,224 / 17,825,792 / 71,303,168 /
142,606,336 bytes at 10K/100K/500K/1M, respectively; disposal returned every band to zero live ECS
objects and components.

This is a CPU/ECS baseline, not a GPU-driven rendering throughput claim. GPU instance generation and
complete visibility compaction remain Phase 24 work; the current schema-2 runner compares repeated
rows only when the stored host and metric manifest are compatible.

## 2026-10-23 — Phase 22.7 regression baseline and policy

**Source:** `arena/fa9d54d2-forge-engine`, Phase 22.7 change
**UTC start:** 2026-10-23 18:34:40.232Z
**Host:** Linux x64, Node v22.22.3, Intel Xeon Processor @ 2.60 GHz, 2 logical CPUs,
4,131,278,848 bytes RAM (Arena sandbox)
**Runner:** snapshot schema 2; three independent samples, 99 stable metrics, 37,650.83 ms total; all
correctness and shape guards passed
**Raw history:** `benchmarks/history/benchmark-history.json` (one retained three-sample baseline)

The runner assigns deterministic `forge.benchmark.*` IDs from each workload name, stores all three raw
sample rows and median aggregate rows, and compares only a matching platform, architecture, CPU model,
logical CPU count, memory size and Node major version. A comparable run fails only when a timing row is
at least 15% slower than the stored median and its z-score is at least 3; missing history or an unlike
host is reported as `SKIPPED`, while metric-manifest or operation-count drift is `INCOMPATIBLE` and
requires an explicit `--record` update. A same-host three-sample validation began at
`2026-10-23T18:35:22.935Z` and passed all 99 comparisons with no regressions.
