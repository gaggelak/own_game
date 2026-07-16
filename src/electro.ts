import * as THREE from "three";
import { terrainHeight } from "./terrain";
import { softDot } from "./textures";
import type { CameraShake } from "./shake";

// ---------------------------------------------------------------------------
// Electric water-ball impact VFX: a cyan flash, an expanding shock ring, a
// splash of water droplets, a burst of electric sparks, jagged ground bolts
// crawling outward, a flaring cyan light, plus on-demand zap bolts that arc
// from the impact to each unicorn it electrocutes. Everything is pooled and
// prewarmed (created up front, parked off-camera) so the first hit doesn't
// compile shaders or add lights mid-frame — same discipline as vfx.ts.
// ---------------------------------------------------------------------------

const FLASH_POOL = 4;
const RING_POOL = 4;
const PART_CAP = 1200; // shared electric sparks + water droplets
const BOLT_SLOTS = 160; // a domino cascade can have 20+ unicorns crackling at once // ring buffer of jagged bolts (impact jolts + crawling crackle + zaps)
const BOLT_SEG = 7; // segments per bolt

export interface Electro {
  // A full ground impact: flash + ring + splash + sparks + crawling bolts.
  spawnBurst(point: THREE.Vector3, radius: number): void;
  // A bolt that arcs from `from` to `to` (impact → a unicorn being fried).
  zap(from: THREE.Vector3, to: THREE.Vector3): void;
  // Per-frame crackle crawling over a standing-electrified unicorn's body.
  crackle(x: number, y: number, z: number, height: number): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

const _up = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(1, 0, 0);
const _dir = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _c = new THREE.Color();
const _sparkHot = new THREE.Color(0xffffff);
const _sparkCool = new THREE.Color(0x3aa6ff);
const _waterCol = new THREE.Color(0x6fd8ff);

export function createElectro(scene: THREE.Scene, shake: CameraShake): Electro {
  const sparkTex = softDot("rgba(255,255,255,1)", "rgba(120,220,255,0.9)");

  // ---- flash spheres (additive, swell + fade) ------------------------------
  const flashGeo = new THREE.IcosahedronGeometry(1, 3);
  interface Flash { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; radius: number; active: boolean; }
  const flashes: Flash[] = [];
  for (let i = 0; i < FLASH_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xbff0ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const mesh = new THREE.Mesh(flashGeo, mat);
    mesh.position.set(0, -9999, 0);
    mesh.frustumCulled = false;
    scene.add(mesh);
    flashes.push({ mesh, mat, age: 0, life: 1, radius: 1, active: false });
  }

  // ---- shock rings (flat cyan ground rings that expand + fade) -------------
  const ringGeo = new THREE.RingGeometry(0.7, 1, 48).rotateX(-Math.PI / 2);
  interface Ring { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; radius: number; active: boolean; }
  const rings: Ring[] = [];
  for (let i = 0; i < RING_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8fe3ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.position.set(0, -9999, 0);
    mesh.frustumCulled = false;
    scene.add(mesh);
    rings.push({ mesh, mat, age: 0, life: 1, radius: 1, active: false });
  }

  // ---- sparks + water droplets (one additive point buffer) -----------------
  // Per-particle gravity multiplier lets bright cyan sparks float a little
  // while heavier blue water droplets arc up and rain back down.
  const pPos = new Float32Array(PART_CAP * 3).fill(-9999);
  const pVel = new Float32Array(PART_CAP * 3);
  const pCol = new Float32Array(PART_CAP * 3); // uploaded colour = base * life fade
  const pBase = new Float32Array(PART_CAP * 3); // emit colour, full bright
  const pAge = new Float32Array(PART_CAP);
  const pLife = new Float32Array(PART_CAP).fill(1);
  const pGrav = new Float32Array(PART_CAP);
  const partGeo = new THREE.BufferGeometry();
  partGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  partGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
  const parts = new THREE.Points(
    partGeo,
    new THREE.PointsMaterial({
      size: 1.2, map: sparkTex, vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
    }),
  );
  parts.frustumCulled = false;
  scene.add(parts);
  let partHead = 0;

  function emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, col: THREE.Color, life: number, grav: number): void {
    const k = partHead;
    partHead = (partHead + 1) % PART_CAP;
    pPos[k * 3] = x; pPos[k * 3 + 1] = y; pPos[k * 3 + 2] = z;
    pVel[k * 3] = vx; pVel[k * 3 + 1] = vy; pVel[k * 3 + 2] = vz;
    pBase[k * 3] = col.r; pBase[k * 3 + 1] = col.g; pBase[k * 3 + 2] = col.b;
    pCol[k * 3] = col.r; pCol[k * 3 + 1] = col.g; pCol[k * 3 + 2] = col.b;
    pAge[k] = 0; pLife[k] = life; pGrav[k] = grav;
  }

  // ---- jagged bolts (LineSegments, vertex-coloured fade) -------------------
  const boltPos = new Float32Array(BOLT_SLOTS * BOLT_SEG * 2 * 3).fill(-9999);
  const boltCol = new Float32Array(BOLT_SLOTS * BOLT_SEG * 2 * 3);
  const boltAge = new Float32Array(BOLT_SLOTS).fill(99);
  const boltLife = new Float32Array(BOLT_SLOTS).fill(1);
  const boltGeo = new THREE.BufferGeometry();
  boltGeo.setAttribute("position", new THREE.BufferAttribute(boltPos, 3));
  boltGeo.setAttribute("color", new THREE.BufferAttribute(boltCol, 3));
  const bolts = new THREE.LineSegments(
    boltGeo,
    new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    }),
  );
  bolts.frustumCulled = false;
  scene.add(bolts);
  let boltHead = 0;

  // Write a jagged polyline from A→B into one bolt slot. Midpoints are pushed
  // off the straight line by `jitter`, tapering to zero at both ends so the
  // bolt still connects its endpoints.
  function writeBolt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, jitter: number, life: number): void {
    const slot = boltHead;
    boltHead = (boltHead + 1) % BOLT_SLOTS;
    boltAge[slot] = 0;
    boltLife[slot] = life;

    _dir.set(bx - ax, by - ay, bz - az);
    const len = _dir.length() || 1;
    _dir.multiplyScalar(1 / len);
    // two axes perpendicular to the bolt direction
    _p1.copy(Math.abs(_dir.y) > 0.9 ? _altUp : _up).cross(_dir).normalize();
    _p2.copy(_dir).cross(_p1).normalize();

    const N = BOLT_SEG; // segments → N+1 points
    let px = ax, py = ay, pz = az;
    const base = slot * BOLT_SEG * 2 * 3;
    for (let i = 0; i < N; i++) {
      const t1 = (i + 1) / N;
      const taper = Math.sin(t1 * Math.PI); // 0 at ends, 1 in the middle
      const o1 = (Math.random() - 0.5) * jitter * taper;
      const o2 = (Math.random() - 0.5) * jitter * taper;
      const nx = ax + (bx - ax) * t1 + _p1.x * o1 + _p2.x * o2;
      const ny = ay + (by - ay) * t1 + _p1.y * o1 + _p2.y * o2;
      const nz = az + (bz - az) * t1 + _p1.z * o1 + _p2.z * o2;
      const v = base + i * 6;
      boltPos[v] = px; boltPos[v + 1] = py; boltPos[v + 2] = pz;
      boltPos[v + 3] = i === N - 1 ? bx : nx;
      boltPos[v + 4] = i === N - 1 ? by : ny;
      boltPos[v + 5] = i === N - 1 ? bz : nz;
      px = nx; py = ny; pz = nz;
    }
    boltGeo.attributes.position.needsUpdate = true;
  }

  // ---- one shared flaring cyan light ---------------------------------------
  const light = new THREE.PointLight(0x7fd6ff, 0, 70, 2);
  light.position.set(0, -9999, 0);
  scene.add(light);
  let lightAge = 0;
  let lightLife = 1;
  let lightPeak = 0;

  function zap(from: THREE.Vector3, to: THREE.Vector3): void {
    const d = from.distanceTo(to);
    writeBolt(from.x, from.y, from.z, to.x, to.y, to.z, Math.max(1.2, d * 0.22), 0.16 + Math.random() * 0.08);
    // a short forked branch near the target sells the strike
    _p1.set(to.x + (Math.random() - 0.5) * 2, to.y + 1.5 + Math.random() * 1.5, to.z + (Math.random() - 0.5) * 2);
    writeBolt(to.x, to.y + 1.2, to.z, _p1.x, _p1.y, _p1.z, 1.0, 0.14);
    // sparks where it hits
    for (let i = 0; i < 16; i++) {
      _c.copy(_sparkHot).lerp(_sparkCool, Math.random());
      emit(
        to.x, to.y + 1.2, to.z,
        (Math.random() - 0.5) * 7, Math.random() * 7 + 1, (Math.random() - 0.5) * 7,
        _c, 0.3 + Math.random() * 0.4, 0.5,
      );
    }
  }

  function spawnBurst(point: THREE.Vector3, radius: number): void {
    // flash
    let f = flashes.find((x) => !x.active) ?? flashes[0];
    f.active = true; f.age = 0; f.life = 0.4; f.radius = radius * 0.8;
    f.mesh.position.set(point.x, point.y + radius * 0.2, point.z);
    f.mesh.scale.setScalar(radius * 0.25);
    f.mat.opacity = 1;

    // shock ring
    let w = rings.find((x) => !x.active) ?? rings[0];
    w.active = true; w.age = 0; w.life = 0.55; w.radius = radius * 2.6;
    w.mesh.position.set(point.x, point.y + 0.15, point.z);
    w.mesh.scale.setScalar(radius * 0.3);
    w.mat.opacity = 0.9;

    // light flare
    light.position.set(point.x, point.y + radius * 0.4, point.z);
    lightAge = 0; lightLife = 0.5; lightPeak = 7 + radius * 1.8;

    // electric sparks flung outward
    const nS = Math.min(280, Math.floor(80 + radius * 11));
    for (let i = 0; i < nS; i++) {
      _dir.set(Math.random() - 0.5, Math.random() * 0.8 + 0.3, Math.random() - 0.5).normalize();
      const sp = radius * (0.9 + Math.random() * 1.8);
      _c.copy(_sparkHot).lerp(_sparkCool, Math.random());
      emit(point.x, point.y + 0.6, point.z, _dir.x * sp, _dir.y * sp, _dir.z * sp, _c, 0.35 + Math.random() * 0.6, 0.35);
    }

    // water splash: heavier blue droplets that fountain up and rain back down
    const nW = Math.min(120, Math.floor(40 + radius * 5));
    for (let i = 0; i < nW; i++) {
      const ang = Math.random() * Math.PI * 2;
      const out = radius * (0.4 + Math.random() * 1.1);
      emit(
        point.x, point.y + 0.4, point.z,
        Math.cos(ang) * out, radius * (1.0 + Math.random() * 1.4), Math.sin(ang) * out,
        _waterCol, 0.6 + Math.random() * 0.7, 1.6,
      );
    }

    // ground bolts crawling outward from the impact (lots of them — the hit
    // should read as a violent electric discharge, not a single zap)
    const nB = 16;
    for (let i = 0; i < nB; i++) {
      const ang = (i / nB) * Math.PI * 2 + Math.random() * 0.6;
      const reach = radius * (0.6 + Math.random() * 0.9);
      const ex = point.x + Math.cos(ang) * reach;
      const ez = point.z + Math.sin(ang) * reach;
      const ey = terrainHeight(ex, ez) + 0.2;
      writeBolt(point.x, point.y + 0.4, point.z, ex, ey, ez, radius * 0.2, 0.16 + Math.random() * 0.14);
    }
    // upward bolts leaping off the impact like a tesla cage
    const nU = 9;
    for (let i = 0; i < nU; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rr = radius * (0.1 + Math.random() * 0.5);
      const ex = point.x + Math.cos(ang) * rr;
      const ez = point.z + Math.sin(ang) * rr;
      const ey = point.y + radius * (0.6 + Math.random() * 1.0);
      writeBolt(point.x, point.y + 0.3, point.z, ex, ey, ez, radius * 0.16, 0.14 + Math.random() * 0.12);
    }

    shake.addTrauma(THREE.MathUtils.clamp(radius / 16, 0.3, 0.85));
  }

  // Crawl a few short bolts + sparks over a standing-electrified unicorn's body
  // (a vertical line from the ground up to `height`). Called every frame per
  // dying unicorn, so keep it cheap.
  function crackle(x: number, y: number, z: number, height: number): void {
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const a0 = Math.random() * Math.PI * 2, a1 = Math.random() * Math.PI * 2;
      const rr = 0.45 + Math.random() * 0.4;
      writeBolt(
        x + Math.cos(a0) * rr, y + Math.random() * height, z + Math.sin(a0) * rr,
        x + Math.cos(a1) * rr, y + Math.random() * height, z + Math.sin(a1) * rr,
        0.7, 0.08 + Math.random() * 0.06,
      );
    }
    for (let i = 0; i < 3; i++) {
      _c.copy(_sparkHot).lerp(_sparkCool, Math.random());
      emit(
        x + (Math.random() - 0.5) * 0.8, y + Math.random() * height, z + (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 3, Math.random() * 4 + 1, (Math.random() - 0.5) * 3,
        _c, 0.22 + Math.random() * 0.3, 0.5,
      );
    }
  }

  function update(dt: number, time: number): void {
    for (const f of flashes) {
      if (!f.active) continue;
      f.age += dt;
      const u = f.age / f.life;
      if (u >= 1) { f.active = false; f.mat.opacity = 0; f.mesh.position.y = -9999; continue; }
      f.mesh.scale.setScalar(f.radius * (0.25 + 0.75 * (1 - (1 - u) * (1 - u))));
      f.mat.opacity = (1 - u);
    }

    for (const w of rings) {
      if (!w.active) continue;
      w.age += dt;
      const u = w.age / w.life;
      if (u >= 1) { w.active = false; w.mat.opacity = 0; w.mesh.position.y = -9999; continue; }
      const s = w.radius * (0.3 + u * 0.95);
      w.mesh.scale.set(s, 1, s);
      w.mat.opacity = 0.9 * (1 - u);
    }

    if (lightPeak > 0) {
      lightAge += dt;
      const u = lightAge / lightLife;
      // flicker the electric light as it decays
      if (u >= 1) { light.intensity = 0; lightPeak = 0; }
      else light.intensity = lightPeak * (1 - u) * (0.6 + 0.4 * Math.sin(time * 60));
    }

    // sparks + droplets: integrate, then dim toward black by remaining life
    // (additive blending makes a black point vanish).
    let pDirty = false;
    for (let i = 0; i < PART_CAP; i++) {
      if (pAge[i] >= pLife[i]) {
        if (pPos[i * 3 + 1] !== -9999) { pPos[i * 3 + 1] = -9999; pDirty = true; }
        continue;
      }
      pAge[i] += dt;
      pVel[i * 3 + 1] -= 22 * pGrav[i] * dt;
      pPos[i * 3] += pVel[i * 3] * dt;
      pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
      pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
      const f = 1 - pAge[i] / pLife[i];
      pCol[i * 3] = pBase[i * 3] * f;
      pCol[i * 3 + 1] = pBase[i * 3 + 1] * f;
      pCol[i * 3 + 2] = pBase[i * 3 + 2] * f;
      pDirty = true;
    }
    if (pDirty) {
      partGeo.attributes.position.needsUpdate = true;
      partGeo.attributes.color.needsUpdate = true;
    }

    // bolts fade out
    let bDirty = false;
    for (let s = 0; s < BOLT_SLOTS; s++) {
      if (boltAge[s] >= boltLife[s]) continue;
      boltAge[s] += dt;
      const f = Math.max(0, 1 - boltAge[s] / boltLife[s]);
      const r = 0.75 * f, g = 0.95 * f, b = 1.25 * f;
      const base = s * BOLT_SEG * 2 * 3;
      for (let v = 0; v < BOLT_SEG * 2; v++) {
        boltCol[base + v * 3] = r;
        boltCol[base + v * 3 + 1] = g;
        boltCol[base + v * 3 + 2] = b;
      }
      bDirty = true;
    }
    if (bDirty) boltGeo.attributes.color.needsUpdate = true;
  }

  function dispose(): void {
    scene.remove(parts, bolts, light);
    for (const f of flashes) scene.remove(f.mesh);
    for (const w of rings) scene.remove(w.mesh);
  }

  return { spawnBurst, zap, crackle, update, dispose };
}
