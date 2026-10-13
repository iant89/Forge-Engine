/** Injected by `vite.config.ts` (`define`); absent when the module is loaded outside Vite (tests). */
declare const __FORGE_BUILD__: string | undefined;

/** Short commit id of the running bundle, shown on the HUD so device reports name their build. */
export const FORGE_BUILD: string = typeof __FORGE_BUILD__ === "string" && __FORGE_BUILD__ ? __FORGE_BUILD__ : "dev";
