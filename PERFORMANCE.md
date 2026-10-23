# Forge Engine performance history

This is the audited human-readable history for Roadmap Phase 22. Raw snapshots come from:

```sh
npm run build
npm run bench -- --json /tmp/forge-bench.json
```

The JSON file is schema-versioned and records every result, every shape/correctness check, total run
time, and the Node/OS/CPU/memory identity. Do not compare timings from unlike hosts as if they were a
regression. `npm run bench` currently enforces algorithmic shape, correctness, and deliberately broad
catastrophe bounds; automatic comparison against comparable repeated history is still Phase 22.7 work.

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

This is one run, not a confidence interval. It establishes the workload definitions and a traceable
starting measurement. Phase 22.7 still needs stable metric IDs, repeated samples with variance, stored
raw history, host-compatibility rules, and an automatic comparison policy. Until those land, use this
table to investigate large changes, not to reject a change over a few percentage points.

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
real-WebGPU evidence for shader compilation and device execution; same-host statistical comparison
and automatic rejection remain Phase 22.7 work.
