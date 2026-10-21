/**
 * Reviewed 1.0 API example: build a scene using only the package root.
 *
 * Run the same factory from a browser host after creating a Renderer/Engine for that host. Keeping
 * scene construction separate from GPU setup makes the example useful in tests and worker-backed
 * games too.
 */
import { Camera, Scene, Transform, Vec3 } from "@forge/engine";

export function createHelloWorldScene(): Scene {
  const scene = new Scene({ name: "hello-world" });
  const cameraEntity = scene.createTransformedEntity("main-camera", new Vec3(0, 2, 6));
  cameraEntity.add(new Camera());

  const player = scene.createEntity("player");
  player.add(new Transform()).setPosition(0, 0, 0);
  return scene;
}
