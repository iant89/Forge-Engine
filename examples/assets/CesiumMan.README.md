# CesiumMan.glb

- **Source:** Khronos glTF-Sample-Assets, `Models/CesiumMan/glTF-Binary/CesiumMan.glb`
  (https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan), fetched 2026-10-13.
  SHA-256 `b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9`.
- **Author:** © 2017 Cesium (https://cesium.com).
- **License:** Creative Commons Attribution 4.0 International (CC-BY-4.0),
  https://creativecommons.org/licenses/by/4.0/legalcode. The Cesium logo in the texture is a
  trademark of Cesium and is excluded from that license (Khronos `LicenseRef-LegalMark-Cesium`);
  it is shipped only as part of the unmodified sample and is not used as branding.
- **Modifications:** none — the file is unmodified.

## How the engine uses it

The `gltf-skin` demo loads it with `?scene=gltf-skin&model=cesium`, and `npm run check:browser:gltf-skin`
checks it on a real adapter: one mesh, a 19-joint skin and a 2 s walk clip (`animation-0`, 57 channels).
The material references a base-colour texture, which glTF image/material import (16.1c) does not
support yet, so the model draws with its **base-colour factor only** (plain white, lit).
