/**
 * Raw-WebGPU primitive probes, for a device we cannot attach a debugger to.
 *
 * The engine renders correctly everywhere we can run it locally, so "the phone draws background
 * only" has to be attributed to a WebGPU primitive rather than to a scene. Each test below isolates
 * one primitive the renderer depends on and paints a known colour that a readback can check:
 *
 * | test             | primitive under test                                                        |
 * |------------------|-----------------------------------------------------------------------------|
 * | basic            | rasterisation of one triangle into one colour target                          |
 * | depth-write      | writable depth attachment: later geometry must fail the depth test            |
 * | depth-readonly   | `depthReadOnly: true` must *load* the previous pass's depth (the sky pass)    |
 * | depth-load       | control for the above with an explicit `depthLoadOp: "load"`                  |
 * | dynamic-offsets  | uniform buffer with dynamic offsets, three slices, three draws                |
 * | uniform-mat4     | a `mat4x4<f32>` uniform actually moving vertices                              |
 * | instanced        | per-instance vertex attributes, two instances                                 |
 * | array-layer      | render into `arrayLayerCount: 2` layer 1, then sample that layer              |
 * | hdr-tonemap      | `rgba16float` render target, then a second pass sampling it                   |
 * | srgb-sample      | `rgba8unorm-srgb` sampling must decode to linear                              |
 *
 * Every result carries the expected colour and what was measured, so a failure names the primitive
 * instead of requiring a hypothesis. The whole suite runs against a device the caller supplies: the
 * engine's own device, and (when asked) a freshly requested one, since a device can be in a state
 * that a fresh one is not.
 */

export interface RawTestResult {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
  error?: string;
}

const W = 32;
const H = 32;

/** Per-probe ceiling. Generous: this is a hang guard for phones, not a performance assertion. */
const PROBE_TIMEOUT_MS = 15000;

/** Readback rows must be 256-byte aligned; 32 px × 4 B = 128, so one std of padding covers it. */
const ROW_BYTES = 256;

const VS_AND_FS = /* wgsl */ `
struct Uni {
  mvp: mat4x4<f32>,
  color: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uni;

@vertex
fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.mvp * vec4<f32>(p, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return u.color;
}
`;

const VS_INSTANCED = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) offset: vec2<f32>, @location(2) color: vec3<f32>) -> VSOut {
  var o: VSOut;
  o.pos = vec4<f32>(p.xy + offset, p.z, 1.0);
  o.color = color;
  return o;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 1.0);
}
`;

const VS_AND_FS_STORAGE_WINDOW = /* wgsl */ `
struct Inst {
  offset: vec2<f32>,
  _pad: vec2<f32>,
  color: vec4<f32>,
};
// One window of records, relocated per draw by a dynamic offset — the renderer's instance arena.
@group(0) @binding(0) var<storage, read> records: array<Inst>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs(@location(0) p: vec3<f32>, @builtin(instance_index) ii: u32) -> VSOut {
  let rec = records[ii];
  var o: VSOut;
  o.pos = vec4<f32>(p.x / 3.0 + rec.offset.x, p.y, p.z, 1.0);
  o.color = rec.color;
  return o;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

const FS_SAMPLE = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@location(0) p: vec3<f32>) -> VSOut {
  var o: VSOut;
  o.pos = vec4<f32>(p, 1.0);
  return o;
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return textureSample(tex, samp, vec2<f32>(0.5, 0.5));
}
`;

const FS_SAMPLE_ARRAY = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d_array<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@location(0) p: vec3<f32>) -> VSOut {
  var o: VSOut;
  o.pos = vec4<f32>(p, 1.0);
  return o;
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return textureSample(tex, samp, vec2<f32>(0.5, 0.5), 1);
}
`;

/** Full-viewport triangle in NDC. `z` picks the depth the triangle lands at. */
const QUAD = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);
/** Left half only (the instanced probe's left instance). */
const LEFT = new Float32Array([-1, -1, 0, 0.5, -1, 0, -1, 1.5, 0]);
/**
 * Full-height rectangles, sampled at l/c/r. Rectangles (two triangles, drawn with `draw(6)`) rather
 * than single triangles: the sample points are pixel centres at NDC x = -0.5, 0, 0.5, and a single
 * third-of-the-screen triangle is *slanted* — its hypotenuse misses x = -0.5 at y = 0, which reads
 * as "the draw did nothing" when the draw was fine.
 */
function band(x0: number, x1: number): Float32Array<ArrayBuffer> {
  return new Float32Array([x0, -1, 0, x1, -1, 0, x0, 1, 0, x1, -1, 0, x1, 1, 0, x0, 1, 0]);
}
const BAND_L = band(-1, -1 / 3);
const BAND_M = band(-1 / 3, 1 / 3);
const BAND_R = band(1 / 3, 1);

function withZ(tri: Float32Array<ArrayBuffer>, z: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(tri.length);
  for (let i = 0; i < tri.length; i += 3) {
    out[i] = tri[i]!;
    out[i + 1] = tri[i + 1]!;
    out[i + 2] = z;
  }
  return out;
}

interface Target {
  texture: GPUTexture;
  view: GPUTextureView;
}

function makeTarget(device: GPUDevice, format: GPUTextureFormat = "rgba8unorm"): Target {
  const texture = device.createTexture({
    label: `diag.${format}`,
    size: [W, H],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  });
  return { texture, view: texture.createView() };
}

function makeDepth(device: GPUDevice, format: GPUTextureFormat = "depth24plus"): Target {
  const texture = device.createTexture({
    label: "diag.depth",
    size: [W, H],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return { texture, view: texture.createView() };
}

/** Colour uniform buffer: mat4 (64 B) + colour (16 B) = 80 B, padded to 256 so it can also be sliced. */
function uniformBytes(matrix: readonly number[], color: readonly [number, number, number, number], slice = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(256 * 3);
  const f = new Float32Array(buffer);
  const base = (slice * 256) / 4;
  f.set(matrix, base);
  f.set(color, base + 16);
  return buffer;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

async function readback(device: GPUDevice, target: Target): Promise<Uint8Array> {
  const buffer = device.createBuffer({ label: "diag.read", size: ROW_BYTES * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: "diag.copy" });
  encoder.copyTextureToBuffer({ texture: target.texture }, { buffer, bytesPerRow: ROW_BYTES, rowsPerImage: H }, [W, H, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const view = new Uint8Array(buffer.getMappedRange().slice(0, ROW_BYTES * H));
  buffer.unmap();
  buffer.destroy();
  return view;
}

function pixel(data: Uint8Array, x: number, y: number): [number, number, number] {
  const i = y * ROW_BYTES + x * 4;
  return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
}

/** Where a test landed, as text: quarter points plus the centre, rounded to reduce noise. */
function sample(data: Uint8Array): string {
  const points: [string, number, number][] = [
    ["l", 8, 16],
    ["c", 16, 16],
    ["r", 24, 16],
    ["t", 16, 8],
    ["b", 16, 24],
  ];
  return points.map(([label, x, y]) => `${label}=${pixel(data, x, y).join(",")}`).join(" ");
}

function near(actual: [number, number, number], want: [number, number, number], tolerance = 24): boolean {
  return actual.every((v, i) => Math.abs(v - want[i]!) <= tolerance);
}

/** Convert `l=…` sample text back into numbers for assertions on named points. */
function point(data: Uint8Array, which: "l" | "c" | "r" | "t" | "b"): [number, number, number] {
  const table = { l: [8, 16], c: [16, 16], r: [24, 16], t: [16, 8], b: [16, 24] } as const;
  const [x, y] = table[which];
  return pixel(data, x, y);
}

const RED: [number, number, number, number] = [1, 0, 0, 1];
const GREEN: [number, number, number, number] = [0, 1, 0, 1];
const BLUE: [number, number, number, number] = [0, 0, 1, 1];

function colorPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  options: {
    depthFormat?: GPUTextureFormat;
    depthWrite?: boolean;
    depthCompare?: GPUCompareFunction;
    /** Declare a dynamic offset on the colour uniform: an "auto" layout never has one. */
    dynamicUniform?: boolean;
  } = {},
): GPURenderPipeline {
  const module = device.createShaderModule({ label: "diag.color", code: VS_AND_FS });
  const layout: GPUPipelineLayout | "auto" = options.dynamicUniform
    ? device.createPipelineLayout({
        label: "diag.dynamic",
        bindGroupLayouts: [
          device.createBindGroupLayout({
            label: "diag.dynamic",
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 80 },
              },
            ],
          }),
        ],
      })
    : "auto";
  return device.createRenderPipeline({
    label: "diag.color",
    layout,
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
    },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
    ...(options.depthFormat
      ? {
          depthStencil: {
            format: options.depthFormat,
            depthWriteEnabled: options.depthWrite ?? true,
            depthCompare: options.depthCompare ?? "less-equal",
          },
        }
      : {}),
  });
}

function bufferOf(device: GPUDevice, data: ArrayBuffer, label: string): GPUBuffer {
  const buffer = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function vertexBufferOf(device: GPUDevice, data: Float32Array<ArrayBuffer>, label: string): GPUBuffer {
  const buffer = device.createBuffer({ label, size: Math.ceil(data.byteLength / 4) * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function draw(
  pass: GPURenderPassEncoder,
  pipeline: GPURenderPipeline,
  buffer: GPUBuffer,
  bind: GPUBindGroup,
  count: number,
  instanceCount = 1,
): void {
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.setVertexBuffer(0, buffer);
  pass.draw(count, instanceCount);
}

interface Case {
  name: string;
  expected: string;
  run: (device: GPUDevice) => Promise<{ actual: string; ok: boolean }>;
}

function cases(): Case[] {
  return [
    {
      name: "basic",
      expected: "c=red",
      async run(device) {
        const target = makeTarget(device);
        const pipeline = colorPipeline(device, "rgba8unorm");
        const ub = bufferOf(device, uniformBytes(IDENTITY, RED), "diag.ub");
        const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }] });
        const vb = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb");
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        draw(pass, pipeline, vb, bg, 3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const data = await readback(device, target);
        const c = point(data, "c");
        return { actual: sample(data), ok: near(c, [255, 0, 0]) };
      },
    },
    {
      name: "depth-write",
      expected: "c=green (blue fails the depth test)",
      async run(device) {
        const target = makeTarget(device);
        const depth = makeDepth(device);
        const pipeline = colorPipeline(device, "rgba8unorm", { depthFormat: "depth24plus" });
        const vb = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb");
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          depthStencilAttachment: { view: depth.view, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
        });
        const green = bufferOf(device, uniformBytes(IDENTITY, GREEN), "diag.ub.green");
        const greenBg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: green } }] });
        draw(pass, pipeline, vb, greenBg, 3);
        // Same pixels, farther away: must be rejected by the depth test.
        const blue = bufferOf(device, uniformBytes(IDENTITY, BLUE), "diag.ub.blue");
        const blueBg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: blue } }] });
        const far = vertexBufferOf(device, withZ(QUAD, 0.9), "diag.vb.far");
        draw(pass, pipeline, far, blueBg, 3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const data = await readback(device, target);
        const c = point(data, "c");
        return { actual: sample(data), ok: near(c, [0, 255, 0]) };
      },
    },
    {
      name: "depth-readonly",
      expected: "c=green — the sky pass's `depthReadOnly: true` attachment must load depth",
      async run(device) {
        const target = makeTarget(device);
        const depth = makeDepth(device);
        const pipeline = colorPipeline(device, "rgba8unorm", { depthFormat: "depth24plus" });
        const vb = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb");
        const encoder = device.createCommandEncoder();
        const first = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          depthStencilAttachment: { view: depth.view, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
        });
        const green = bufferOf(device, uniformBytes(IDENTITY, GREEN), "diag.ub.green");
        const greenBg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: green } }] });
        draw(first, pipeline, vb, greenBg, 3);
        first.end();
        // The engine's sky pass: colour loaded, depth read-only, geometry on the far plane.
        const skyPipeline = colorPipeline(device, "rgba8unorm", { depthFormat: "depth24plus", depthWrite: false });
        const second = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, loadOp: "load", storeOp: "store" }],
          depthStencilAttachment: { view: depth.view, depthReadOnly: true },
        });
        const blue = bufferOf(device, uniformBytes(IDENTITY, BLUE), "diag.ub.blue");
        const blueBg = device.createBindGroup({ layout: skyPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: blue } }] });
        const far = vertexBufferOf(device, withZ(QUAD, 1.0), "diag.vb.far");
        draw(second, skyPipeline, far, blueBg, 3);
        second.end();
        device.queue.submit([encoder.finish()]);
        const data = await readback(device, target);
        const c = point(data, "c");
        return { actual: sample(data), ok: near(c, [0, 255, 0]) };
      },
    },
    {
      name: "depth-load",
      expected: "c=green (control: explicit depthLoadOp load)",
      async run(device) {
        const target = makeTarget(device);
        const depth = makeDepth(device);
        const pipeline = colorPipeline(device, "rgba8unorm", { depthFormat: "depth24plus" });
        const vb = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb");
        const encoder = device.createCommandEncoder();
        const first = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          depthStencilAttachment: { view: depth.view, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
        });
        const green = bufferOf(device, uniformBytes(IDENTITY, GREEN), "diag.ub.green");
        const greenBg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: green } }] });
        draw(first, pipeline, vb, greenBg, 3);
        first.end();
        const skyPipeline = colorPipeline(device, "rgba8unorm", { depthFormat: "depth24plus", depthWrite: false });
        const second = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, loadOp: "load", storeOp: "store" }],
          depthStencilAttachment: { view: depth.view, depthLoadOp: "load", depthStoreOp: "discard" },
        });
        const blue = bufferOf(device, uniformBytes(IDENTITY, BLUE), "diag.ub.blue");
        const blueBg = device.createBindGroup({ layout: skyPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: blue } }] });
        const far = vertexBufferOf(device, withZ(QUAD, 1.0), "diag.vb.far");
        draw(second, skyPipeline, far, blueBg, 3);
        second.end();
        device.queue.submit([encoder.finish()]);
        const data = await readback(device, target);
        const c = point(data, "c");
        return { actual: sample(data), ok: near(c, [0, 255, 0]) };
      },
    },
    {
      name: "dynamic-offsets",
      expected: "l=red c=green r=blue",
      async run(device) {
        const target = makeTarget(device);
        const pipeline = colorPipeline(device, "rgba8unorm", { dynamicUniform: true });
        const layout = pipeline.getBindGroupLayout(0);
        // One buffer, three slices, three draws: exactly how the renderer feeds per-batch uniforms.
        const bytes = new ArrayBuffer(256 * 3);
        const f = new Float32Array(bytes);
        for (let slice = 0; slice < 3; slice++) {
          const base = (slice * 256) / 4;
          f.set(IDENTITY, base);
          f.set(slice === 0 ? RED : slice === 1 ? GREEN : BLUE, base + 16);
        }
        const ub = device.createBuffer({ size: bytes.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(ub, 0, bytes);
        const bindGroup = device.createBindGroup({
          layout,
          entries: [{ binding: 0, resource: { buffer: ub, size: 80 } }],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup, [0]);
        pass.setVertexBuffer(0, vertexBufferOf(device, withZ(BAND_L, 0.5), "diag.vb.left"));
        pass.draw(6);
        pass.setBindGroup(0, bindGroup, [256]);
        pass.setVertexBuffer(0, vertexBufferOf(device, withZ(BAND_M, 0.5), "diag.vb.mid"));
        pass.draw(6);
        pass.setBindGroup(0, bindGroup, [512]);
        pass.setVertexBuffer(0, vertexBufferOf(device, withZ(BAND_R, 0.5), "diag.vb.right"));
        pass.draw(6);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const data = await readback(device, target);
        const ok = near(point(data, "l"), [255, 0, 0]) && near(point(data, "c"), [0, 255, 0]) && near(point(data, "r"), [0, 0, 255]);
        return { actual: sample(data), ok };
      },
    },
    {
      name: "uniform-mat4",
      expected: "l=black r=red (mat4 moves the triangle to the right half)",
      async run(device) {
        const target = makeTarget(device);
        const pipeline = colorPipeline(device, "rgba8unorm");
        const scaled = [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 1];
        const ub = bufferOf(device, uniformBytes(scaled, RED), "diag.ub");
        const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }] });
        const vb = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb");
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        draw(pass, pipeline, vb, bg, 3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const data = await readback(device, target);
        const ok = near(point(data, "l"), [0, 0, 0]) && near(point(data, "r"), [255, 0, 0]);
        return { actual: sample(data), ok };
      },
    },
    {
      name: "cull-winding",
      expected: "cgw: front=red back=black (cull order for `frontFace: cw`) · cccw: front=black back=red",
      async run(device) {
        // Front-facing under `frontFace: "cw"`: NDC (-1,-1) (1,-1) (-1,1) is counter-clockwise with
        // y up, and framebuffer coordinates have y down, so it is clockwise on screen — front-facing
        // for "cw" and back-facing for "ccw". The engine's meshes are authored for `frontFace: "cw"`.
        const frontCw = new Float32Array([-1, -1, 0.5, 1, -1, 0.5, -1, 1, 0.5]);
        const backCw = new Float32Array([1, -1, 0.5, -1, -1, 0.5, -1, 1, 0.5]);

        const render = async (verts: Float32Array<ArrayBuffer>, frontFace: GPUFrontFace): Promise<[number, number, number]> => {
          const module = device.createShaderModule({ label: "diag.color", code: VS_AND_FS });
          const pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
            fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
            primitive: { topology: "triangle-list", frontFace, cullMode: "back" },
          });
          const ub = bufferOf(device, uniformBytes(IDENTITY, RED), "diag.ub");
          const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }] });
          const vb = vertexBufferOf(device, verts, "diag.vb.cull");
          const target = makeTarget(device);
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          });
          draw(pass, pipeline, vb, bg, 3);
          pass.end();
          device.queue.submit([encoder.finish()]);
          return point(await readback(device, target), "c");
        };
        const cwFront = await render(frontCw, "cw");
        const cwBack = await render(backCw, "cw");
        const ccwFront = await render(frontCw, "ccw");
        const ccwBack = await render(backCw, "ccw");
        const show = (c: [number, number, number]) => (near(c, [255, 0, 0]) ? "red" : near(c, [0, 0, 0]) ? "black" : c.join(","));
        const actual = `cgw: front=${show(cwFront)} back=${show(cwBack)} · cccw: front=${show(ccwFront)} back=${show(ccwBack)}`;
        // Under `frontFace: "cw"` the first triangle is front-facing (drawn) and the reversed one is
        // culled; under "ccw" it is the other way round. A device that answers both the same way, or
        // answers them backwards, will cull the engine's geometry.
        const ok = show(cwFront) === "red" && show(cwBack) === "black" && show(ccwFront) === "black" && show(ccwBack) === "red";
        return { actual, ok };
      },
    },
    {
      name: "storage-window",
      expected: "A: l=red c=green r=blue · B: l=yellow c=cyan r=magenta (dynamic offset selects the window)",
      async run(device) {
        const module = device.createShaderModule({ label: "diag.storage", code: VS_AND_FS_STORAGE_WINDOW });
        const layout = device.createBindGroupLayout({
          label: "diag.storage",
          entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage", hasDynamicOffset: true, minBindingSize: 32 } },
          ],
        });
        const pipeline = device.createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
          fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
          primitive: { topology: "triangle-list" },
        });
        // Two 256-byte windows: window A at 0, window B at 256. Records are 32 B (vec2 + pad + vec4);
        // the engine's instance arena has the same shape, with one window of slack per batch.
        const floats = new Float32Array(128);
        const write = (windowByteOffset: number, index: number, offsetX: number, color: readonly [number, number, number, number]) => {
          const base = windowByteOffset / 4 + index * 8;
          floats[base] = offsetX;
          floats[base + 4] = color[0];
          floats[base + 5] = color[1];
          floats[base + 6] = color[2];
          floats[base + 7] = color[3];
        };
        const A: [number, number, number, number][] = [RED, GREEN, BLUE];
        const B: [number, number, number, number][] = [
          [1, 1, 0, 1],
          [0, 1, 1, 1],
          [1, 0, 1, 1],
        ];
        for (let i = 0; i < 3; i++) {
          write(0, i, (i - 1) * (2 / 3), A[i]!);
          write(256, i, (i - 1) * (2 / 3), B[i]!);
        }
        const buffer = device.createBuffer({ size: floats.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(buffer, 0, floats);
        const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer, size: 256 } }] });
        const quad = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb.quad");

        const render = async (dynamicOffset: number): Promise<string> => {
          const target = makeTarget(device);
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup, [dynamicOffset]);
          pass.setVertexBuffer(0, quad);
          pass.draw(6, 3);
          pass.end();
          device.queue.submit([encoder.finish()]);
          return sample(await readback(device, target));
        };
        let actualA = "threw";
        let actualB = "threw";
        try {
          actualA = await render(0);
          actualB = await render(256);
        } catch (error) {
          return { actual: `${actualA} / ${actualB}`, ok: false, expected: `threw: ${String(error)}` };
        }
        const readings = `${actualA} | ${actualB}`;
        // Window A must paint red/green/blue; window B yellow/cyan/magenta. Any other pairing means
        // the dynamic offset did not select the window the shader read.
        const ok =
          actualA.includes("l=255,0,0") && actualA.includes("c=0,255,0") && actualA.includes("r=0,0,255") &&
          actualB.includes("l=255,255,0") && actualB.includes("c=0,255,255") && actualB.includes("r=255,0,255");
        return { actual: readings, ok };
      },
    },
    {
      name: "instanced",
      expected: "l=red r=green (two instances, per-instance attributes)",
      async run(device) {
        const target = makeTarget(device);
        const module = device.createShaderModule({ label: "diag.instanced", code: VS_INSTANCED });
        const pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: {
            module,
            entryPoint: "vs",
            buffers: [
              { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
              {
                arrayStride: 24,
                stepMode: "instance",
                attributes: [
                  { shaderLocation: 1, offset: 0, format: "float32x2" },
                  { shaderLocation: 2, offset: 8, format: "float32x3" },
                ],
              },
            ],
          },
          fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
          primitive: { topology: "triangle-list" },
        });
        const vertex = vertexBufferOf(device, withZ(LEFT, 0.5), "diag.vb.left");
        const instances = new Float32Array([0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
        const instanceBuffer = device.createBuffer({
          size: instances.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(instanceBuffer, 0, instances);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        pass.setPipeline(pipeline);
        pass.setVertexBuffer(0, vertex);
        pass.setVertexBuffer(1, instanceBuffer);
        pass.draw(3, 2);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const data = await readback(device, target);
        const ok = near(point(data, "l"), [255, 0, 0]) && near(point(data, "r"), [0, 255, 0]);
        return { actual: sample(data), ok };
      },
    },
    {
      name: "array-layer",
      expected: "c=green (draw into layer 1 of a 2-layer texture, then sample layer 1)",
      async run(device) {
        const texture = device.createTexture({
          label: "diag.array",
          size: [W, H, 2],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const layerView = texture.createView({ dimension: "2d", baseArrayLayer: 1, arrayLayerCount: 1 });
        const pipeline = colorPipeline(device, "rgba8unorm");
        const ub = bufferOf(device, uniformBytes(IDENTITY, GREEN), "diag.ub");
        const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }] });
        const vb = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb");
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: layerView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        draw(pass, pipeline, vb, bg, 3);
        pass.end();
        device.queue.submit([encoder.finish()]);

        const target = makeTarget(device);
        const module = device.createShaderModule({ label: "diag.sampleArray", code: FS_SAMPLE_ARRAY });
        const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
        const samplePipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
          fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
          primitive: { topology: "triangle-list" },
        });
        const arrayView = texture.createView({ dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: 2 });
        const sampleBind = device.createBindGroup({
          layout: samplePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: arrayView },
          ],
        });
        const full = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb.full");
        const second = device.createCommandEncoder();
        const samplePass = second.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        draw(samplePass, samplePipeline, full, sampleBind, 3);
        samplePass.end();
        device.queue.submit([second.finish()]);
        const data = await readback(device, target);
        return { actual: sample(data), ok: near(point(data, "c"), [0, 255, 0]) };
      },
    },
    {
      name: "hdr-tonemap",
      expected: "c=green (rgba16float target sampled by a second pass)",
      async run(device) {
        const hdr = makeTarget(device, "rgba16float");
        const pipeline = colorPipeline(device, "rgba16float");
        const ub = bufferOf(device, uniformBytes(IDENTITY, GREEN), "diag.ub");
        const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }] });
        const vb = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb");
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: hdr.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        draw(pass, pipeline, vb, bg, 3);
        pass.end();
        device.queue.submit([encoder.finish()]);

        const target = makeTarget(device);
        const module = device.createShaderModule({ label: "diag.sample", code: FS_SAMPLE });
        const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
        const samplePipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
          fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
          primitive: { topology: "triangle-list" },
        });
        const sampleBind = device.createBindGroup({
          layout: samplePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: hdr.view },
          ],
        });
        const full = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb.full");
        const second = device.createCommandEncoder();
        const samplePass = second.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        draw(samplePass, samplePipeline, full, sampleBind, 3);
        samplePass.end();
        device.queue.submit([second.finish()]);
        const data = await readback(device, target);
        return { actual: sample(data), ok: near(point(data, "c"), [0, 255, 0]) };
      },
    },
    {
      name: "srgb-sample",
      expected: "c≈55 (rgba8unorm-srgb 128 decodes to linear before being written raw)",
      async run(device) {
        const texture = device.createTexture({
          label: "diag.srgb",
          size: [1, 1],
          format: "rgba8unorm-srgb",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture }, new Uint8Array([128, 128, 128, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
        const target = makeTarget(device);
        const module = device.createShaderModule({ label: "diag.sample", code: FS_SAMPLE });
        const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
        const pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
          fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
          primitive: { topology: "triangle-list" },
        });
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: texture.createView() },
          ],
        });
        const vb = vertexBufferOf(device, withZ(QUAD, 0.5), "diag.vb");
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
        });
        draw(pass, pipeline, vb, bind, 3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        const data = await readback(device, target);
        const c = point(data, "c");
        return { actual: sample(data), ok: c[0] < 96 && c[0] > 32 };
      },
    },
  ];
}

/**
 * Run every probe against `device`. Each case is isolated: a throw (validation error, lost device,
 * unsupported operation) is recorded as that case's failure and the suite continues, because a
 * suite that stops at the first problem reports the least.
 */
export async function runRawGpuTests(device: GPUDevice, label = "device"): Promise<{ label: string; results: RawTestResult[] }> {
  const results: RawTestResult[] = [];
  for (const test of cases()) {
    let scope: string | null = null;
    try {
      if (typeof device.pushErrorScope === "function") device.pushErrorScope("validation");
    } catch {
      scope = "unavailable";
    }
    // Watchdog: a probe that blocks (a readback that never maps on a busy device) must not stop the
    // rest of the suite — the report of what did run is worth more than a complete run that hangs.
    let watchdog = 0;
    const timeout = new Promise<never>((_, reject) => {
      watchdog = self.setTimeout(() => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
    });
    try {
      const { actual, ok } = await Promise.race([test.run(device), timeout]);
      results.push({ name: test.name, ok, expected: test.expected, actual });
    } catch (error) {
      results.push({ name: test.name, ok: false, expected: test.expected, actual: "threw", error: String(error) });
    }
    finally {
      clearTimeout(watchdog);
    }
    if (scope !== "unavailable" && typeof device.popErrorScope === "function") {
      try {
        const captured = await device.popErrorScope();
        if (captured) {
          const last = results[results.length - 1]!;
          last.error = `${last.error ? `${last.error} | ` : ""}validation: ${captured.message}`;
        }
      } catch (error) {
        results.push({ name: `${test.name} (error scope)`, ok: false, expected: "popErrorScope", actual: "threw", error: String(error) });
      }
    }
  }
  return { label, results };
}
