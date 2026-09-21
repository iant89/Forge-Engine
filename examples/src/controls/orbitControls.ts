/**
 * Lightweight orbit camera controller for interactive scene inspection.
 *
 * Orbit around a target point, zoom with wheel / pinch, pan with right-click or keys.
 */
import { Vec3, type Entity } from "@forge/engine";

export class OrbitControls {
  target = new Vec3(0, 1.2, 0);
  distance = 12;
  azimuth = 0.4;
  elevation = 0.35;

  minDistance = 2;
  maxDistance = 50;
  minElevation = -Math.PI / 2 + 0.05;
  maxElevation = Math.PI / 2 - 0.05;

  private dragging = false;
  private dragMode: "orbit" | "pan" = "orbit";
  private lastX = 0;
  private lastY = 0;
  private initialPinchDist = 0;
  private canvas: HTMLElement;
  private cameraEntity: Entity;

  constructor(cameraEntity: Entity, canvas: HTMLElement) {
    this.cameraEntity = cameraEntity;
    this.canvas = canvas;
    this.bindEvents();
    this.update();
  }

  update(): void {
    const cosEle = Math.cos(this.elevation);
    const sinEle = Math.sin(this.elevation);
    const cosAzi = Math.cos(this.azimuth);
    const sinAzi = Math.sin(this.azimuth);

    // Negative Z is in front of the scene facing +Z
    const eyeX = this.target.x + this.distance * cosEle * sinAzi;
    const eyeY = this.target.y + this.distance * sinEle;
    const eyeZ = this.target.z - this.distance * cosEle * cosAzi;

    this.cameraEntity.transform.position = new Vec3(eyeX, eyeY, eyeZ);
    this.cameraEntity.transform.lookAt(this.target);
  }

  private bindEvents(): void {
    const c = this.canvas;

    c.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.dragMode = e.button === 2 ? "pan" : "orbit";
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });

    window.addEventListener("mouseup", () => {
      this.dragging = false;
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      if (this.dragMode === "orbit") {
        this.azimuth += dx * 0.008;
        this.elevation = Math.max(this.minElevation, Math.min(this.maxElevation, this.elevation + dy * 0.008));
      } else {
        // Pan parallel to view
        const cosAzi = Math.cos(this.azimuth);
        const sinAzi = Math.sin(this.azimuth);
        this.target.x -= (dx * cosAzi - dy * sinAzi) * 0.01;
        this.target.y += dy * 0.01;
        this.target.z += (dx * sinAzi + dy * cosAzi) * 0.01;
      }
      this.update();
    });

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY * 0.005;
      this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance * (1 + delta)));
      this.update();
    }, { passive: false });

    c.addEventListener("contextmenu", (e) => e.preventDefault());

    // Touch support
    c.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        this.dragging = true;
        this.dragMode = "orbit";
        this.lastX = e.touches[0]!.clientX;
        this.lastY = e.touches[0]!.clientY;
      } else if (e.touches.length === 2) {
        this.dragging = false;
        const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
        const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
        this.initialPinchDist = Math.hypot(dx, dy);
      }
    });

    c.addEventListener("touchmove", (e) => {
      if (e.touches.length === 1 && this.dragging) {
        const dx = e.touches[0]!.clientX - this.lastX;
        const dy = e.touches[0]!.clientY - this.lastY;
        this.lastX = e.touches[0]!.clientX;
        this.lastY = e.touches[0]!.clientY;
        this.azimuth += dx * 0.008;
        this.elevation = Math.max(this.minElevation, Math.min(this.maxElevation, this.elevation + dy * 0.008));
        this.update();
      } else if (e.touches.length === 2 && this.initialPinchDist > 0) {
        const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
        const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
        const dist = Math.hypot(dx, dy);
        const factor = this.initialPinchDist / dist;
        this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance * factor));
        this.initialPinchDist = dist;
        this.update();
      }
    }, { passive: true });

    c.addEventListener("touchend", () => {
      this.dragging = false;
      this.initialPinchDist = 0;
    });
  }
}
