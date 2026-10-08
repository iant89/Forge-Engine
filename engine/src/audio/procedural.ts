export interface ThunderOptions {
  duration?: number;
  seed?: number;
  energy?: number;
}

/** Build a deterministic thunder crack + rolling low-frequency tail without an asset download. */
export function createThunderBuffer(context: BaseAudioContext, options: ThunderOptions = {}): AudioBuffer {
  const duration = Math.max(0.5, options.duration ?? 4.5);
  const energy = Math.max(0.1, Math.min(3, options.energy ?? 1));
  const sampleRate = context.sampleRate;
  const buffer = context.createBuffer(1, Math.ceil(duration * sampleRate), sampleRate);
  const data = buffer.getChannelData(0);
  let state = (options.seed ?? 0x71a9b3) >>> 0;
  let low = 0;
  let lower = 0;
  for (let i = 0; i < data.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const white = (state >>> 0) / 0x80000000 - 1;
    low += 0.035 * (white - low);
    lower += 0.006 * (low - lower);
    const t = i / sampleRate;
    const crack = Math.exp(-t * 38) * white * 0.9;
    const roll = Math.exp(-t * 0.72) * (lower * 5 + low * 0.65);
    const echoes = (t > 0.18 ? Math.exp(-(t - 0.18) * 2.2) * low * 0.45 : 0)
      + (t > 0.53 ? Math.exp(-(t - 0.53) * 1.5) * lower * 1.8 : 0);
    data[i] = Math.max(-1, Math.min(1, (crack + roll + echoes) * energy));
  }
  return buffer;
}
