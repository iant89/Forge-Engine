/**
 * Hurricane demo script (fe-33): *only* the storyline. Everything physical — the wind/rain/cloud
 * field, eyewall and eye, the ocean, coastal terrain, palms and rain — is engine code
 * (`CycloneSystem`, `oceanWavesFromWind`, `coastalHeightAt`, `PalmGrove`, `PrecipitationField`).
 *
 * The storm forms ~420 km offshore as a tropical storm, tracks north-west onto the beach while
 * intensifying to Category 5, makes landfall over the camera (eyewall → eye → back eyewall) and
 * weakens inland. One track second ≈ 10 real minutes (`HURRICANE_TIME_COMPRESSION`), so the whole
 * approach plays in ~2 minutes.
 */

import { type CycloneKeyframe, type CoastalTerrainParams, CycloneTrack } from "@forge/engine";

const KM = 1000;

/** The beach: waterline through the origin, land toward −Z, sea toward +Z. */
export const HURRICANE_COAST: CoastalTerrainParams = {
  originX: 0,
  originZ: 0,
  directionX: 0,
  directionZ: -1,
  bedLevel: 0,
  slope: 0.06,
  minDepth: 30,
  bermHeight: 1.6,
  beachWidth: 70,
  duneHeight: 4.5,
  duneWidth: 36,
  inlandHeight: 1.5,
  seed: 7,
  // fe-34: a winding coast — a broad bay/point pair and smaller scallops.
  curveAmp1: 24,
  curveLength1: 560,
  curvePhase1: 0.5,
  curveAmp2: 7,
  curveLength2: 170,
  curvePhase2: 2.2,
  duneRows: 2,
};

/** Where the storm's effects are evaluated: the viewer on the beach. */
/** fe-34 v2: the scene seed — gusts, lightning and waterspouts derive their seeds from it. */
export const HURRICANE_SEED = 3401;

export const HURRICANE_OBSERVER = { x: 0, z: -50 } as const;

/** Real seconds per track second (forward speed in the wind field ≈ 6 m/s). */
export const HURRICANE_TIME_COMPRESSION = 600;

export const HURRICANE_KEYFRAMES: readonly CycloneKeyframe[] = [
  { time: 0, x: -60 * KM, z: 420 * KM, maxWind: 20, radiusMaxWind: 60 * KM, eyeRadius: 0, rain: 0.35 },
  { time: 20, x: -45 * KM, z: 330 * KM, maxWind: 29, radiusMaxWind: 50 * KM, eyeRadius: 6 * KM, rain: 0.5 },
  { time: 40, x: -30 * KM, z: 240 * KM, maxWind: 40, radiusMaxWind: 40 * KM, eyeRadius: 10 * KM, rain: 0.65 },
  { time: 60, x: -18 * KM, z: 160 * KM, maxWind: 52, radiusMaxWind: 32 * KM, eyeRadius: 13 * KM, rain: 0.8, surge: 0.3 },
  { time: 78, x: -8 * KM, z: 80 * KM, maxWind: 63, radiusMaxWind: 28 * KM, eyeRadius: 14 * KM, rain: 0.92, surge: 1.0 },
  { time: 90, x: -2 * KM, z: 32 * KM, maxWind: 72, radiusMaxWind: 26 * KM, eyeRadius: 15 * KM, rain: 1, surge: 2.0 },
  { time: 96, x: -1 * KM, z: 12 * KM, maxWind: 72, radiusMaxWind: 26 * KM, eyeRadius: 15 * KM, rain: 1, surge: 2.8 },
  { time: 108, x: 1 * KM, z: -12 * KM, maxWind: 70, radiusMaxWind: 26 * KM, eyeRadius: 15 * KM, rain: 1, surge: 2.8 },
  { time: 116, x: 3 * KM, z: -36 * KM, maxWind: 64, radiusMaxWind: 27 * KM, eyeRadius: 15 * KM, rain: 0.95, surge: 1.8 },
  { time: 125, x: 6 * KM, z: -75 * KM, maxWind: 52, radiusMaxWind: 30 * KM, eyeRadius: 14 * KM, rain: 0.8, surge: 0.8 },
];

export function createHurricaneTrack(): CycloneTrack {
  return new CycloneTrack(HURRICANE_KEYFRAMES);
}

/** Track time when the centre crosses the coastline (z = 0): landfall. */
export function hurricaneLandfallTime(track: CycloneTrack = createHurricaneTrack()): number {
  const keys = track.keys;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (a.z >= 0 && b.z < 0) return a.time + ((b.time - a.time) * a.z) / (a.z - b.z);
  }
  return track.duration;
}

/**
 * fe-34 scripted tide (m): the sea draws back like a low tide as the storm approaches (on top of
 * the engine's wind set-down), bottoming out around the outer bands, then recovers as the surge
 * dome (the keyframes' `surge`) arrives with the eyewall.
 */
export function hurricaneTide(time: number): number {
  const ease = (a: number, b: number, t: number): number => {
    const u = Math.max(0, Math.min(1, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  return -0.9 * ease(2, 30, time) * (1 - ease(58, 84, time));
}

/** Story beats used for the HUD caption and the screenshot/gate seek points. */
export const HURRICANE_BEATS = {
  offshore: 8,
  lowTide: 30,
  midStorm: 62,
  eyewall: 90,
  eye: 102,
  backEyewall: 112,
  surge: 104,
} as const;

/** Wind in mph / km/h for the HUD. */
export function windUnits(ms: number): { mph: number; kmh: number } {
  return { mph: ms * 2.23694, kmh: ms * 3.6 };
}
