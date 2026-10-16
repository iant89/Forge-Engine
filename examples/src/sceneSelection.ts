/**
 * Scene-name routing for the demo's query string and selector.
 *
 * Keeping the default and aliases in a DOM-free helper makes the first-visit experience easy to pin
 * without booting WebGPU: an empty or unrecognised query opens the Perseverance showcase, while an
 * explicit `?scene=...` keeps the other demo scenes directly addressable. The canonical scene list
 * is also used to validate selector changes, so a scene cannot be listed as valid for a deep link
 * but accidentally omitted from the UI's scene-switch path.
 */

export const DEMO_SCENE_NAMES = [
  "pbr",
  "cubes",
  "terrain",
  "realistic",
  "mars-generator",
  "vehicle",
  "particles",
  "sky",
  "weather",
  "amazon-river",
  "mars-showcase",
  "rover-course",
  "skinning",
  "gltf-skin",
  "alpine-rescue",
  "mars-dust-storm",
  "hurricane",
  "thaw",
  "offroad",
  "scripting",
] as const;

export type DemoSceneName = (typeof DEMO_SCENE_NAMES)[number];

const demoSceneNames: ReadonlySet<string> = new Set(DEMO_SCENE_NAMES);

/** True when `scene` is one of the selectable canonical scene names (aliases are not included). */
export function isDemoSceneName(scene: string): scene is DemoSceneName {
  return demoSceneNames.has(scene);
}

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
    case "amazon-river":
    case "mars-showcase":
    case "rover-course":
    case "skinning":
    case "gltf-skin":
    case "alpine-rescue":
    case "mars-dust-storm":
    case "hurricane":
    case "offroad":
    case "thaw":
    case "scripting":
      return requestedScene;
    case "beacon-defense":
    case "scripts":
      return "scripting";
    case "offroad-hill":
    case "hillside":
      return "offroad";
    case "snowmelt":
    case "mud":
      return "thaw";
    case "hurricane-landfall":
    case "beach":
      return "hurricane";
    case "dust-storm":
    case "storm":
      return "mars-dust-storm";
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
    case "amazon":
    case "river":
      return "amazon-river";
    default:
      return "mars-showcase";
  }
}
