/**
 * `AssetGraph` — the dependency graph over registry ids (Phase 15.2).
 *
 * The roadmap's example is a vehicle pulling in a mesh, a material, a texture, an animation,
 * physics and audio. The same shape holds for glTF (a scene → meshes → materials → textures).
 * The graph answers four questions the flat id→entry registry cannot:
 *
 *  1. **What does X need, and who needs X?** (`dependenciesOf` / `dependentsOf`, transitive
 *     `transitive`) — the editor's asset browser and the leak auditor both start here.
 *  2. **Is this id about to be evicted while a loaded asset still uses it?** The registry consults
 *     `dependentsOf` in `evictIdle`: a loaded dependent blocks eviction of its dependencies, and
 *     evicting the dependent unblocks the dependency in the same call (the eviction loop cascades).
 *  3. **Would registering this edge create a cycle?** (`wouldCycle` / `link`) — a cycle means a
 *     manifest/loader bug, and it must be loud at registration time, not a hang later.
 *  4. **If this asset's content changes, who must reload?** (transitive `dependents` — the hook
 *     `ResourceRegistry.invalidate` and `contentChanged` use for Phase 15.4's hot reload.)
 *
 * Deliberate non-goal: the graph does not schedule loads. A loader pulls its own dependencies
 * through `context.registry` (the existing `ResourceLoadContext.registry` seam); the graph is the
 * metadata + safety layer on top, not a load orchestrator (that is Phase 15.3's territory).
 *
 * Edges are `(dependent → dependency)`. Both directions are stored so `dependentsOf` is O(degree)
 * instead of a scan. Ids are opaque strings (see `AssetId`); the graph is pure data and has no
 * notion of resource state — "is a dependent still loaded" is the registry's question to answer.
 */

import { UsageError } from "../core/errors.js";

export class AssetGraph {
  /** id → the ids it depends on. */
  private readonly deps = new Map<string, Set<string>>();
  /** id → the ids that depend on it. */
  private readonly dependents = new Map<string, Set<string>>();

  /** Total (dependent, dependency) edges. */
  get edgeCount(): number {
    let n = 0;
    for (const set of this.deps.values()) n += set.size;
    return n;
  }

  /** Ids participating in at least one edge (either side). */
  get nodeCount(): number {
    const seen = new Set<string>();
    for (const [id, set] of this.deps) {
      seen.add(id);
      for (const d of set) seen.add(d);
    }
    return seen.size;
  }

  /**
   * Record that `id` depends on `dep`. Throws `UsageError` when the edge is a self-dependency or
   * would close a cycle — an asset that (transitively) needs itself can never finish loading, so
   * the only safe behavior is to refuse the edge.
   */
  link(id: string, dep: string): void {
    const cycle = this.wouldCycle(id, dep);
    if (cycle) throw new UsageError(`AssetGraph.link: dependency cycle detected (${cycle})`);
    this.depsSetOf(id).add(dep);
    this.dependentsSetOf(dep).add(id);
  }

  /**
   * Would linking `id → dep` close a cycle? Returns a human-readable cycle path (e.g.
   * `a → b → c → a`) or null. The registry pre-checks all of a descriptor's declared deps with
   * this so one bad edge rejects the whole registration loudly instead of half-linking.
   */
  wouldCycle(id: string, dep: string): string | null {
    if (id === dep) return `${id} depends on itself`;
    const path = this.reachablePath(dep, id);
    if (!path) return null;
    return [id, ...path].join(" → ");
  }

  /** Remove every edge touching `id` (both directions). Idempotent. */
  unlink(id: string): void {
    const set = this.deps.get(id);
    if (set) {
      for (const dep of set) {
        const back = this.dependents.get(dep);
        back?.delete(id);
        if (back && back.size === 0) this.dependents.delete(dep);
      }
      this.deps.delete(id);
    }
  }

  /** The ids `id` directly depends on (sorted; empty when unknown). */
  dependenciesOf(id: string): string[] {
    return [...(this.deps.get(id) ?? [])].sort();
  }

  /** The ids that directly depend on `id` (sorted; empty when unknown). */
  dependentsOf(id: string): string[] {
    return [...(this.dependents.get(id) ?? [])].sort();
  }

  /**
   * Everything reachable from `id` in one direction (transitive, deduplicated, sorted, `id`
   * itself excluded). `direction: "deps"` walks down to the leaves, `"dependents"` walks up to
   * the roots.
   */
  transitive(id: string, direction: "deps" | "dependents"): string[] {
    const map = direction === "deps" ? this.deps : this.dependents;
    const out = new Set<string>();
    const queue: string[] = [...(map.get(id) ?? [])];
    while (queue.length > 0) {
      const node = queue.pop()!;
      if (node === id || out.has(node)) continue;
      out.add(node);
      for (const next of map.get(node) ?? []) queue.push(next);
    }
    return [...out].sort();
  }

  stats(): { nodes: number; edges: number } {
    return { nodes: this.nodeCount, edges: this.edgeCount };
  }

  clear(): void {
    this.deps.clear();
    this.dependents.clear();
  }

  /** Path `from → … → target` following dependency edges, or null when unreachable. */
  private reachablePath(from: string, target: string): string[] | null {
    const visited = new Set<string>();
    const trail: string[] = [];
    const dfs = (node: string): boolean => {
      if (node === target) {
        trail.push(node);
        return true;
      }
      if (visited.has(node)) return false;
      visited.add(node);
      trail.push(node);
      for (const next of this.deps.get(node) ?? []) {
        if (dfs(next)) return true;
      }
      trail.pop();
      return false;
    };
    dfs(from);
    return trail[trail.length - 1] === target ? trail : null;
  }

  private depsSetOf(id: string): Set<string> {
    let set = this.deps.get(id);
    if (!set) {
      set = new Set();
      this.deps.set(id, set);
    }
    return set;
  }

  private dependentsSetOf(id: string): Set<string> {
    let set = this.dependents.get(id);
    if (!set) {
      set = new Set();
      this.dependents.set(id, set);
    }
    return set;
  }
}
