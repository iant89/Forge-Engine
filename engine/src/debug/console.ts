/**
 * Safe, embeddable developer console for Phase 21.10. Commands are explicitly registered; user
 * input is tokenized and dispatched, never evaluated as JavaScript.
 */

import type { GraphicsDevice } from "../gpu/device.js";
import type { Scene } from "../scene/scene.js";
import type { Profiler } from "./profiler.js";
import type { Renderer } from "../rendering/renderer.js";
import type { AssetStreamer } from "../resources/streaming.js";
import type { TaskScheduler } from "../core/tasks/scheduler.js";
import { PhysicsSystem } from "../physics/system.js";
import { TerrainWorld } from "../terrain/world.js";
import { inspectEcs } from "./ecsInspector.js";
import { inspectRenderGraph, formatRenderGraph } from "./renderGraphInspector.js";
import { inspectGpuResources, formatGpuResources } from "./gpuResourceInspector.js";
import { physicsDebugDraw } from "./physicsDebugDraw.js";
import { inspectTerrain } from "./terrainDebugger.js";
import { inspectParticles } from "./particleDebugger.js";
import { inspectStreaming } from "./streamingDebugger.js";
import { inspectEnvironment } from "./environmentDebugger.js";

export interface DeveloperConsoleHost {
  stats?: () => unknown;
  currentScene?: Scene | null;
  profiler?: Profiler;
  renderer?: Pick<Renderer, "graph">;
  gpu?: Pick<GraphicsDevice, "resourceList" | "gpuMemory" | "frameIndex">;
  streamer?: Pick<AssetStreamer, "stats" | "inspect">;
  tasks?: Pick<TaskScheduler, "stats" | "inspect">;
}

export interface DeveloperConsoleOptions {
  /** Maximum retained command records. Defaults to 256; 0 disables history retention. */
  maxHistory?: number;
  /** Maximum rendered output size per command. Defaults to 32768 UTF-16 characters. */
  maxOutputChars?: number;
  /** Maximum accepted/stored command size. Defaults to 4096 UTF-16 characters. */
  maxInputChars?: number;
}

export interface DeveloperConsoleCommand {
  name: string;
  description: string;
  usage?: string;
  handler: (args: readonly string[], context: DeveloperConsoleCommandContext) => unknown;
}

export interface DeveloperConsoleCommandContext {
  host: DeveloperConsoleHost;
  console: DeveloperConsole;
}

export interface DeveloperConsoleEntry {
  sequence: number;
  timestamp: number;
  input: string;
  command: string;
  args: string[];
  ok: boolean;
  output: string[];
}

/** Small command registry + bounded transcript. It owns no DOM, event handlers, or live engine state. */
export class DeveloperConsole {
  readonly host: DeveloperConsoleHost;
  readonly maxHistory: number;
  readonly maxOutputChars: number;
  readonly maxInputChars: number;
  private readonly commands = new Map<string, DeveloperConsoleCommand>();
  private readonly records: DeveloperConsoleEntry[] = [];
  private sequence = 0;

  constructor(host: DeveloperConsoleHost = {}, options: DeveloperConsoleOptions = {}) {
    this.host = host;
    this.maxHistory = finiteBound(options.maxHistory, 256, 0, 2048);
    this.maxOutputChars = finiteBound(options.maxOutputChars, 32768, 256, 65536);
    this.maxInputChars = finiteBound(options.maxInputChars, 4096, 256, 65536);
    this.installBuiltins();
  }

  /** Immutable command metadata in sorted-name order. */
  get commandList(): readonly Pick<DeveloperConsoleCommand, "name" | "description" | "usage">[] {
    return [...this.commands.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, usage }) => ({ name, description, ...(usage ? { usage } : {}) }));
  }

  /** Detached transcript copy; callers cannot alter retained history through this view. */
  get history(): DeveloperConsoleEntry[] {
    return this.records.map((entry) => ({ ...entry, args: [...entry.args], output: [...entry.output] }));
  }

  register(command: DeveloperConsoleCommand): () => void {
    const name = command.name.trim().toLowerCase();
    if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new Error(`invalid console command name "${command.name}"`);
    if (this.commands.has(name)) throw new Error(`console command "${name}" is already registered`);
    if (!command.description.trim()) throw new Error(`console command "${name}" needs a description`);
    const entry = { ...command, name };
    this.commands.set(name, entry);
    return () => {
      if (this.commands.get(name) === entry) this.commands.delete(name);
    };
  }

  execute(input: string): DeveloperConsoleEntry {
    let command = "";
    let args: string[] = [];
    let ok = true;
    let output: string[] = [];
    try {
      if (input.length > this.maxInputChars) throw new Error(`command exceeds the ${this.maxInputChars}-character input limit`);
      const tokens = tokenize(input);
      command = (tokens.shift() ?? "").toLowerCase();
      args = tokens;
      if (!command) output = [];
      else {
        const definition = this.commands.get(command);
        if (!definition) throw new Error(`unknown command "${command}"; run help to list commands`);
        const result = definition.handler(Object.freeze([...args]), { host: this.host, console: this });
        output = formatOutput(result, this.maxOutputChars);
      }
    } catch (error) {
      ok = false;
      output = formatOutput(error instanceof Error ? error.message : String(error), this.maxOutputChars);
    }
    const record: DeveloperConsoleEntry = {
      sequence: ++this.sequence,
      timestamp: Date.now(),
      input: input.slice(0, this.maxInputChars),
      command,
      args: [...args],
      ok,
      output,
    };
    if (this.maxHistory > 0) {
      this.records.push(record);
      while (this.records.length > this.maxHistory) this.records.shift();
    }
    return { ...record, args: [...record.args], output: [...record.output] };
  }

  /** Command-name completion for a partial first token. */
  complete(input: string): string[] {
    if (/\s/.test(input)) return [];
    const prefix = input.toLowerCase();
    return [...this.commands.keys()].filter((name) => name.startsWith(prefix)).sort();
  }

  clearHistory(): void {
    this.records.length = 0;
  }

  private installBuiltins(): void {
    this.register({ name: "help", description: "List commands or show one command's usage", usage: "help [command]", handler: (args) => {
      if (args[0]) {
        const command = this.commands.get(args[0]!.toLowerCase());
        if (!command) throw new Error(`unknown command "${args[0]}"`);
        return `${command.usage ?? command.name}\n${command.description}`;
      }
      return this.commandList.map((command) => `${command.usage ?? command.name.padEnd(14)}  ${command.description}`).join("\n");
    } });
    this.register({ name: "clear", description: "Clear the retained console transcript", handler: (_args, context) => {
      context.console.clearHistory();
      return "Console history cleared.";
    } });
    this.register({ name: "stats", description: "Show the engine's frame, resource, streaming, and task summary", handler: (_args, { host }) => {
      if (!host.stats) throw new Error("engine stats are unavailable");
      return host.stats();
    } });
    this.register({ name: "profiler", description: "Inspect CPU/GPU scope costs and recent frame timeline slices", usage: "profiler [scope-rows]", handler: (args, { host }) => {
      if (!host.profiler) throw new Error("frame profiler is unavailable");
      const recent = host.profiler.frameHistory().slice(-30).map((frame) => ({
        index: frame.index,
        totalMs: frame.totalMs,
        cpuMs: frame.cpuMs,
        gpuMs: frame.gpuMs,
        scriptMs: frame.scriptMs,
        physicsMs: frame.physicsMs,
        renderMs: frame.renderMs,
        drawCalls: frame.drawCalls,
        triangles: frame.triangles,
        slices: frame.slices.slice(0, 128),
        truncatedSlices: frame.slices.length > 128,
      }));
      return {
        report: host.profiler.report(parseLimit(args[0], 20)),
        frameHistory: recent,
        counters: host.profiler.countersSnapshot(),
        recentMarks: host.profiler.recentMarks.slice(-32),
      };
    } });
    this.register({ name: "ecs", description: "Inspect bounded ECS/system state", usage: "ecs [name-or-component-filter] [limit]", handler: (args, { host }) => {
      const scene = requireScene(host);
      return inspectEcs(scene.world, { profiler: host.profiler ?? null, filter: args[0], limit: parseLimit(args[1], 100) });
    } });
    this.register({ name: "rendergraph", description: "Show the most recently executed render graph", handler: (_args, { host }) => {
      if (!host.renderer) throw new Error("renderer is unavailable");
      return formatRenderGraph(inspectRenderGraph(host.renderer.graph));
    } });
    this.register({ name: "gpu", description: "Summarize live GPU buffers, textures, and object counts", handler: (_args, { host }) => {
      if (!host.gpu) throw new Error("GPU device is unavailable");
      return formatGpuResources(inspectGpuResources(host.gpu));
    } });
    this.register({ name: "physics", description: "Summarize rigid bodies and bounded debug-wireframe output", usage: "physics [max-bodies]", handler: (args, { host }) => {
      const scene = requireScene(host);
      const system = scene.world.systems.find((item) => item instanceof PhysicsSystem);
      if (!(system instanceof PhysicsSystem)) throw new Error("no PhysicsSystem is registered on the active scene");
      const maxBodies = parseLimit(args[0], 64);
      const view = physicsDebugDraw(system.world, { maxBodies, showAabbs: true, showVelocity: true });
      return {
        bodyCount: view.bodyCount,
        processedBodies: view.processedBodies,
        truncatedBodies: view.truncatedBodies,
        debugLineCount: view.lineCount,
        bodies: system.world.bodies.slice(0, maxBodies).map((body) => ({
          id: body.id,
          type: body.type,
          shape: body.shape.type,
          position: [body.renderPosition.x, body.renderPosition.y, body.renderPosition.z],
          velocity: [body.linearVelocity.x, body.linearVelocity.y, body.linearVelocity.z],
        })),
      };
    } });
    this.register({ name: "terrain", description: "Inspect the first active terrain world's chunks, LOD, and streaming budgets", usage: "terrain [chunk-filter] [limit]", handler: (args, { host }) => {
      const scene = requireScene(host);
      const world = scene.objects.find((object) => object instanceof TerrainWorld);
      if (!(world instanceof TerrainWorld)) throw new Error("no TerrainWorld is attached to the active scene");
      return inspectTerrain(world, { filter: args[0], limit: parseLimit(args[1], 128) });
    } });
    this.register({ name: "particles", description: "Inspect CPU/GPU particle worlds and bounded CPU samples", usage: "particles [world-filter] [limit]", handler: (args, { host }) => {
      const scene = requireScene(host);
      return inspectParticles(scene, { filter: args[0], maxParticleSamples: parseLimit(args[1], 32) });
    } });
    this.register({ name: "streaming", description: "Inspect asset loads, worker tasks, and streaming scene objects", usage: "streaming [filter] [limit]", handler: (args, { host }) => {
      if (!host.streamer || !host.tasks) throw new Error("asset streamer or task scheduler is unavailable");
      return inspectStreaming({ streamer: host.streamer, tasks: host.tasks, currentScene: host.currentScene ?? null }, { filter: args[0], limit: parseLimit(args[1], 64) });
    } });
    this.register({ name: "environment", description: "Inspect sun, atmosphere, weather, water, and lightning", usage: "environment [x y z]", handler: (args, { host }) => {
      const scene = requireScene(host);
      const samplePosition = args.length >= 3 ? { x: finiteNumber(args[0]!), y: finiteNumber(args[1]!), z: finiteNumber(args[2]!) } : undefined;
      return inspectEnvironment(scene, { samplePosition });
    } });
  }
}

/** Create a console preloaded with the standard diagnostics commands. */
export function createDeveloperConsole(host: DeveloperConsoleHost = {}, options: DeveloperConsoleOptions = {}): DeveloperConsole {
  return new DeveloperConsole(host, options);
}

function requireScene(host: DeveloperConsoleHost): Scene {
  if (!host.currentScene) throw new Error("there is no active scene");
  return host.currentScene;
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`expected a non-negative integer, got "${value}"`);
  return Math.min(parsed, 1024);
}

function finiteNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`expected a finite number, got "${value}"`);
  return parsed;
}

function finiteBound(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
      continue;
    }
    if (quote && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("unclosed quoted argument");
  if (started) tokens.push(token);
  return tokens;
}

function formatOutput(value: unknown, maxChars: number): string[] {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === undefined) text = "(no output)";
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch (error) {
      text = `could not format command output: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (text.length > maxChars) {
    const suffix = "\n… output truncated …";
    text = `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
  }
  return text ? text.split("\n") : [];
}
