/**
 * AudioParam scheduling helpers (Phase 20). Every gradual change in the audio code goes through
 * `rampParam`, because an unanchored `linearRampToValueAtTime` ramps from the *previous automation
 * event* — which, after a `cancelScheduledValues` or on a param that was only ever assigned `.value`,
 * is wherever (and whenever) the browser decides: a fade-out that should start at the voice's level
 * jumps first, which is a click. Anchoring the current value at `now` makes the ramp start where the
 * param is, on every engine.
 */

/** Ramp `param` from its current value at `now` to `target` over `seconds` (0 = set at `now`). */
export function rampParam(param: AudioParam, target: number, now: number, seconds: number): void {
  holdParam(param, now);
  if (seconds > 0) param.linearRampToValueAtTime(target, now + seconds);
  else param.setValueAtTime(target, now);
}

/** Drop automation after `now` and hold the value the param has at `now`. */
export function holdParam(param: AudioParam, now: number): void {
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof p.cancelAndHoldAtTime === "function") {
    p.cancelAndHoldAtTime(now);
  } else {
    // Firefox has no cancelAndHoldAtTime: read the value first, then cancel and anchor it.
    const value = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
  }
}
