/**
 * A recording stand-in for a WebAudio context, for the audio suites: every node it creates is kept
 * in `nodes` with its connections, parameter targets, starts and stops, so a test can assert on the
 * graph a soundscape builds without a browser. `end(node)` fires a source's `onended`.
 */

export interface FakeParam { value: number; targets: number[]; setTargetAtTime(v: number): void; setValueAtTime(v: number): void; linearRampToValueAtTime(v: number): void; exponentialRampToValueAtTime(v: number): void }
export interface FakeNode { kind: string; type?: string; connected: FakeNode[]; disconnected: number; connect(n: FakeNode): FakeNode; disconnect(): void; [key: string]: unknown }

export function fakeAudioContext() {
  const nodes: FakeNode[] = [];
  const param = (value = 0): FakeParam => ({
    value,
    targets: [],
    setTargetAtTime(v) { this.targets.push(v); },
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.targets.push(v); },
    exponentialRampToValueAtTime(v) { this.targets.push(v); },
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
  const ctx = {
    currentTime: 0,
    sampleRate: 8000,
    destination: node("destination"),
    createGain: () => node("gain", { gain: param(1) }),
    createBiquadFilter: () => node("filter", { type: "lowpass", frequency: param(350), Q: param(1) }),
    createOscillator: () => source("oscillator", { type: "sine", frequency: param(440) }),
    createBufferSource: () => source("buffer", { buffer: null, loop: false }),
    createPanner: () => node("panner", { positionX: param(), positionY: param(), positionZ: param() }),
    createBuffer: (_c: number, n: number, rate: number) => { const d = new Float32Array(n); return { duration: n / rate, getChannelData: () => d }; },
  };
  return { ctx, nodes };
}

/** Fire a scheduled source's `onended` as the browser would after its stop time. */
export function end(node: FakeNode): void {
  const handler = node["onended"];
  if (typeof handler === "function") (handler as () => void).call(node);
}
