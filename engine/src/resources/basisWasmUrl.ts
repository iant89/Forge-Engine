/// <reference path="./basisWasm.d.ts" />

/** Bundler-only WASM URL import, kept behind a dynamic import so Node tools can load the engine barrel. */
import wasmUrl from "@h00w/basis-universal-transcoder/basis_capi_transcoder.wasm?url";

export default wasmUrl;
