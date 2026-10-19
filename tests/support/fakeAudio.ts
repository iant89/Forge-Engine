/**
 * A recording stand-in for a WebAudio context, for the audio suites: every node it creates is kept
 * in `nodes` with its connections, parameter targets, starts and stops, so a test can assert on the
 * graph a soundscape builds without a browser. `end(node)` fires a source's `onended`.
 */

export interface FakeParam { value: number; targets: number[]; setTargetAtTime(v: number): void; setValueAtTime(v: number): void; linearRampToValueAtTime(v: number): void; exponentialRampToValueAtTime(v: number): void; cancelScheduledValues(): void }
export interface FakeNode { kind: string; type?: string; connected: FakeNode[]; disconnected: number; connect(n: FakeNode): FakeNode; disconnect(): void; [key: string]: unknown }

export interface FakeAudioOptions {
  state?: "running" | "suspended" | "closed";
  /** Bytes → decoded frames (default: 1 frame per byte, mono, 8 kHz); throw to fail a decode. */
  decode?: (data: ArrayBuffer) => { frames: number; channels?: number; rate?: number };
}

export function fakeAudioContext(options: FakeAudioOptions = {}) {
  const nodes: FakeNode[] = [];
  const param = (value = 0): FakeParam => ({
    value,
    targets: [],
    setTargetAtTime(v) { this.targets.push(v); },
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.targets.push(v); },
    exponentialRampToValueAtTime(v) { this.targets.push(v); },
    cancelScheduledValues() {},
  });
  const node = (kind: string, extra: Record<string, unknown> = {}): FakeNode => {
    const n: FakeNode = {
      kind,
      connected: [],
      disconnected: 0,
      connect(t) { this.connected.push(t); return t; },
      disconnect() { this.disconnected++; },
      ...extra,
    };
    nodes.push(n);
    return n;
  };
  const source = (kind: string, extra: Record<string, unknown> = {}) =>
    node(kind, { started: [] as number[], stopped: 0, onended: null, start(t = 0) { (this.started as number[]).push(t); }, stop() { this.stopped = (this.stopped as number) + 1; }, ...extra });
  const buffer = (channels: number, length: number, sampleRate: number) => {
    const data = Array.from({ length: Math.max(0, channels) }, () => new Float32Array(Math.max(0, length)));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (i = 0) => data[i] ?? new Float32Array(0) };
  };
  const ctx = {
    currentTime: 0,
    sampleRate: 48_000,
    destination: node("destination"),
    createGain: () => node("gain", { gain: param(1) }),
    createBiquadFilter: () => node("filter", { type: "lowpass", frequency: param(350), Q: param(1) }),
    createOscillator: () => source("oscillator", { type: "sine", frequency: param(440) }),
    createBufferSource: () => source("buffer", { buffer: null, loop: false, playbackRate: param(1), detune: param(0) }),
    createStereoPanner: () => node("stereoPanner", { pan: param(0) }),
    createConvolver: () => node("convolver", { buffer: null }),
    createPanner: () => node("panner", { positionX: param(), positionY: param(), positionZ: param(), orientationX: param(1), orientationY: param(), orientationZ: param() }),
    createBuffer: (c: number, n: number, rate: number) => buffer(c, n, rate),
    state: options.state ?? "running",
    listener: { positionX: param(), positionY: param(), positionZ: param(), forwardX: param(), forwardY: param(), forwardZ: param(-1), upX: param(), upY: param(1), upZ: param() },
    decoded: 0,
    closed: 0,
    decodeAudioData(data: ArrayBuffer): Promise<ReturnType<typeof buffer>> {
      this.decoded++;
      try {
        const d = options.decode ? options.decode(data) : { frames: data.byteLength };
        return Promise.resolve(buffer(d.channels ?? 1, d.frames, d.rate ?? 8000));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    resume() { this.state = "running"; return Promise.resolve(); },
    suspend() { this.state = "suspended"; return Promise.resolve(); },
    close() { this.closed++; this.state = "closed"; return Promise.resolve(); },
  };
  return { ctx, nodes, param };
}

/** Fire a scheduled source's `onended` as the browser would after its stop time. */
export function end(node: FakeNode): void {
  const handler = node["onended"];
  if (typeof handler === "function") (handler as () => void).call(node);
}
