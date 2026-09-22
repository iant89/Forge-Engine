/**
 * Solar position (Phase 8a).
 *
 * The NOAA solar calculator equations — Meeus, *Astronomical Algorithms*, chapters 7 (Julian day),
 * 25 (low-accuracy solar coordinates) and 28 (equation of time) — evaluated in degrees exactly as
 * NOAA publishes them, then converted to the engine's radians and axes at the very end. The
 * low-accuracy series is good to ~0.01° in the sun's position, which is far below anything a shadow
 * or a sky can show; `tests/environment.test.ts` pins it against Meeus' worked examples.
 *
 * Time is a Julian day in **UTC**. Longitude is positive **east**, latitude positive north.
 *
 * Engine axes: +Y up, **north = +Z, east = +X** (facing north, east is on your right — the world is
 * left-handed with +Z forward, so this is the geographically correct pair). Azimuth is a compass
 * bearing, clockwise from north: 0 N, π/2 E, π S, 3π/2 W. `sunDirection` turns a position into a
 * unit vector *toward* the sun in those axes; a `Light` travels the opposite way.
 */

import { Vec3 } from "../math/vec.js";
import { DEG_TO_RAD, RAD_TO_DEG, clamp } from "../math/scalar.js";

/** Julian day of J2000.0 (2000 January 1, 12:00 TT). */
export const J2000 = 2451545;

/** Solar zenith angle at which NOAA places sunrise/sunset: 90° + 50′ (refraction + half a disc). */
export const SUNRISE_ZENITH_DEG = 90.833;

export interface SolarCoordinates {
  /** Julian century from J2000. */
  century: number;
  /** Apparent ecliptic longitude, radians. */
  apparentLongitude: number;
  /** Obliquity of the ecliptic corrected for nutation, radians. */
  obliquity: number;
  /** Apparent right ascension, radians in [0, 2π). */
  rightAscension: number;
  /** Apparent declination, radians. */
  declination: number;
  /** Equation of time, minutes (apparent solar time minus mean solar time). */
  equationOfTime: number;
  /** Earth–sun distance, astronomical units. */
  distanceAu: number;
}

export interface SolarPosition extends SolarCoordinates {
  /** Elevation above the horizon with NOAA's refraction correction, radians. */
  elevation: number;
  /** Geometric elevation (no refraction), radians. */
  trueElevation: number;
  /** Compass azimuth, radians clockwise from north. */
  azimuth: number;
  /** Local hour angle, radians (negative before solar noon). */
  hourAngle: number;
  /** True solar time, hours in [0, 24). */
  solarTime: number;
}

export interface SunEvents {
  /** UTC hours of sunrise, or `null` when the sun does not rise or set on that day. */
  sunrise: number | null;
  sunset: number | null;
  /** UTC hours of solar noon. */
  solarNoon: number;
  /** Hours the sun is up: 0 during polar night, 24 during midnight sun. */
  dayLength: number;
  /** Solar declination used, radians. */
  declination: number;
}

export function createSolarPosition(): SolarPosition {
  return {
    century: 0,
    apparentLongitude: 0,
    obliquity: 0,
    rightAscension: 0,
    declination: 0,
    equationOfTime: 0,
    distanceAu: 1,
    elevation: 0,
    trueElevation: 0,
    azimuth: 0,
    hourAngle: 0,
    solarTime: 0,
  };
}

// ------------------------------------------------------------------ time

/**
 * Julian day of a Gregorian calendar date (Meeus 7.1). `day` may carry a fraction; `hoursUtc` is
 * added on top. Valid for any date after the Gregorian reform (October 1582).
 */
export function julianDay(year: number, month: number, day: number, hoursUtc = 0): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5 + hoursUtc / 24;
}

/** Julian day from a 1-based (possibly fractional) day of the year: `1.0` is January 1, 00:00 UTC. */
export function julianDayFromDayOfYear(year: number, dayOfYear: number, hoursUtc = 0): number {
  return julianDay(year, 1, 1) + (dayOfYear - 1) + hoursUtc / 24;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/** Julian centuries since J2000.0. */
export function julianCentury(jd: number): number {
  return (jd - J2000) / 36525;
}

// ------------------------------------------------------------------ coordinates

function mod360(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/**
 * Apparent solar coordinates for a Julian day (UTC). The low-accuracy series of Meeus chapter 25:
 * mean longitude and anomaly, equation of centre, apparent longitude with the nutation/aberration
 * term, mean + corrected obliquity, then right ascension and declination; chapter 28's equation of
 * time from the same quantities.
 */
export function solarCoordinates(jd: number, out: SolarCoordinates = createSolarPosition()): SolarCoordinates {
  const t = julianCentury(jd);
  const meanLongitude = mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const mRad = meanAnomaly * DEG_TO_RAD;
  const centre =
    Math.sin(mRad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mRad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mRad) * 0.000289;
  const trueLongitude = meanLongitude + centre;
  const trueAnomaly = meanAnomaly + centre;
  const distanceAu = (1.000001018 * (1 - eccentricity * eccentricity)) / (1 + eccentricity * Math.cos(trueAnomaly * DEG_TO_RAD));
  const omega = (125.04 - 1934.136 * t) * DEG_TO_RAD;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega);
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const meanObliquity = 23 + (26 + seconds / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega);

  const lamRad = apparentLongitude * DEG_TO_RAD;
  const epsRad = obliquity * DEG_TO_RAD;
  let rightAscension = Math.atan2(Math.cos(epsRad) * Math.sin(lamRad), Math.cos(lamRad));
  if (rightAscension < 0) rightAscension += Math.PI * 2;
  const declination = Math.asin(Math.sin(epsRad) * Math.sin(lamRad));

  // Equation of time (Meeus 28.3), in minutes.
  const y = Math.tan(epsRad / 2) ** 2;
  const l0 = meanLongitude * DEG_TO_RAD;
  const eot =
    y * Math.sin(2 * l0) -
    2 * eccentricity * Math.sin(mRad) +
    4 * eccentricity * y * Math.sin(mRad) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) -
    1.25 * eccentricity * eccentricity * Math.sin(2 * mRad);

  out.century = t;
  out.apparentLongitude = mod360(apparentLongitude) * DEG_TO_RAD;
  out.obliquity = epsRad;
  out.rightAscension = rightAscension;
  out.declination = declination;
  out.equationOfTime = 4 * eot * RAD_TO_DEG;
  out.distanceAu = distanceAu;
  return out;
}

/**
 * NOAA's atmospheric refraction correction, degrees to add to a geometric elevation (degrees).
 * Zero above 85°, the Bennett-style series down to 5°, a polynomial through the horizon, and a
 * capped term below −0.575° so the setting sun does not blow up.
 */
export function atmosphericRefractionDeg(trueElevationDeg: number): number {
  if (trueElevationDeg > 85) return 0;
  const te = Math.tan(trueElevationDeg * DEG_TO_RAD);
  let correction: number;
  if (trueElevationDeg > 5) {
    correction = 58.1 / te - 0.07 / (te * te * te) + 0.000086 / (te * te * te * te * te);
  } else if (trueElevationDeg > -0.575) {
    correction = 1735 + trueElevationDeg * (-518.2 + trueElevationDeg * (103.4 + trueElevationDeg * (-12.79 + trueElevationDeg * 0.711)));
  } else {
    correction = -20.774 / te;
  }
  return correction / 3600;
}

/**
 * Sun position for an observer. `jd` is UTC; latitude/longitude in degrees (east positive).
 * Everything in the result is radians except `equationOfTime` (minutes) and `solarTime` (hours).
 */
export function solarPosition(jd: number, latitudeDeg: number, longitudeDeg: number, out: SolarPosition = createSolarPosition(), refraction = true): SolarPosition {
  solarCoordinates(jd, out);
  const lat = clamp(latitudeDeg, -89.999, 89.999) * DEG_TO_RAD;
  const dec = out.declination;

  // True solar time in minutes: UTC clock + equation of time + 4 min per degree of longitude.
  const dayFraction = jd + 0.5 - Math.floor(jd + 0.5);
  const minutesUtc = dayFraction * 1440;
  let trueSolarMinutes = (minutesUtc + out.equationOfTime + 4 * longitudeDeg) % 1440;
  if (trueSolarMinutes < 0) trueSolarMinutes += 1440;
  let hourAngleDeg = trueSolarMinutes / 4 - 180;
  if (hourAngleDeg < -180) hourAngleDeg += 360;
  const ha = hourAngleDeg * DEG_TO_RAD;

  const cosZenith = clamp(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha), -1, 1);
  const zenith = Math.acos(cosZenith);
  const trueElevationDeg = 90 - zenith * RAD_TO_DEG;

  let azimuthDeg: number;
  const azDenom = Math.cos(lat) * Math.sin(zenith);
  if (Math.abs(azDenom) > 0.001) {
    const azRad = clamp((Math.sin(lat) * Math.cos(zenith) - Math.sin(dec)) / azDenom, -1, 1);
    azimuthDeg = 180 - Math.acos(azRad) * RAD_TO_DEG;
    if (hourAngleDeg > 0) azimuthDeg = -azimuthDeg;
  } else {
    azimuthDeg = latitudeDeg > 0 ? 180 : 0;
  }
  if (azimuthDeg < 0) azimuthDeg += 360;

  const elevationDeg = refraction ? trueElevationDeg + atmosphericRefractionDeg(trueElevationDeg) : trueElevationDeg;
  out.trueElevation = trueElevationDeg * DEG_TO_RAD;
  out.elevation = elevationDeg * DEG_TO_RAD;
  out.azimuth = azimuthDeg * DEG_TO_RAD;
  out.hourAngle = ha;
  out.solarTime = trueSolarMinutes / 60;
  return out;
}

/**
 * Unit vector toward a point on the sky at (elevation, azimuth) in engine axes: +Y up, north = +Z,
 * east = +X, azimuth clockwise from north.
 */
export function directionFromElevationAzimuth(elevation: number, azimuth: number, out = new Vec3()): Vec3 {
  const ce = Math.cos(elevation);
  return out.set(ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth));
}

/** Unit vector *toward* the sun for a computed position (uses the refracted elevation). */
export function sunDirection(position: SolarPosition, out = new Vec3()): Vec3 {
  return directionFromElevationAzimuth(position.elevation, position.azimuth, out);
}

/** Inverse of `directionFromElevationAzimuth`: `[elevation, azimuth]` in radians for a unit vector. */
export function elevationAzimuthOf(direction: { x: number; y: number; z: number }): [number, number] {
  const len = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const elevation = Math.asin(clamp(direction.y / len, -1, 1));
  let azimuth = Math.atan2(direction.x, direction.z);
  if (azimuth < 0) azimuth += Math.PI * 2;
  return [elevation, azimuth];
}

// ------------------------------------------------------------------ rise / set

/**
 * Sunrise, sunset and solar noon (UTC hours) for the calendar day that starts at `jdMidnightUtc`
 * (a Julian day ending in .5). Uses NOAA's hour-angle formula at the 90.833° zenith, refined once
 * at the estimated event time. Polar night gives `sunrise = sunset = null, dayLength = 0`; midnight
 * sun gives `null` events and `dayLength = 24`.
 */
export function sunEvents(jdMidnightUtc: number, latitudeDeg: number, longitudeDeg: number): SunEvents {
  const lat = clamp(latitudeDeg, -89.999, 89.999) * DEG_TO_RAD;
  const scratch = createSolarPosition();
  const noonGuess = solarCoordinates(jdMidnightUtc + 0.5, scratch);
  let solarNoonMinutes = 720 - 4 * longitudeDeg - noonGuess.equationOfTime;
  const atNoon = solarCoordinates(jdMidnightUtc + solarNoonMinutes / 1440, scratch);
  solarNoonMinutes = 720 - 4 * longitudeDeg - atNoon.equationOfTime;
  const declination = atNoon.declination;

  const hourAngleFor = (coords: SolarCoordinates): number | "night" | "day" => {
    const cosHa = Math.cos(SUNRISE_ZENITH_DEG * DEG_TO_RAD) / (Math.cos(lat) * Math.cos(coords.declination)) - Math.tan(lat) * Math.tan(coords.declination);
    if (cosHa > 1) return "night";
    if (cosHa < -1) return "day";
    return Math.acos(cosHa) * RAD_TO_DEG;
  };
  const first = hourAngleFor(atNoon);
  if (first === "night") return { sunrise: null, sunset: null, solarNoon: solarNoonMinutes / 60, dayLength: 0, declination };
  if (first === "day") return { sunrise: null, sunset: null, solarNoon: solarNoonMinutes / 60, dayLength: 24, declination };

  const eventMinutes = (haDeg: number, coords: SolarCoordinates, rise: boolean): number => 720 - 4 * (longitudeDeg + (rise ? haDeg : -haDeg)) - coords.equationOfTime;
  // One refinement: recompute declination and the equation of time at the estimated event.
  const refine = (rise: boolean): number | null => {
    let minutes = eventMinutes(first, atNoon, rise);
    const at = solarCoordinates(jdMidnightUtc + minutes / 1440, scratch);
    const ha = hourAngleFor(at);
    if (typeof ha !== "number") return null;
    minutes = eventMinutes(ha, at, rise);
    return minutes / 60;
  };
  const sunrise = refine(true);
  const sunset = refine(false);
  if (sunrise === null || sunset === null) {
    // The refinement crossed into a polar regime (only happens within minutes of the boundary).
    return { sunrise: null, sunset: null, solarNoon: solarNoonMinutes / 60, dayLength: first > 90 ? 24 : 0, declination };
  }
  return { sunrise, sunset, solarNoon: solarNoonMinutes / 60, dayLength: sunset - sunrise, declination };
}
