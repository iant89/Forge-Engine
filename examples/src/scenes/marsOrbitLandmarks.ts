/**
 * Well-known places on Mars for the Mars Orbit Explorer's globe markers: where they are and why they are
 * famous. Data only — the scene draws the markers and the info card (`marsOrbitScene.ts`).
 *
 * Coordinates are planetocentric latitude and **east-positive** longitude in degrees, the frame of
 * `latLonToDirection` and the MOLA atlas (Olympus Mons sits near 226° E). Landing sites are the
 * published landing coordinates; for large features (basins, canyons, volcanic provinces) the point is
 * the feature's centre or summit. The real heights at the volcano and basin points are pinned against the
 * MOLA atlas by `tests/examples/marsOrbitScene.test.ts`, so a sign or hemisphere slip fails loudly.
 */

export type MarsLandmarkKind = "volcano" | "canyon" | "basin" | "plain" | "landing" | "polar";

export interface MarsLandmark {
  id: string;
  name: string;
  kind: MarsLandmarkKind;
  latDeg: number;
  /** East-positive, 0–360. */
  lonDeg: number;
  /** One or two sentences: what it is and why it is well known. */
  description: string;
}

/** Short labels for the info card. */
export const MARS_LANDMARK_KIND_LABEL: Readonly<Record<MarsLandmarkKind, string>> = Object.freeze({
  volcano: "Volcano",
  canyon: "Canyon",
  basin: "Impact basin",
  plain: "Plain",
  landing: "Landing site",
  polar: "Polar cap",
});

export const MARS_LANDMARKS: readonly MarsLandmark[] = Object.freeze([
  {
    id: "olympus-mons",
    name: "Olympus Mons",
    kind: "volcano",
    latDeg: 18.65,
    lonDeg: 226.2,
    description:
      "The tallest volcano in the Solar System: about 22 km above the Martian datum and some 600 km across. Its slopes are gentle, and a cliff up to 8 km high rings its base.",
  },
  {
    id: "tharsis-montes",
    name: "Tharsis Montes",
    kind: "volcano",
    latDeg: 0.8,
    lonDeg: 246.6,
    description:
      "Three giant shield volcanoes — Arsia, Pavonis (marked) and Ascraeus Mons — in a line along the crest of the Tharsis bulge, the largest volcanic region on Mars.",
  },
  {
    id: "elysium-mons",
    name: "Elysium Mons",
    kind: "volcano",
    latDeg: 24.8,
    lonDeg: 146.9,
    description:
      "The main volcano of Elysium, the second-largest volcanic region on Mars, about 14 km above the datum.",
  },
  {
    id: "valles-marineris",
    name: "Valles Marineris",
    kind: "canyon",
    latDeg: -13.9,
    lonDeg: 300.8,
    description:
      "A canyon system about 4,000 km long and up to 7 km deep — long enough to span the continental United States. It formed mainly as the crust rifted apart at the edge of Tharsis.",
  },
  {
    id: "noctis-labyrinthus",
    name: "Noctis Labyrinthus",
    kind: "canyon",
    latDeg: -7.0,
    lonDeg: 258.0,
    description:
      "\"The labyrinth of the night\": a maze of intersecting canyons at the western end of Valles Marineris, where the crust cracked as it stretched over Tharsis.",
  },
  {
    id: "hellas",
    name: "Hellas Planitia",
    kind: "basin",
    latDeg: -42.4,
    lonDeg: 70.5,
    description:
      "One of the largest impact basins in the Solar System, about 2,300 km across. Its floor, around 7 km below the datum, is the lowest ground on Mars and has the thickest air.",
  },
  {
    id: "argyre",
    name: "Argyre Planitia",
    kind: "basin",
    latDeg: -49.7,
    lonDeg: 316.0,
    description:
      "An impact basin about 1,800 km across in the southern highlands, one of the best-preserved large basins on Mars.",
  },
  {
    id: "utopia",
    name: "Utopia Planitia",
    kind: "basin",
    latDeg: 46.7,
    lonDeg: 117.5,
    description:
      "The largest recognised impact basin on Mars, about 3,300 km across, buried under the northern plains. Viking 2 landed here in 1976, and China's Zhurong rover in 2021.",
  },
  {
    id: "syrtis-major",
    name: "Syrtis Major",
    kind: "plain",
    latDeg: 8.4,
    lonDeg: 69.5,
    description:
      "A dark volcanic plain, and the first surface feature identified on another planet: Christiaan Huygens sketched it in 1659 and used it to measure the length of the Martian day.",
  },
  {
    id: "cydonia",
    name: "Cydonia",
    kind: "plain",
    latDeg: 40.75,
    lonDeg: 350.54,
    description:
      "Home of the \"Face on Mars\", a mesa that looked like a face in a low-resolution 1976 Viking image. Later, sharper images showed an ordinary eroded hill.",
  },
  {
    id: "viking-1",
    name: "Viking 1 (Chryse Planitia)",
    kind: "landing",
    latDeg: 22.27,
    lonDeg: 312.05,
    description:
      "Site of the first fully successful Mars landing, on 20 July 1976. Viking 1 sent back the first pictures from the surface and kept working for over six years.",
  },
  {
    id: "pathfinder",
    name: "Mars Pathfinder (Ares Vallis)",
    kind: "landing",
    latDeg: 19.13,
    lonDeg: 326.78,
    description:
      "Pathfinder bounced down on airbags on 4 July 1997 and released Sojourner, the first rover to drive on another planet, onto an ancient flood plain.",
  },
  {
    id: "spirit",
    name: "Spirit (Gusev Crater)",
    kind: "landing",
    latDeg: -14.57,
    lonDeg: 175.47,
    description:
      "The Spirit rover landed here in January 2004. In the Columbia Hills it found nearly pure silica deposits, a sign of ancient hot springs.",
  },
  {
    id: "opportunity",
    name: "Opportunity (Meridiani Planum)",
    kind: "landing",
    latDeg: -1.95,
    lonDeg: 354.47,
    description:
      "Opportunity landed in January 2004, found hematite \"blueberries\" that formed in water, and drove about 45 km over almost 15 years — far beyond its planned 90 days.",
  },
  {
    id: "curiosity",
    name: "Curiosity (Gale Crater)",
    kind: "landing",
    latDeg: -5.4,
    lonDeg: 137.8,
    description:
      "Since 2012 Curiosity has climbed Mount Sharp, a layered mound about 5 km high inside Gale Crater, reading its rocks as a record of an ancient lake and a drying climate.",
  },
  {
    id: "jezero",
    name: "Perseverance (Jezero Crater)",
    kind: "landing",
    latDeg: 18.38,
    lonDeg: 77.58,
    description:
      "Jezero held a lake about 3.5 billion years ago. Perseverance (2021) is collecting rock samples from its river delta, and the Ingenuity helicopter made the first powered flight on another planet here.",
  },
  {
    id: "insight",
    name: "InSight (Elysium Planitia)",
    kind: "landing",
    latDeg: 4.5,
    lonDeg: 135.62,
    description:
      "InSight (2018–2022) listened for marsquakes — more than 1,300 of them — and used them to measure the planet's crust, mantle and core.",
  },
  {
    id: "phoenix",
    name: "Phoenix (northern plains)",
    kind: "landing",
    latDeg: 68.22,
    lonDeg: 234.25,
    description:
      "Phoenix landed in the arctic plains in 2008 and dug up water ice a few centimetres below the soil, then watched it slowly vaporise.",
  },
  {
    id: "planum-boreum",
    name: "Planum Boreum",
    kind: "polar",
    latDeg: 87.0,
    lonDeg: 0.0,
    description:
      "The north polar cap: a dome of layered water ice about 3 km thick and 1,000 km across, cut by spiralling troughs. Its layers record past climate cycles.",
  },
  {
    id: "planum-australe",
    name: "Planum Australe",
    kind: "polar",
    latDeg: -86.0,
    lonDeg: 315.0,
    description:
      "The south polar layered deposits, topped by a permanent layer of frozen carbon dioxide over water ice. Each winter a seasonal cap of CO₂ frost spreads far beyond it.",
  },
]);
