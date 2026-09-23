/**
 * Scene-name routing for the demo's query string and selector.
 *
 * Keeping the default and aliases in a DOM-free helper makes the first-visit experience easy to pin
 * without booting WebGPU: an empty or unrecognised query opens the Perseverance showcase, while an
 * explicit `?scene=...` keeps the other demo scenes directly addressable.
 */

export type DemoSceneName =
  | "pbr"
  | "cubes"
  | "terrain"
  | "realistic"
  | "vehicle"
  | "particles"
  | "sky"
  | "weather"
  | "mars-showcase";

/** Resolve a scene query slug, defaulting to the rover showcase. */
export function resolveDemoSceneName(requestedScene: string | null): DemoSceneName {
  switch (requestedScene) {
    case "pbr":
    case "cubes":
    case "terrain":
    case "realistic":
    case "vehicle":
    case "particles":
    case "sky":
    case "weather":
    case "mars-showcase":
      return requestedScene;
    case "mars":
      return "terrain";
    case "realistic-terrain":
      return "realistic";
    case "vehicle-playground":
      return "vehicle";
    case "showcase":
      return "mars-showcase";
    default:
      return "mars-showcase";
  }
}
