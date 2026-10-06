/**
 * Browser-only evidence for Mars workers, shared by the full WebGPU gate and its focused mode.
 * Observe real native Worker messages before the app boots: a pool existing, a scheduler reporting
 * "not inline", or a scene labelling itself "workers" is not proof that a Mars job ran there.
 * The probe never substitutes a result or generates a tile; numerical parity with the ORIGINAL
 * live pipeline (including custom planets/sites) is separately pinned on real Node worker threads.
 */

export async function installMarsWorkerProbe(page) {
  await page.addInitScript(() => {
    const probe = { nativeWorkers: 0, submitted: 0, completed: 0, cancelled: 0, invalid: [], errors: [], sample: null };
    window.__forgeMarsWorkerProbe = probe;
    const NativeWorker = window.Worker;
    if (!NativeWorker) return;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        probe.nativeWorkers++;
        this.marsJobs = new Map();
        this.addEventListener("message", ({ data }) => {
          const job = this.marsJobs.get(data?.id);
          if (!job) return;
          if (data.type === "error") {
            probe.errors.push({ error: data.error, inlineFallback: data.inlineFallback === true });
            this.marsJobs.delete(data.id);
          } else if (data.type === "result") {
            const result = data.value;
            const n = job.resolution * job.resolution;
            const valid = result && result.cx === job.cx && result.cz === job.cz && result.seed === job.seed &&
              result.size === job.size && result.resolution === job.resolution &&
              result.heights instanceof Float32Array && result.heights.length === n &&
              result.slopes instanceof Float32Array && result.slopes.length === n &&
              result.biomes instanceof Float32Array && result.biomes.length === n * 4 &&
              result.heights.every(Number.isFinite) && result.slopes.every(Number.isFinite) &&
              result.biomes.every(Number.isFinite) && result.bytes === n * 24 &&
              Number.isFinite(result.minHeight) && Number.isFinite(result.maxHeight) &&
              result.minHeight <= result.maxHeight && result.pipelineHash === job.pipelineHash;
            if (!valid) probe.invalid.push({ id: data.id, cx: job.cx, cz: job.cz });
            probe.completed++;
            probe.sample ??= { cx: job.cx, cz: job.cz, resolution: job.resolution,
              bytes: result?.bytes, pipelineHash: result?.pipelineHash };
            this.marsJobs.delete(data.id);
          }
        });
      }

      postMessage(message, ...rest) {
        if (message?.type === "task" && message.name === "terrain.cell" &&
          message.payload?.pipeline?.stages?.some((s) => s.kind === "mars")) {
          // Pin the identity crossing the boundary as well as the result's array shapes. FNV-1a is
          // the pipeline-spec cache hash; this does not re-run terrain generation on the main thread.
          let hash = 0x811c9dc5;
          const text = JSON.stringify(message.payload.pipeline);
          for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
          this.marsJobs.set(message.id, { ...message.payload, pipelineHash: hash >>> 0 });
          probe.submitted++;
        } else if (message?.type === "cancel" && this.marsJobs.delete(message.id)) {
          probe.cancelled++;
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
}

/** Assert a successful native-worker round trip AND terrain uploaded into the actual showcase. */
export async function verifyMarsWorkers(page) {
  await page.waitForFunction(() => {
    const probe = window.__forgeMarsWorkerProbe;
    const state = window.__forge?.marsState?.();
    const stats = window.__forge?.stats?.();
    return probe?.errors.length || probe?.invalid.length || stats?.gpuErrors || state?.modelError ||
      (probe?.completed > 0 && state?.modelLoaded && state.terrainRoverChunkReady && state.terrainReadyChunks >= 9);
  }, null, { timeout: 60000 });
  const result = await page.evaluate(() => ({
    probe: window.__forgeMarsWorkerProbe,
    state: window.__forge.marsState(),
    stats: window.__forge.stats(),
  }));
  const { probe, state, stats } = result;
  if (!probe || probe.nativeWorkers < 1 || page.workers().length < 1 || probe.submitted < 1 || probe.completed < 1 ||
      probe.errors.length || probe.invalid.length) {
    throw new Error(`Mars worker round trip failed: ${JSON.stringify(probe)}`);
  }
  if (!state.modelLoaded || state.modelError || state.terrainGenerator !== "mars" || state.terrainHasErosion ||
      state.terrainGeneration !== "workers" || !state.terrainRoverChunkReady || state.terrainReadyChunks < 9 ||
      !(state.terrainResidentBytes > 0) || state.contactWheels < 4) {
    throw new Error(`Mars worker results did not produce resident terrain and rover contact: ${JSON.stringify(state)}`);
  }
  if (stats.gpuErrors !== 0 || stats.lastError || stats.tasks.inline || stats.tasks.workers < 1) {
    throw new Error(`Mars worker showcase failed: ${JSON.stringify({ gpuErrors: stats.gpuErrors, lastError: stats.lastError, tasks: stats.tasks })}`);
  }
  const clearance = state.y - state.terrainGroundHeight;
  if (!Number.isFinite(clearance) || clearance < 0.2 || clearance > 1.2) {
    throw new Error(`Mars worker terrain does not match rover clearance: ${clearance}`);
  }
  console.log(`mars workers: ${probe.nativeWorkers} native workers, ${probe.completed}/${probe.submitted} Mars jobs returned, ` +
    `${probe.errors.length} fallback/errors, ${state.terrainReadyChunks} ready tiles; ` +
    `contacts=${state.contactWheels}, clearance=${clearance.toFixed(3)}m; sample=${JSON.stringify(probe.sample)}`);
  return result;
}
