# Realistic Terrain Generation

This document describes the realistic terrain generator added in `engine/src/terrain/realistic.ts`.

## Overview

The original Forge terrain generator produced Martian-style landscapes: rolling fBm with ridged mountains and impact craters. While deterministic and performant, it lacked the organic, eroded, hydrologically-carved appearance of Earth-like terrain seen in reference imagery (alpine mountains, river valleys, rolling hills).

The realistic generator implements a full geomorphological pipeline:

```
RealisticHeight -> Thermal Erosion -> Hydraulic Erosion -> Valley Carving -> Detail Noise -> Climate Biome -> Scatter
```

All stages are pure, deterministic, seedable, and seamless across chunk boundaries.

## Stages

### 1. RealisticHeightGenerator

Combines multiple noise fields with domain warping:

- **Continental base** (1/2048 freq, 280m amp): large-scale fBm biased to lowlands via power curve `pow(continent, 2.2)`. Creates plains vs highlands.
- **Mountain mask** (1/650 freq): ridged noise thresholded with `smoothstep(0.35, 0.75)` to decide where mountain ranges appear. Modulated by continental noise to form chains.
- **Mountain ridges** (1/320 freq, 850m amp): ridged multifractal sharpened with `pow(mountain, 1.6)` for alpine spires. Secondary ridge at 1.7x frequency for cross-cutting ranges.
- **Hills** (1/180 freq, 85m amp): rolling mid-frequency, stronger in highlands.
- **Detail** (1/32 freq, 12m amp): high-frequency rocky roughness, 3 octaves.
- **Swell** (0.35x continental freq, 45m amp): tectonic undulation.
- **Plateau** (optional): terrace formation via quantization.

**Domain warping**: coordinates are warped by 180m using low-frequency fBm before sampling. This breaks axis-alignment and makes mountain chains flow organically, mimicking tectonic deformation.

```ts
const wx = warpField.fbm(x * warpFreq, z * warpFreq) * warpAmount;
const wz = warpField.fbm(x * warpFreq + 100, z * warpFreq + 100) * warpAmount;
const sampleX = worldX + wx;
const sampleZ = worldZ + wz;
```

### 2. ThermalErosionGenerator (Thermal Weathering)

Simulates talus / scree stabilization:

- For each cell, find lowest of 8 neighbors.
- If slope exceeds `tan(talusAngle) * distance`, move excess material downhill.
- Material is conserved via delta buffer (depositionRate 0.9).
- Iterations: 3 default, talusAngle 0.65 rad (~37°, realistic scree angle).

This creates natural angle-of-repose slopes and scree piles at mountain bases.

### 3. HydraulicErosionGenerator

Simulates rainfall, water flow, sediment transport:

- **Water buffer**: initialized with rainfall (0.012) + deterministic random variation.
- **Flow direction**: steepest descent among 8 neighbors, considering water height.
- **Sediment capacity**: `slope * water * capacity * 8`. Water can carry sediment proportional to slope and volume.
- **Erosion**: if sediment < capacity, pick up material: `min((capacity - sediment) * solubility, heightDiff * 0.5)`.
- **Deposition**: if sediment > capacity, deposit excess: `(sediment - capacity) * depositionRate`.
- **Transport**: water and sediment moved downstream proportional to flow.
- **Rainfall & evaporation**: each iteration adds rainfall and evaporates `evaporation` (0.02).

Iterations: 10-14 default. Creates dendritic drainage patterns and smooths terrain realistically.

### 4. ValleyCarvingGenerator (Fluvial / River Valleys)

Carves V-shaped valleys based on flow accumulation:

1. Compute flow direction (steepest descent).
2. Compute accumulation by processing cells high-to-low: each cell drains into its outflow, accumulating count.
3. Where accumulation > minAccumulation (8), carve depth: `sqrt(normalizedAcc) * carveDepth * 12 * (1 + log10(1+acc)*0.5)` — realistic scaling where large rivers carve deeper.
4. Widen valley: for each river cell, carve neighbors within `valleyWidth + sqrt(acc)*0.15` with falloff `pow(1 - dist/width, 0.85)`.
5. Preserve river bed gradient: don't carve below `height[downstream] + riverBedSlope`.

This produces realistic river networks with tributaries.

### 5. DetailNoiseGenerator

Re-injects high-frequency detail after erosion (which tends to smooth terrain):

- Precompute slopes.
- Skip flat areas (slope < minSlope 0.05) to preserve river beds and plains.
- Add 3-octave fBm detail (1/20 freq, 3.0 amp) modulated by slope (more detail on steep slopes for rocky outcrops).

### 6. ClimateBiomeGenerator

Climate model + realistic splat mapping:

**Temperature**:
```
temp = 25 - height * lapseRate*100 + cos(latitude)*5 + noise*8
lapseRate = 0.006°C/m (realistic)
```

**Moisture**:
```
moisture = fBm(moistureFreq) * 0.5+0.5 + (1 - height/600)*0.3 + (1 - slope/0.8)*0.2
```

**Splat weights** (4 channels):
- **R (grass)**: low slope, mid height, high moisture. `grassSlope * grassHeight * grassMoisture`.
- **G (rock)**: steep slopes, high elevation. `cliffFactor + smoothstep(400,700,height)`.
- **B (sand/scree)**: low elevation beach + mid-slope scree. `smoothstep(sea+15, sea-5, height) + smoothstep(0.25,0.6,slope)*0.5`.
- **A (snow)**: high elevation + low temp, reduced on very steep slopes (avalanche). `max(snowHeight, snowTemp) * avalancheFactor`.

Weights normalized to sum 1.0.

### 7. RealisticScatterGenerator

Vegetation and rocks based on biome:

- Only scatter where slope < maxSlope (0.6) and height in range.
- Skip snow > 0.5.
- Require grass > 0.25 or rock > 0.4.
- Type based on biome: rocky terrain = mostly rocks (type 2), grassy = trees/bushes (type 0).

## Pipeline Factory

```ts
import { createRealisticTerrainPipeline, createRealisticPipelinePreset } from "@forge/engine";

// Custom
const pipeline = createRealisticTerrainPipeline({
  seaLevel: 0,
  continentalAmplitude: 280,
  mountainAmplitude: 850,
  hillAmplitude: 85,
  detailAmplitude: 12,
  warpAmount: 180,
  snowLine: 420,
  thermalIterations: 3,
  hydraulicIterations: 10,
  scatterCount: 16,
  enableRivers: true,
  enableDetail: true,
});

// Presets
const alpine = createRealisticPipelinePreset("alpine", seed);
const rolling = createRealisticPipelinePreset("rolling-hills", seed);
const mountainous = createRealisticPipelinePreset("mountainous", seed);
const canyon = createRealisticPipelinePreset("canyon", seed);
const archipelago = createRealisticPipelinePreset("archipelago", seed);
```

### Preset Parameters

| Preset | Continental | Mountain | Hill | Warp | Snow | Thermal | Hydraulic |
|--------|-------------|----------|------|------|------|---------|-----------|
| alpine | 220 | 950 | 70 | 200 | 380 | 4 | 14 |
| rolling-hills | 180 | 250 | 120 | 120 | 650 | 2 | 8 |
| mountainous | 320 | 1200 | 90 | 250 | 450 | 3 | 12 |
| canyon | 350 | 600 | 60 | 150 | 800 | 5 | 18 |
| archipelago | 120 | 400 | 80 | 160 | 500 | 2 | 10 |

## Usage with TerrainWorld

```ts
import { TerrainWorld, createRealisticPipelinePreset, Material, Color } from "@forge/engine";

const pipeline = createRealisticPipelinePreset("alpine", 1337);
const terrain = new TerrainWorld({
  seed: 1337,
  chunkSize: 128,
  chunkResolution: 33,
  viewDistance: 1024,
  maxChunksLoaded: 220,
  pipeline,
  material: new Material({
    color: Color.fromSrgbHex(0x5a7a3a),
    roughness: 0.92,
    metallic: 0.02,
  }),
});
scene.add(terrain);
```

## Performance

- 33x33 chunk: ~2-5ms total on desktop (height 0.5ms, thermal 0.3ms, hydraulic 1-2ms, valley 0.5ms, biome 0.5ms)
- Deterministic and worker-safe: same `(seed, cx, cz)` produces bit-identical results regardless of execution order.
- Seamless: all height sampling uses world coordinates, so chunk edges match within 1e-4.

## Visual Reference

The generator targets terrain similar to alpine reference imagery:

- Mountain ranges with sharp peaks and flowing, non-axis-aligned chains (domain warping)
- Valleys carved by rivers, with tributary networks (flow accumulation)
- Scree slopes and talus at angle of repose (thermal erosion)
- Varied biomes: grassy lowlands, rocky cliffs, sandy beaches/scree, snowy peaks (climate model)
- Surface roughness preserved on slopes, smooth valley floors (detail noise masking)

## Future Work

- GPU-accelerated hydraulic erosion (compute shader)
- Splat texture blending in shader (currently single material color)
- Vegetation instancing based on scatter
- Water plane for rivers/lakes (seaLevel handling)
- Wind erosion and snow accumulation simulation
