/**
 * MockAudioContext (Phase 20): a Web Audio stand-in for the audio suites, as MockGPUDevice is for the
 * renderer. It models what the engine's audio code depends on, strictly enough to catch the bugs that
 * only show up as clicks, silence or leaks on a real device:
 *
 *  - **The node graph.** Every node records its outputs; `reachesDestination`, `pathGain` (the product
 *    of every gain on every path to the speakers, at a time) and `connectedNodes` answer "is this
 *    audible, how loud, and did dispose disconnect it".
 *  - **Automation timelines.** `AudioParam` keeps the event list (`setValueAtTime`, linear and
 *    exponential ramps, `setTargetAtTime`, `cancelScheduledValues`, `cancelAndHoldAtTime`) and
 *    `valueAt(t)` evaluates it. A ramp with no event before it starts from time 0 and the param's
 *    default value — the oldest browser behaviour and the worst case — so a fade must be anchored with
 *    `setValueAtTime(current, now)` to start where it should; the engine anchors every ramp.
 *  - **Time and playback.** `currentTime` only advances (`advance(seconds)`) while the context is
 *    `running`, as on a device under the autoplay policy. Buffer sources and oscillators end at their
 *    stop time, or a one-shot buffer at its natural end, and fire `onended` once.
 *  - **Decoding.** `decodeAudioData` accepts buffers made by `encodeMockAudio` and rejects anything
 *    else with an `EncodingError`, like a corrupt file.
 *  - **Media elements** for streaming: `createMediaElement()` gives an element whose `play()` can be
 *    refused by the autoplay policy (`autoplayBlocked`).
 *
 * Nothing here is used at run time.
 */

type ParamEvent =
  | { kind: "set"; value: number; time: number }
  | { kind: "linear" | "exponential"; value: number; time: number }
  | { kind: "target"; value: number; time: number; timeConstant: number };

export class MockAudioParam {
  readonly events: ParamEvent[] = [];
  private intrinsic: number;
  constructor(
    private readonly context: MockAudioContext,
    readonly name: string,
    readonly defaultValue: number,
    readonly minValue = -3.4028234663852886e38,
    readonly maxValue = 3.4028234663852886e38,
  ) {
    this.intrinsic = defaultValue;
  }
  get value(): number {
    return this.valueAt(this.context.currentTime);
  }
  set value(v: number) {
    // Setting .value is setValueAtTime(v, currentTime) in the current specification.
    this.setValueAtTime(v, this.context.currentTime);
  }
  private insert(e: ParamEvent): this {
    if (!Number.isFinite(e.value) || !Number.isFinite(e.time) || e.time < 0) throw new RangeError(`${this.name}: non-finite or negative automation (${e.value} at ${e.time})`);
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.time > e.time) i--;
    this.events.splice(i, 0, e);
    return this;
  }
  setValueAtTime(value: number, time: number): this {
    return this.insert({ kind: "set", value, time });
  }
  linearRampToValueAtTime(value: number, time: number): this {
    return this.insert({ kind: "linear", value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    if (value === 0) throw new RangeError(`${this.name}: exponential ramp to 0`);
    return this.insert({ kind: "exponential", value, time });
  }
  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    if (!(timeConstant > 0)) throw new RangeError(`${this.name}: timeConstant must be > 0`);
    return this.insert({ kind: "target", value, time, timeConstant });
  }
  cancelScheduledValues(time: number): this {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.time >= time) this.events.splice(i, 1);
    return this;
  }
  cancelAndHoldAtTime(time: number): this {
    const held = this.valueAt(time);
    this.cancelScheduledValues(time);
    return this.setValueAtTime(held, time);
  }
  /** The automated value at `time` (seconds of context time). */
  valueAt(time: number): number {
    let curV = this.intrinsic;
    let curT = 0;
    let target: { value: number; time: number; tc: number; from: number } | null = null;
    const at = (t: number): number => (target && t >= target.time ? target.value + (target.from - target.value) * Math.exp(-(t - target.time) / target.tc) : curV);
    for (const e of this.events) {
      if (e.kind === "set") {
        if (e.time > time) return at(time);
        curV = e.value;
        curT = e.time;
        target = null;
      } else if (e.kind === "target") {
        if (e.time > time) return at(time);
        target = { value: e.value, time: e.time, tc: e.timeConstant, from: at(e.time) };
        curT = e.time;
      } else {
        const t0 = curT;
        const v0 = at(t0);
        if (time < e.time) {
          if (time < t0) return at(time);
          const f = e.time > t0 ? (time - t0) / (e.time - t0) : 1;
          return e.kind === "linear" ? v0 + (e.value - v0) * f : v0 * Math.pow(e.value / v0, f);
        }
        curV = e.value;
        curT = e.time;
        target = null;
      }
    }
    return at(time);
  }
}

let nextNodeId = 1;

export class MockAudioNode {
  readonly id = nextNodeId++;
  readonly outputs = new Set<MockAudioNode | MockAudioParam>();
  constructor(
    readonly context: MockAudioContext,
    readonly kind: string,
  ) {
    context.nodes.push(this);
  }
  connect<T extends MockAudioNode | MockAudioParam>(destination: T): T {
    if (destination instanceof MockAudioNode && destination.context !== this.context) throw new Error("InvalidAccessError: nodes from different contexts");
    this.outputs.add(destination);
    return destination;
  }
  disconnect(destination?: MockAudioNode | MockAudioParam): void {
    if (destination === undefined) this.outputs.clear();
    else if (!this.outputs.delete(destination)) throw new Error("InvalidAccessError: not connected to that destination");
  }
  protected param(name: string, value: number, min?: number, max?: number): MockAudioParam {
    return new MockAudioParam(this.context, `${this.kind}.${name}`, value, min, max);
  }
}

export class MockGainNode extends MockAudioNode {
  readonly gain = this.param("gain", 1);
  constructor(c: MockAudioContext) {
    super(c, "gain");
  }
}

export class MockBiquadFilterNode extends MockAudioNode {
  type: BiquadFilterType = "lowpass";
  readonly frequency = this.param("frequency", 350, 0, 24000);
  readonly Q = this.param("Q", 1);
  readonly gain = this.param("gain", 0);
  readonly detune = this.param("detune", 0);
  constructor(c: MockAudioContext) {
    super(c, "biquad");
  }
}

export class MockDelayNode extends MockAudioNode {
  readonly delayTime = this.param("delayTime", 0, 0, 180);
  constructor(c: MockAudioContext, readonly maxDelayTime = 1) {
    super(c, "delay");
  }
}

export class MockConvolverNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
  normalize = true;
  constructor(c: MockAudioContext) {
    super(c, "convolver");
  }
}

export class MockDynamicsCompressorNode extends MockAudioNode {
  readonly threshold = this.param("threshold", -24);
  readonly knee = this.param("knee", 30);
  readonly ratio = this.param("ratio", 12);
  readonly attack = this.param("attack", 0.003);
  readonly release = this.param("release", 0.25);
  constructor(c: MockAudioContext) {
    super(c, "compressor");
  }
}

export class MockPannerNode extends MockAudioNode {
  panningModel: PanningModelType = "equalpower";
  distanceModel: DistanceModelType = "inverse";
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  coneInnerAngle = 360;
  coneOuterAngle = 360;
  coneOuterGain = 0;
  readonly positionX = this.param("positionX", 0);
  readonly positionY = this.param("positionY", 0);
  readonly positionZ = this.param("positionZ", 0);
  readonly orientationX = this.param("orientationX", 1);
  readonly orientationY = this.param("orientationY", 0);
  readonly orientationZ = this.param("orientationZ", 0);
  constructor(c: MockAudioContext) {
    super(c, "panner");
  }
}

/** A scheduled source: buffer source, oscillator, or media element source. */
abstract class MockScheduledNode extends MockAudioNode {
  startTime: number | null = null;
  stopTime: number | null = null;
  offset = 0;
  ended = false;
  onended: ((this: unknown, ev: Event) => unknown) | null = null;
  endedCount = 0;
  start(when = 0, offset = 0): void {
    if (this.startTime !== null) throw new Error(`InvalidStateError: ${this.kind} started twice`);
    this.startTime = Math.max(when, this.context.currentTime);
    this.offset = offset;
    this.context.scheduled.add(this);
  }
  stop(when = 0): void {
    if (this.startTime === null) throw new Error(`InvalidStateError: ${this.kind} stopped before start`);
    this.stopTime = Math.max(when, this.context.currentTime);
  }
  /** Context time at which this source finishes on its own (Infinity for loops and oscillators). */
  abstract naturalEnd(): number;
  tick(now: number): void {
    if (this.ended || this.startTime === null) return;
    const end = Math.min(this.stopTime ?? Infinity, this.naturalEnd());
    if (now >= end) {
      this.ended = true;
      this.endedCount++;
      this.context.scheduled.delete(this);
      this.onended?.call(this, { type: "ended" } as Event);
    }
  }
}

export class MockAudioBufferSourceNode extends MockScheduledNode {
  buffer: MockAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = this.param("playbackRate", 1);
  readonly detune = this.param("detune", 0);
  constructor(c: MockAudioContext) {
    super(c, "bufferSource");
  }
  naturalEnd(): number {
    if (this.loop || !this.buffer) return this.loop ? Infinity : this.startTime!;
    return this.startTime! + Math.max(0, this.buffer.duration - this.offset) / Math.max(1e-6, this.playbackRate.value);
  }
}

export class MockOscillatorNode extends MockScheduledNode {
  type: OscillatorType = "sine";
  readonly frequency = this.param("frequency", 440);
  readonly detune = this.param("detune", 0);
  constructor(c: MockAudioContext) {
    super(c, "oscillator");
  }
  naturalEnd(): number {
    return Infinity;
  }
}

export class MockMediaElementAudioSourceNode extends MockAudioNode {
  constructor(c: MockAudioContext, readonly mediaElement: MockMediaElement) {
    super(c, "mediaElementSource");
    if (mediaElement.sourceNode) throw new Error("InvalidStateError: media element already has a source node");
    mediaElement.sourceNode = this;
  }
}

export class MockAudioBuffer {
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    if (numberOfChannels < 1 || length < 1 || sampleRate < 3000) throw new Error("NotSupportedError: bad buffer shape");
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    const d = this.data[channel];
    if (!d) throw new Error(`IndexSizeError: channel ${channel}`);
    return d;
  }
}

export class MockAudioListener {
  readonly positionX: MockAudioParam;
  readonly positionY: MockAudioParam;
  readonly positionZ: MockAudioParam;
  readonly forwardX: MockAudioParam;
  readonly forwardY: MockAudioParam;
  readonly forwardZ: MockAudioParam;
  readonly upX: MockAudioParam;
  readonly upY: MockAudioParam;
  readonly upZ: MockAudioParam;
  constructor(c: MockAudioContext) {
    const p = (n: string, v: number): MockAudioParam => new MockAudioParam(c, `listener.${n}`, v);
    this.positionX = p("positionX", 0);
    this.positionY = p("positionY", 0);
    this.positionZ = p("positionZ", 0);
    this.forwardX = p("forwardX", 0);
    this.forwardY = p("forwardY", 0);
    this.forwardZ = p("forwardZ", -1);
    this.upX = p("upX", 0);
    this.upY = p("upY", 1);
    this.upZ = p("upZ", 0);
  }
}

/** A media element for streaming tests: `play()` honours the context's autoplay policy. */
export class MockMediaElement {
  src = "";
  loop = false;
  volume = 1;
  paused = true;
  currentTime = 0;
  crossOrigin: string | null = null;
  preload = "auto";
  sourceNode: MockMediaElementAudioSourceNode | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(private readonly context: MockAudioContext) {}
  play(): Promise<void> {
    if (this.context.autoplayBlocked) return Promise.reject(Object.assign(new Error("play() was refused by the autoplay policy"), { name: "NotAllowedError" }));
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {
    this.currentTime = 0;
  }
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** Fire an element event (`ended`, `error`, …) as the browser would. */
  dispatch(type: string): void {
    if (type === "ended") this.paused = true;
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  listenerCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

const MOCK_AUDIO_MAGIC = 0x4d4f434b; // "MOCK"

/** Encode a fake audio file that `MockAudioContext.decodeAudioData` decodes to a buffer of that shape. */
export function encodeMockAudio(shape: { channels?: number; sampleRate?: number; seconds: number }): ArrayBuffer {
  const out = new ArrayBuffer(16);
  const v = new DataView(out);
  v.setUint32(0, MOCK_AUDIO_MAGIC);
  v.setUint32(4, shape.channels ?? 2);
  v.setUint32(8, shape.sampleRate ?? 48000);
  v.setFloat32(12, shape.seconds);
  return out;
}

export class MockAudioContext {
  readonly nodes: MockAudioNode[] = [];
  readonly scheduled = new Set<MockScheduledNode>();
  readonly destination: MockAudioNode;
  readonly listener: MockAudioListener;
  readonly sampleRate: number;
  currentTime = 0;
  state: AudioContextState = "suspended";
  /** When true, media elements refuse `play()` (no user gesture yet). */
  autoplayBlocked = false;
  decodeCalls = 0;
  onstatechange: (() => void) | null = null;

  constructor(options: { sampleRate?: number; state?: AudioContextState } = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.state = options.state ?? "suspended";
    this.destination = new MockAudioNode(this, "destination");
    this.listener = new MockAudioListener(this);
  }

  createGain(): MockGainNode {
    return new MockGainNode(this);
  }
  createBiquadFilter(): MockBiquadFilterNode {
    return new MockBiquadFilterNode(this);
  }
  createDelay(maxDelayTime = 1): MockDelayNode {
    return new MockDelayNode(this, maxDelayTime);
  }
  createConvolver(): MockConvolverNode {
    return new MockConvolverNode(this);
  }
  createDynamicsCompressor(): MockDynamicsCompressorNode {
    return new MockDynamicsCompressorNode(this);
  }
  createPanner(): MockPannerNode {
    return new MockPannerNode(this);
  }
  createBufferSource(): MockAudioBufferSourceNode {
    return new MockAudioBufferSourceNode(this);
  }
  createOscillator(): MockOscillatorNode {
    return new MockOscillatorNode(this);
  }
  createMediaElementSource(element: MockMediaElement): MockMediaElementAudioSourceNode {
    return new MockMediaElementAudioSourceNode(this, element);
  }
  createBuffer(channels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
  /** A media element bound to this context's autoplay policy (what `document.createElement("audio")` gives). */
  createMediaElement(): MockMediaElement {
    return new MockMediaElement(this);
  }
  decodeAudioData(data: ArrayBuffer): Promise<MockAudioBuffer> {
    this.decodeCalls++;
    if (this.state === "closed") return Promise.reject(Object.assign(new Error("decode on a closed context"), { name: "InvalidStateError" }));
    if (data.byteLength === 0) return Promise.reject(Object.assign(new TypeError("detached or empty buffer"), { name: "DataCloneError" }));
    const v = new DataView(data);
    if (data.byteLength < 16 || v.getUint32(0) !== MOCK_AUDIO_MAGIC) return Promise.reject(Object.assign(new Error("Unable to decode audio data"), { name: "EncodingError" }));
    const sampleRate = v.getUint32(8);
    return Promise.resolve(new MockAudioBuffer(v.getUint32(4), Math.max(1, Math.round(v.getFloat32(12) * sampleRate)), sampleRate));
  }
  resume(): Promise<void> {
    if (this.state === "closed") return Promise.reject(new Error("InvalidStateError: closed"));
    this.setState("running");
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    if (this.state === "closed") return Promise.reject(new Error("InvalidStateError: closed"));
    this.setState("suspended");
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.setState("closed");
    return Promise.resolve();
  }
  private setState(s: AudioContextState): void {
    if (this.state === s) return;
    this.state = s;
    this.onstatechange?.();
  }

  /** Advance context time (only while running) and end the sources due by then. */
  advance(seconds: number): void {
    if (this.state !== "running") return;
    this.currentTime += seconds;
    for (const s of [...this.scheduled]) s.tick(this.currentTime);
  }

  // -------------------------------------------------------------- graph queries

  /** True when audio from `node` reaches the destination through node connections. */
  reachesDestination(node: MockAudioNode): boolean {
    return this.paths(node).length > 0;
  }
  /** Every node path from `node` to the destination. */
  paths(node: MockAudioNode): MockAudioNode[][] {
    const out: MockAudioNode[][] = [];
    const walk = (n: MockAudioNode, trail: MockAudioNode[]): void => {
      if (trail.includes(n)) return; // feedback loop (a delay's feedback)
      const next = [...trail, n];
      if (n === this.destination) {
        out.push(next);
        return;
      }
      for (const o of n.outputs) if (o instanceof MockAudioNode) walk(o, next);
    };
    walk(node, []);
    return out;
  }
  /**
   * Sum over every path from `node` to the destination of the product of the gain values on it at
   * `time` (default now). 0 means inaudible; a GainNode at 0.5 on the only path gives 0.5.
   */
  pathGain(node: MockAudioNode, time = this.currentTime): number {
    let sum = 0;
    for (const path of this.paths(node)) {
      let g = 1;
      for (const n of path) if (n instanceof MockGainNode) g *= n.gain.valueAt(time);
      sum += g;
    }
    return sum;
  }
  /** Nodes with at least one outgoing connection (a leak check after dispose). */
  connectedNodes(): MockAudioNode[] {
    return this.nodes.filter((n) => n.outputs.size > 0);
  }
  nodesOfKind(kind: string): MockAudioNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }
}

/** A mock context typed as the DOM `AudioContext`, for code under test. */
export function createMockAudio(options: { sampleRate?: number; state?: AudioContextState } = {}): { mock: MockAudioContext; context: AudioContext } {
  const mock = new MockAudioContext(options);
  return { mock, context: mock as unknown as AudioContext };
}
