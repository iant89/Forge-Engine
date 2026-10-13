/**
 * @suite examples:buildInfo
 * @group unit
 * @covers examples/src/buildInfo.ts
 * @desc Pins the HUD build stamp: outside Vite the id falls back to "dev", and the Vite config injects a short commit id so a device screenshot names the deploy it came from
 */

export const suite = {
  name: "examples:buildInfo",
  group: "unit",
  covers: [
    "examples/src/buildInfo.ts",
  ],
  desc: "Pins the HUD build stamp: outside Vite the id falls back to \"dev\", and the Vite config injects a short commit id so a device screenshot names the deploy it came from",
};

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish, group, test } from "selrun";
import { FORGE_BUILD } from "../../examples/src/buildInfo.js";

group("HUD build stamp", () => {
  test("outside Vite the stamp is the dev fallback, never undefined", () => {
    assert.equal(FORGE_BUILD, "dev");
  });

  test("the Vite config defines __FORGE_BUILD__ from GITHUB_SHA or git", () => {
    const config = readFileSync(new URL("../../examples/vite.config.ts", import.meta.url), "utf8");
    assert.match(config, /__FORGE_BUILD__: JSON\.stringify\(buildId\(\)\)/);
    assert.match(config, /process\.env\.GITHUB_SHA/);
  });

  test("the HUD device line and the iOS report both carry the stamp", () => {
    const main = readFileSync(new URL("../../examples/src/main.ts", import.meta.url), "utf8");
    assert.match(main, /dpr \$\{[^}]+\}  build \$\{FORGE_BUILD\}/);
    const report = readFileSync(new URL("../../examples/src/diag/iosReport.ts", import.meta.url), "utf8");
    assert.match(report, /`build \$\{FORGE_BUILD\}`/);
  });
});

finish();
