import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { buildTerrainCollider } from "./terrain";

// ---------------------------------------------------------------------------
// Rapier owner: one world, a registry of dynamic bodies paired with Three
// objects, fixed-step integration, per-kind caps + lifetime culling, and a
// radial impulse used for the meteor blast. The terrain is a single fixed
// heightfield collider. Nothing here allocates per frame.
// ---------------------------------------------------------------------------

export type PhysicsKind = "meteor" | "debris" | "prop" | "gib";

export interface PhysicsHandle {
  body: RAPIER.RigidBody;
  object: THREE.Object3D;
  kind: PhysicsKind;
  bornAt: number; // world-clock seconds
  maxLife?: number; // auto-cull after this many seconds
  fade?: number; // shrink to nothing over the last `fade` seconds of life
  onExpire?: () => void; // called right before the body+object are dropped
  _baseScale?: number; // captured when fading begins
  _evicting?: boolean; // cap exceeded — fading out instead of popping
  // Physics transform from just before the last fixed step, so the render can
  // interpolate toward the current one (smooth on high-refresh displays).
  _px?: number; _py?: number; _pz?: number;
  _qx?: number; _qy?: number; _qz?: number; _qw?: number;
}

export interface Physics {
  world: RAPIER.World;
  RAPIER: typeof RAPIER;
  step(dt: number, now: number): void;
  add(h: PhysicsHandle): void;
  remove(h: PhysicsHandle): void;
  count(kind: PhysicsKind): number;
  applyRadialImpulse(point: THREE.Vector3, radius: number, strength: number): void;
  castGroundY(x: number, z: number): number | null;
}

const CAPS: Record<PhysicsKind, number> = {
  meteor: 13, // must stay ≥ meteor.ts POOL_SIZE — detonateOldest owns eviction, not this cap
  debris: 60,
  prop: 16,
  gib: 96, // a max-charge meteor into a late-level wave can shatter 10+ at once // 8 regions × up to 8 unicorns caught in one big blast
};

const TIMESTEP = 1 / 60;
const MAX_SUBSTEPS = 5;

const _d = new THREE.Vector3();
const _qa = new THREE.Quaternion(); // scratch for interpolation slerp
const _qb = new THREE.Quaternion();

export async function initPhysics(scene: THREE.Scene): Promise<Physics> {
  void scene; // reserved for future debug draw; keeps the signature stable
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: -22, z: 0 });
  world.timestep = TIMESTEP;

  // Static terrain collider as a trimesh in world coordinates, sampled once from
  // the pristine ground (buildTerrainCollider). Impact craters deform the visual
  // mesh + the analytic `terrainHeight`, but NOT this collider — resting bodies
  // float a hair over a carved bowl, which the post-impact chaos hides.
  const tc = buildTerrainCollider(128);
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(tc.vertices, tc.indices)
      .setFriction(0.9)
      .setRestitution(0.1),
    groundBody,
  );

  // Step once so the broad-phase/query pipeline indexes the terrain collider;
  // otherwise ray casts done before the first frame's step all miss.
  world.step();

  const registry: PhysicsHandle[] = [];
  let acc = 0;
  let lastNow = 0; // most recent sim time seen by step(); used to time soft evictions

  function remove(h: PhysicsHandle): void {
    const i = registry.indexOf(h);
    if (i === -1) return;
    registry.splice(i, 1);
    h.onExpire?.();
    world.removeRigidBody(h.body);
  }

  function count(kind: PhysicsKind): number {
    let n = 0;
    for (const h of registry) if (h.kind === kind) n++;
    return n;
  }

  function oldestOfKind(kind: PhysicsKind, liveOnly: boolean): PhysicsHandle | null {
    let oldest: PhysicsHandle | null = null;
    for (const r of registry) {
      if (r.kind !== kind || (liveOnly && r._evicting)) continue;
      if (!oldest || r.bornAt < oldest.bornAt) oldest = r;
    }
    return oldest;
  }

  // Retire a body gracefully: shorten its life so it fades over ~0.35 s instead
  // of vanishing the instant a fresh one exceeds the cap (the pop was jarring
  // when a big blast spawned several unicorns' worth of gibs at once).
  function softEvict(h: PhysicsHandle): void {
    if (h._evicting) return;
    h._evicting = true;
    const target = Math.max(0, lastNow - h.bornAt) + 0.35;
    if (h.maxLife === undefined || target < h.maxLife) {
      h.maxLife = target;
      h.fade = 0.35;
    }
  }

  function add(h: PhysicsHandle): void {
    const cap = CAPS[h.kind];
    // Soft-evict the oldest still-live bodies so the live count drops below cap;
    // they fade out over the next third of a second rather than popping.
    let live = 0;
    for (const r of registry) if (r.kind === h.kind && !r._evicting) live++;
    while (live >= cap) {
      const oldest = oldestOfKind(h.kind, true);
      if (!oldest) break;
      softEvict(oldest);
      live--;
    }
    // Safety valve: if spawns outrun the fade, hard-remove the oldest (incl.
    // already-fading ones) so a kind can never balloon past 1.5× its cap.
    const hard = Math.ceil(cap * 1.5);
    while (count(h.kind) >= hard) {
      const oldest = oldestOfKind(h.kind, false);
      if (!oldest) break;
      remove(oldest);
    }
    // Seed the interpolation "previous" transform from the spawn pose so a fresh
    // body eases from where it appears, never from the origin.
    const t = h.body.translation();
    h._px = t.x; h._py = t.y; h._pz = t.z;
    const r = h.body.rotation();
    h._qx = r.x; h._qy = r.y; h._qz = r.z; h._qw = r.w;
    registry.push(h);
  }

  function step(dt: number, now: number): void {
    lastNow = now;
    acc += dt;
    let n = 0;
    while (acc >= TIMESTEP && n < MAX_SUBSTEPS) {
      // Snapshot each body's transform right before advancing, so after the loop
      // `_p*/_q*` hold the state one fixed step behind the current one.
      for (let i = 0; i < registry.length; i++) {
        const h = registry[i];
        const t = h.body.translation();
        h._px = t.x; h._py = t.y; h._pz = t.z;
        const r = h.body.rotation();
        h._qx = r.x; h._qy = r.y; h._qz = r.z; h._qw = r.w;
      }
      world.step();
      acc -= TIMESTEP;
      n++;
    }
    if (n === MAX_SUBSTEPS) acc = 0; // shed backlog after a stall

    // Fraction into the next fixed step: render bodies interpolated between the
    // previous and current physics states so motion stays smooth when the display
    // refresh doesn't line up with the 60 Hz simulation.
    const alpha = Math.min(acc / TIMESTEP, 1);

    for (let i = registry.length - 1; i >= 0; i--) {
      const h = registry[i];
      const t = h.body.translation();
      const r = h.body.rotation();
      if (h._px !== undefined) {
        h.object.position.set(
          h._px + (t.x - h._px) * alpha,
          h._py! + (t.y - h._py!) * alpha,
          h._pz! + (t.z - h._pz!) * alpha,
        );
        _qa.set(h._qx!, h._qy!, h._qz!, h._qw!);
        _qb.set(r.x, r.y, r.z, r.w);
        h.object.quaternion.slerpQuaternions(_qa, _qb, alpha);
      } else {
        h.object.position.set(t.x, t.y, t.z);
        h.object.quaternion.set(r.x, r.y, r.z, r.w);
      }

      if (h.maxLife !== undefined) {
        const age = now - h.bornAt;
        if (age >= h.maxLife) {
          remove(h);
          continue;
        }
        if (h.fade !== undefined && age > h.maxLife - h.fade) {
          if (h._baseScale === undefined) h._baseScale = h.object.scale.x || 1;
          h.object.scale.setScalar(h._baseScale * Math.max(0, (h.maxLife - age) / h.fade));
        }
      }
    }
  }

  function applyRadialImpulse(point: THREE.Vector3, radius: number, strength: number): void {
    for (const h of registry) {
      // Airborne meteors follow an analytically solved arc; a nearby blast must
      // not knock them off it, so they're exempt from the shove.
      if (h.kind === "meteor") continue;
      const t = h.body.translation();
      _d.set(t.x - point.x, t.y - point.y, t.z - point.z);
      const dist = _d.length();
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      _d.y += 0.5 + dist * 0.35; // bias the kick upward
      if (_d.lengthSq() < 1e-6) _d.set(0, 1, 0);
      _d.normalize();
      const m = h.body.mass() || 1;
      const s = strength * (0.35 + 0.65 * falloff) * m;
      h.body.applyImpulse({ x: _d.x * s, y: _d.y * s, z: _d.z * s }, true);
      h.body.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * s * 0.4,
          y: (Math.random() - 0.5) * s * 0.4,
          z: (Math.random() - 0.5) * s * 0.4,
        },
        true,
      );
    }
  }

  function castGroundY(x: number, z: number): number | null {
    const ray = new RAPIER.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 1000, true);
    return hit ? 500 - hit.timeOfImpact : null;
  }

  return { world, RAPIER, step, add, remove, count, applyRadialImpulse, castGroundY };
}
