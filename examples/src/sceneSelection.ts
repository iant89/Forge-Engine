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
  | "mars-generator"
  | "vehicle"
  | "particles"
  | "sky"
  | "weather"
  | "mars-showcase"
  | "rover-course";

/** Resolve a scene query slug, defaulting to the rover showcase. */
export function resolveDemoSceneName(requestedScene: string | null): DemoSceneName {
  switch (requestedScene) {
    case "pbr":
    case "cubes":
    case "terrain":
    case "realistic":
    case "mars-generator":
    case "vehicle":
    case "particles":
    case "sky":
    case "weather":
    case "mars-showcase":
    case "rover-course":
      return requestedScene;
    case "mars":
      return "terrain";
    case "realistic-terrain":
      return "realistic";
    case "mars-port":
    case "mars-generator-port":
      return "mars-generator";
    case "vehicle-playground":
      return "vehicle";
    case "showcase":
      return "mars-showcase";
    case "course":
      return "rover-course";
    default:
      return "mars-showcase";
  }
}
