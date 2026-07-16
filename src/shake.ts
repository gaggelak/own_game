import * as THREE from "three";

// Trauma-based camera shake, shared by every source that jolts the view (meteor
// blasts, electric bursts). Each source pushes trauma in; the offset falls off
// with trauma² so small hits barely register and big ones kick hard. One shared
// instance means overlapping events build on the same shake instead of two rigs
// fighting over the camera.
export class CameraShake {
  private trauma = 0;
  private readonly offset = new THREE.Vector3();

  constructor(
    private readonly mag = 1.4,
    private readonly decay = 1.5,
  ) {}

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt: number, time: number): void {
    this.trauma = Math.max(0, this.trauma - dt * this.decay);
    const s = this.trauma * this.trauma * this.mag;
    this.offset.set(
      Math.sin(time * 47.0) * s,
      Math.sin(time * 53.0 + 1.3) * s,
      Math.sin(time * 59.0 + 2.7) * s,
    );
  }

  getOffset(out: THREE.Vector3): void {
    out.copy(this.offset);
  }
}
