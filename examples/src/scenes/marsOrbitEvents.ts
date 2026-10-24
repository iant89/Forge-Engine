/**
 * Mars Orbit Explorer — the demo's weather script.
 *
 * This file is only *scripting*: which weather happens where, when in the year and how hard. The
 * simulation that turns these rows into clouds, dust, frost and ground-level haze is the engine's
 * {@link PlanetWeatherSystem} (`engine/src/environment/planetWeather.ts`), and the polar caps come
 * from {@link PlanetPolarCaps}. Swap the table and the same engine systems tell a different story.
 *
 * The table follows the broad shape of Mars' real seasonal cycle, in solar longitude (`Ls`, 0 = northern
 * spring equinox; the northern summer solstice is 90; the dusty season, with perihelion at ~251, runs
 * roughly 180–360):
 * - the **aphelion cloud belt**: a band of water-ice cloud over the tropics around Ls 15–165;
 * - **orographic ice clouds** crowning the big volcano on summer afternoons;
 * - **polar hoods** of ice cloud over the winter pole;
 * - **dust storms**: a few local ones, two regional ones that grow in the dusty season, and one
 *   planet-encircling event (a "2018-style" storm) that is the headline of Ls ~190–320;
 * - **dust-devil fields** over the warm lowland plains, strongest on southern-summer afternoons;
 * - **frost** on the cold basins in winter;
 * - **polar-vortex spirals** over the poles in autumn/winter.
 *
 * The geography is the port's own fictional Mars (`MARS_SITE_PRESETS`): the volcano and the canyon are
 * wherever the generator config put them, so the clouds that belong to them sit on them.
 */
import { MARS_SITE_PRESETS, type PlanetWeatherEventDef } from "@forge/engine";

const volcano = MARS_SITE_PRESETS.olympusMons!;
const canyon = MARS_SITE_PRESETS.vallesRift!;

export const MARS_ORBIT_EVENTS: readonly PlanetWeatherEventDef[] = Object.freeze([
  // ---------------------------------------------------------------- water-ice clouds
  {
    id: "aphelion-belt",
    kind: "ice-cloud",
    label: "Aphelion cloud belt",
    latDeg: 8,
    lonDeg: 0,
    radiusKm: 950,
    band: true,
    startLs: 10,
    endLs: 170,
    peak: 0.78,
    attack: 0.3,
    decay: 0.3,
    seed: 11,
  },
  {
    id: "volcano-orographic",
    kind: "ice-cloud",
    label: "Orographic clouds on the shield volcano",
    latDeg: volcano.latDeg,
    lonDeg: volcano.lonDeg,
    radiusKm: 520,
    startLs: 340,
    endLs: 190,
    peak: 1,
    attack: 0.12,
    decay: 0.25,
    diurnal: 0.9,
    seed: 12,
  },
  {
    id: "canyon-morning-ice",
    kind: "ice-cloud",
    label: "Canyon ice fog",
    latDeg: canyon.latDeg,
    lonDeg: canyon.lonDeg,
    radiusKm: 520,
    startLs: 20,
    endLs: 150,
    peak: 0.55,
    seed: 13,
  },
  {
    id: "north-polar-hood",
    kind: "ice-cloud",
    label: "North polar hood",
    latDeg: 72,
    lonDeg: 0,
    radiusKm: 1100,
    band: true,
    startLs: 150,
    endLs: 360,
    peak: 0.85,
    attack: 0.3,
    decay: 0.2,
    seed: 14,
  },
  {
    id: "south-polar-hood",
    kind: "ice-cloud",
    label: "South polar hood",
    latDeg: -72,
    lonDeg: 0,
    radiusKm: 1100,
    band: true,
    startLs: 330,
    endLs: 180,
    peak: 0.85,
    attack: 0.3,
    decay: 0.2,
    seed: 15,
  },

  // ---------------------------------------------------------------- dust
  {
    id: "global-dust",
    kind: "dust-storm",
    label: "Planet-encircling dust event",
    latDeg: -12,
    lonDeg: 120,
    radiusKm: 4300,
    startLs: 185,
    endLs: 335,
    peak: 0.82,
    attack: 0.22,
    decay: 0.55,
    driftLonDegPerSol: 0.9,
    seed: 21,
  },
  {
    id: "storm-hellas",
    kind: "dust-storm",
    label: "Southern basin storm",
    latDeg: -42,
    lonDeg: 70,
    radiusKm: 950,
    startLs: 170,
    endLs: 260,
    peak: 0.85,
    attack: 0.3,
    decay: 0.4,
    driftLonDegPerSol: 0.4,
    seed: 22,
  },
  {
    id: "storm-chryse",
    kind: "dust-storm",
    label: "Northern lowland storm",
    latDeg: 32,
    lonDeg: -40,
    radiusKm: 780,
    startLs: 205,
    endLs: 262,
    peak: 0.8,
    attack: 0.3,
    decay: 0.45,
    driftLonDegPerSol: -0.3,
    driftLatDegPerSol: -0.12,
    seed: 23,
  },
  {
    id: "storm-noachis",
    kind: "dust-storm",
    label: "Local storm",
    latDeg: -48,
    lonDeg: -12,
    radiusKm: 480,
    startLs: 135,
    endLs: 185,
    peak: 0.65,
    seed: 24,
  },
  // Regional storms with an organised spiral: the polar vortices of the cold seasons.
  {
    id: "polar-storm-north",
    kind: "regional-storm",
    label: "North polar storm",
    latDeg: 76,
    lonDeg: 20,
    radiusKm: 780,
    startLs: 235,
    endLs: 345,
    peak: 0.9,
    attack: 0.3,
    decay: 0.3,
    swirl: 1,
    driftLonDegPerSol: 1.2,
    seed: 25,
  },
  {
    id: "polar-storm-south",
    kind: "regional-storm",
    label: "South polar storm",
    latDeg: -77,
    lonDeg: 130,
    radiusKm: 720,
    startLs: 85,
    endLs: 160,
    peak: 0.85,
    attack: 0.3,
    decay: 0.3,
    swirl: -1,
    driftLonDegPerSol: -1,
    seed: 26,
  },

  // ---------------------------------------------------------------- dust devils
  {
    id: "devils-tropics",
    kind: "dust-devils",
    label: "Dust-devil season",
    latDeg: -5,
    lonDeg: 0,
    radiusKm: 2800,
    band: true,
    startLs: 130,
    endLs: 340,
    peak: 0.55,
    attack: 0.25,
    decay: 0.3,
    diurnal: 1,
    seed: 31,
  },
  {
    id: "devils-amazonis",
    kind: "dust-devils",
    label: "Lowland dust-devil field",
    latDeg: 28,
    lonDeg: -150,
    radiusKm: 950,
    startLs: 60,
    endLs: 230,
    peak: 0.95,
    diurnal: 1,
    seed: 32,
  },
  {
    id: "devils-plains",
    kind: "dust-devils",
    label: "Dust-devil plains",
    latDeg: -14,
    lonDeg: 175,
    radiusKm: 850,
    startLs: 150,
    endLs: 320,
    peak: 0.9,
    diurnal: 1,
    seed: 33,
  },

  // ---------------------------------------------------------------- frost
  {
    id: "frost-basin-south",
    kind: "frost",
    label: "Basin frost",
    latDeg: -43,
    lonDeg: 70,
    radiusKm: 780,
    startLs: 60,
    endLs: 160,
    peak: 0.9,
    attack: 0.35,
    decay: 0.35,
    seed: 41,
  },
  {
    id: "frost-argyre",
    kind: "frost",
    label: "Crater-basin frost",
    latDeg: -50,
    lonDeg: -42,
    radiusKm: 560,
    startLs: 55,
    endLs: 165,
    peak: 0.85,
    seed: 42,
  },
  {
    id: "frost-lowlands-north",
    kind: "frost",
    label: "Northern lowland frost",
    latDeg: 46,
    lonDeg: 110,
    radiusKm: 1100,
    startLs: 255,
    endLs: 20,
    peak: 0.85,
    attack: 0.3,
    decay: 0.35,
    seed: 43,
  },
]);

/** A named camera destination: where the demo can send the viewer to see an event at ground level. */
export interface MarsOrbitDestination {
  id: string;
  label: string;
  latDeg: number;
  lonDeg: number;
  /** The `Ls` (degrees) the event is at its best, so the demo can offer "go there, then". */
  ls: number;
  /** Local solar hour to land at. */
  hours: number;
  /** What the viewer should expect to see. */
  note: string;
}

export const MARS_ORBIT_DESTINATIONS: readonly MarsOrbitDestination[] = Object.freeze([
  { id: "devils", label: "Dust devils", latDeg: 28, lonDeg: -150, ls: 130, hours: 14, note: "Afternoon convective vortices over the lowland plains." },
  { id: "storm", label: "Dust storm", latDeg: -42, lonDeg: 70, ls: 225, hours: 13, note: "Regional storm haze: a butterscotch sky and a dim, muffled sun." },
  { id: "volcano", label: "Volcano clouds", latDeg: MARS_SITE_PRESETS.olympusMons!.latDeg, lonDeg: MARS_SITE_PRESETS.olympusMons!.lonDeg, ls: 70, hours: 15, note: "Water-ice cloud forming over the shield on a summer afternoon." },
  { id: "frost", label: "Frost", latDeg: -43, lonDeg: 70, ls: 110, hours: 7, note: "Morning frost on the basin floor, before the sun burns it off." },
  { id: "sunset", label: "Blue sunset", latDeg: 4, lonDeg: -60, ls: 90, hours: 17.9, note: "The blue glow around the setting sun (forward-scattered by dust)." },
]);
