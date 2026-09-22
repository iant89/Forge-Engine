/**
 * GPU compute path for the particle integrator.
 *
 * The shader is {@link PARTICLE_SIM_SHADER}. It does not invent a second model: the same
 * semi-implicit step as {@link integrateParticle}. The mock device records the dispatch and
 * increments `computeTouchCount` but does not execute WGSL, so a unit test can prove the pipeline
 * is valid and a browser test (`check:browser`) is what proves the buffer matches the analytic
 * curve. `runParticleGravityCheck` reports which of those two it actually observed.
 */

import { BufferUsage, ShaderStage, gpuSource } from "../gpu/constants.js";
import {
  FLAG_ALIVE,
  P_FLAGS,
  P_LIFE,
  P_MAX_LIFE,
  P_VY,
  P_Y,
  PARTICLE_FLOATS,
  analyticGravity,
  integrateParticle,
} from "./layout.js";
import { PARTICLE_SIM_SHADER, PARTICLE_WORKGROUP } from "./shader.js";

export interface ParticleGravityCheck {
  steps: number;
  dt: number;
  gravityY: number;
  /** Analytic semi-implicit position. */
  analyticY: number;
  analyticVy: number;
  /** CPU integrator, which must match the analytic form. */
  cpuY: number;
  cpuVy: number;
  /** Value read back from the storage buffer. Equals the upload on a mock device. */
  gpuY: number;
  gpuVy: number;
  cpuError: number;
  gpuError: number;
  /**
   * False when the readback is still the uploaded state. The mock device does not run WGSL;
   * a real device that returns this has a shader that did not execute.
   */
  gpuExecuted: boolean;
  dispatches: number;
  /** Mock-only. 0 on a real device. */
  computeTouchCount: number;
}

export interface ParticleGravityCheckOptions {
  steps?: number;
  dt?: number;
  /** Particle count. Rounded up to a workgroup so the dispatch is dense. */
  count?: number;
  gravityY?: number;
  y0?: number;
}

const PARAM_BYTES = 32;

/**
 * Upload a rest state, dispatch the compute integrator `steps` times, read the buffer back and
 * compare it to the closed form. Destroys every buffer it creates.
 */
export async function runParticleGravityCheck(device: GPUDevice, options: ParticleGravityCheckOptions = {}): Promise<ParticleGravityCheck> {
  const steps = options.steps ?? 60;
  const dt = options.dt ?? 1 / 60;
  const gravityY = options.gravityY ?? -9.81;
  const y0 = options.y0 ?? 4;
  const count = Math.max(PARTICLE_WORKGROUP, options.count ?? PARTICLE_WORKGROUP);
  const storageBytes = count * PARTICLE_FLOATS * 4;

  const initial = new Float32Array(count * PARTICLE_FLOATS);
  for (let i = 0; i < count; i++) {
    const o = i * PARTICLE_FLOATS;
    initial[o + P_Y] = y0;
    initial[o + P_LIFE] = steps * dt + 1;
    initial[o + P_MAX_LIFE] = steps * dt + 1;
    initial[o + P_FLAGS] = FLAG_ALIVE;
  }
  const cpu = new Float32Array(initial);
  const gravity = { x: 0, y: gravityY, z: 0 };
  for (let s = 0; s < steps; s++) integrateParticle(cpu, 0, dt, gravity, 0);
  const analytic = analyticGravity(y0, gravityY, steps, dt);

  const params = new ArrayBuffer(PARAM_BYTES);
  const pf = new Float32Array(params);
  const pu = new Uint32Array(params);
  pf[0] = dt;
  pf[1] = 0;
  pf[2] = gravityY;
  pf[3] = 0;
  pf[4] = 0;
  pu[5] = count;

  const uniform = device.createBuffer({
    label: "particles.params",
    size: PARAM_BYTES,
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  const storage = device.createBuffer({
    label: "particles.state",
    size: storageBytes,
    usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    label: "particles.readback",
    size: storageBytes,
    usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
  });

  let dispatches = 0;
  try {
    const module = device.createShaderModule({ label: "particles.sim", code: PARTICLE_SIM_SHADER });
    const compilable = module as unknown as { getCompilationInfo?: () => Promise<{ messages: { type: string; message: string }[] }> };
    if (typeof compilable.getCompilationInfo === "function") {
      const info = await compilable.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === "error");
      if (errors.length > 0) {
        throw new Error(`particle compute shader failed to compile: ${errors.map((m) => m.message).join("; ")}`);
      }
    }
    const bindLayout = device.createBindGroupLayout({
      label: "particles.sim",
      entries: [
        { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ label: "particles.sim", bindGroupLayouts: [bindLayout] });
    const pipeline = device.createComputePipeline({
      label: "particles.sim",
      layout: pipelineLayout,
      compute: { module, entryPoint: "csMain" },
    });
    const group = device.createBindGroup({
      label: "particles.sim",
      layout: bindLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: storage } },
      ],
    });

    device.queue.writeBuffer(uniform, 0, gpuSource(new Uint8Array(params)));
    device.queue.writeBuffer(storage, 0, gpuSource(initial));

    const encoder = device.createCommandEncoder({ label: "particles.gravity-check" });
    const pass = encoder.beginComputePass({ label: "particles.integrate" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    const groups = Math.ceil(count / PARTICLE_WORKGROUP);
    for (let s = 0; s < steps; s++) {
      pass.dispatchWorkgroups(groups);
      dispatches++;
    }
    pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, storageBytes);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await readback.mapAsync(BufferUsage.MAP_READ);
    const mapped = readback.getMappedRange();
    const gpu = new Float32Array(mapped.slice(0));
    readback.unmap();

    const gpuY = gpu[P_Y] ?? y0;
    const gpuVy = gpu[P_VY] ?? 0;
    const cpuY = cpu[P_Y] ?? y0;
    const cpuVy = cpu[P_VY] ?? 0;
    const moved = Math.abs(gpuY - y0) + Math.abs(gpuVy);
    const touch = (storage as unknown as { computeTouchCount?: number }).computeTouchCount ?? 0;
    return {
      steps,
      dt,
      gravityY,
      analyticY: analytic.y,
      analyticVy: analytic.vy,
      cpuY,
      cpuVy,
      gpuY,
      gpuVy,
      cpuError: Math.max(Math.abs(cpuY - analytic.y), Math.abs(cpuVy - analytic.vy)),
      gpuError: Math.max(Math.abs(gpuY - analytic.y), Math.abs(gpuVy - analytic.vy)),
      gpuExecuted: moved > 1e-4,
      dispatches,
      computeTouchCount: touch,
    };
  } finally {
    uniform.destroy();
    storage.destroy();
    if ((readback as unknown as { mapState?: string }).mapState === "mapped") {
      try {
        readback.unmap();
      } catch {
        /* already unmapped */
      }
    }
    readback.destroy();
  }
}
