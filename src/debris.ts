import * as THREE from "three";
import type { Physics } from "./physics";

// ---------------------------------------------------------------------------
// Dirt/rock debris flung from an impact: small dynamic Rapier bodies with ball
// colliders, kicked outward + up, tumbling, then faded out by the physics
// registry (per-kind cap + lifetime). A few shared chunk geometries + one dirt
// material; prewarmed so the first burst doesn't compile a shader.
// ---------------------------------------------------------------------------

export interface DebrisSystem {
  spawn(point: THREE.Vector3, radius: number, now: number): void;
}

const _dir = new THREE.Vector3();

export function createDebris(scene: THREE.Scene, physics: Physics): DebrisSystem {
  const RAPIER = physics.RAPIER;
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6e5535,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
  });
  const geos = [
    new THREE.IcosahedronGeometry(0.72, 0),
    new THREE.TetrahedronGeometry(0.92),
    new THREE.DodecahedronGeometry(0.66, 0),
  ];

  // Prewarm: keep one chunk in-scene (parked) so its program is compiled before
  // the main compileAsync pass.
  const warm = new THREE.Mesh(geos[0], mat);
  warm.position.set(0, -9999, 0);
  scene.add(warm);

  function spawn(point: THREE.Vector3, radius: number, now: number): void {
    const count = Math.round(THREE.MathUtils.clamp(8 + radius * 0.7, 12, 18));
    for (let i = 0; i < count; i++) {
      const geo = geos[i % geos.length];
      const mesh = new THREE.Mesh(geo, mat);
      const s = 0.6 + Math.random() * 1.1;
      mesh.scale.setScalar(s);
      mesh.castShadow = true;
      scene.add(mesh);

      const ox = (Math.random() - 0.5) * radius * 0.5;
      const oz = (Math.random() - 0.5) * radius * 0.5;
      const px = point.x + ox;
      const py = point.y + 0.6 + Math.random() * 1.2;
      const pz = point.z + oz;

      _dir.set(ox, 0, oz);
      if (_dir.lengthSq() < 1e-4) _dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      _dir.normalize();
      const sp = radius * (0.7 + Math.random() * 1.3);
      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(px, py, pz)
          .setLinvel(_dir.x * sp, sp * (0.7 + Math.random() * 0.9), _dir.z * sp)
          .setAngvel({ x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 12 })
          .setLinearDamping(0.1)
          .setAngularDamping(0.2),
      );
      physics.world.createCollider(
        RAPIER.ColliderDesc.ball(0.62 * s).setRestitution(0.25).setFriction(0.8).setDensity(3),
        body,
      );

      physics.add({
        body,
        object: mesh,
        kind: "debris",
        bornAt: now,
        maxLife: 4.5 + Math.random(),
        fade: 1.0,
        onExpire: () => scene.remove(mesh),
      });
    }
  }

  return { spawn };
}
