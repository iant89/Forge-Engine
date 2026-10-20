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
