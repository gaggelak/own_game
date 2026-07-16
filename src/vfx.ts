import * as THREE from "three";
import { terrainHeight } from "./terrain";
import { softDot } from "./textures";
import type { CameraShake } from "./shake";

// ---------------------------------------------------------------------------
// Explosion VFX: fireball, ground shockwave, rising smoke, flying embers, one
// shared flaring point light, ground decals (scorch + blood), and trauma-based
// camera shake. Everything is pooled and prewarmed (created up front, parked
// off-camera) so no shader compiles or light additions happen at impact time
// (those caused stutter).
// ---------------------------------------------------------------------------

const FIRE_POOL = 4;
const WAVE_POOL = 4;
const EMBER_CAP = 420;
const SMOKE_CAP = 260;
const DECAL_CAP = 12; // ring buffer for scorch marks
const BLOOD_DECAL_CAP = 14; // dedicated ring for blood pools + splatters

export interface Vfx {
  spawnExplosion(point: THREE.Vector3, radius: number): void;
  spawnDecal(point: THREE.Vector3, diameter: number, texture: THREE.Texture, tint: number, opacity: number): void;
  spawnBloodDecal(point: THREE.Vector3, diameter: number, texture: THREE.Texture, tint: number, opacity: number): void;
  // Re-drape any decal overlapping (cx, cz) onto the current ground — called
  // after a fresh crater is carved so scorch/blood follow the new bowl.
  conformDecals(cx: number, cz: number, reach: number): void;
  scorchTexture: THREE.Texture;
  splatTexture: THREE.Texture;
  update(dt: number, time: number): void;
  dispose(): void;
}

// A flat disc fanned out of concentric rings, its UVs mapping the round texture
// across it. Vertices ride the analytic ground each spawn (crater-aware), which
// is far cheaper than clipping a DecalGeometry against the whole terrain mesh.
const DISC_RINGS = 5;
const DISC_SECT = 18;
function buildDiscTemplate(): { local: Float32Array; uv: Float32Array; index: Uint16Array; count: number } {
  const local: number[] = [0, 0]; // centre
  const uv: number[] = [0.5, 0.5];
  for (let r = 1; r <= DISC_RINGS; r++) {
    const rr = (r / DISC_RINGS) * 0.5; // unit disc, radius 0.5 → diameter 1
    for (let s = 0; s < DISC_SECT; s++) {
      const a = (s / DISC_SECT) * Math.PI * 2;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      local.push(x, z);
      uv.push(0.5 + x, 0.5 + z);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < DISC_SECT; s++) idx.push(0, 1 + s, 1 + ((s + 1) % DISC_SECT)); // centre fan
  for (let r = 1; r < DISC_RINGS; r++) {
    const b0 = 1 + (r - 1) * DISC_SECT;
    const b1 = 1 + r * DISC_SECT;
    for (let s = 0; s < DISC_SECT; s++) {
      const s1 = (s + 1) % DISC_SECT;
      idx.push(b0 + s, b1 + s, b0 + s1, b0 + s1, b1 + s, b1 + s1);
    }
  }
  return { local: new Float32Array(local), uv: new Float32Array(uv), index: new Uint16Array(idx), count: local.length / 2 };
}

function scorchTexture(): THREE.CanvasTexture {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.1, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.55, "rgba(255,255,255,0.7)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  // irregular darker speckles so the edge isn't a perfect circle
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = (0.55 + Math.random() * 0.45) * (s / 2);
    const x = s / 2 + Math.cos(a) * r;
    const y = s / 2 + Math.sin(a) * r;
    ctx.beginPath();
    ctx.arc(x, y, 4 + Math.random() * 12, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(cv);
}

// An irregular blood splat: a ragged central blob with drips/tendrils flung
// outward and a few detached droplets. White on transparent so a decal can tint
// it red. Built once; each splatter decal rotates it for variety.
function splatTexture(): THREE.CanvasTexture {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const cx = s / 2;
  const cy = s / 2;
  const g = ctx.createRadialGradient(cx, cy, s * 0.04, cx, cy, s * 0.32);
  g.addColorStop(0, "rgba(255,255,255,0.98)");
  g.addColorStop(0.7, "rgba(255,255,255,0.82)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.32, 0, Math.PI * 2);
  ctx.fill();

  // drips: shrinking trails of dots flung out from the core (fixed step count
  // so the trail always terminates)
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  const tendrils = 12 + Math.floor(Math.random() * 6);
  for (let k = 0; k < tendrils; k++) {
    let a = Math.random() * Math.PI * 2;
    let r = s * 0.18;
    let rad = 5 + Math.random() * 5;
    const steps = 5 + Math.floor(Math.random() * 5);
    for (let st = 0; st < steps; st++) {
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rad, 0, Math.PI * 2);
      ctx.fill();
      r += rad * 0.95;
      rad *= 0.84;
      a += (Math.random() - 0.5) * 0.5;
    }
  }
  // detached droplets near the edge
  for (let k = 0; k < 10; k++) {
    const a = Math.random() * Math.PI * 2;
    const r = s * (0.3 + Math.random() * 0.18);
    ctx.globalAlpha = 0.7 + Math.random() * 0.3;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2 + Math.random() * 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // bite irregular holes out of the edge so it isn't a clean blob
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = (0.5 + Math.random() * 0.5) * (s * 0.32);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3 + Math.random() * 9, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(cv);
}

const _c = new THREE.Color();
const _hot = new THREE.Color(0xffe6a0);
const _cool = new THREE.Color(0xff3a08);

export function createVfx(scene: THREE.Scene, shake: CameraShake): Vfx {
  const emberTex = softDot("rgba(255,255,255,1)", "rgba(255,170,70,0.9)");
  const smokeTex = softDot("rgba(255,255,255,1)", "rgba(180,170,165,0.7)");
  const scorchTex = scorchTexture();
  const splatTex = splatTexture();

  // ---- fireballs (additive spheres that swell + fade) ----------------------
  const fireGeo = new THREE.IcosahedronGeometry(1, 3);
  interface Fire { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; radius: number; active: boolean; }
  const fires: Fire[] = [];
  for (let i = 0; i < FIRE_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffb24d,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const mesh = new THREE.Mesh(fireGeo, mat);
    mesh.position.set(0, -9999, 0);
    mesh.frustumCulled = false;
    scene.add(mesh);
    fires.push({ mesh, mat, age: 0, life: 1, radius: 1, active: false });
  }

  // ---- shockwaves (flat ground rings that expand + fade) -------------------
  const waveGeo = new THREE.RingGeometry(0.62, 1, 48).rotateX(-Math.PI / 2);
  interface Wave { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; radius: number; active: boolean; }
  const waves: Wave[] = [];
  for (let i = 0; i < WAVE_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(waveGeo, mat);
    mesh.position.set(0, -9999, 0);
    mesh.frustumCulled = false;
    scene.add(mesh);
    waves.push({ mesh, mat, age: 0, life: 1, radius: 1, active: false });
  }

  // ---- embers (additive points, vertex-colour fade, JS gravity) ------------
  const emberPos = new Float32Array(EMBER_CAP * 3).fill(-9999);
  const emberCol = new Float32Array(EMBER_CAP * 3);
  const emberVel = new Float32Array(EMBER_CAP * 3);
  const emberAge = new Float32Array(EMBER_CAP);
  const emberLife = new Float32Array(EMBER_CAP);
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute("position", new THREE.BufferAttribute(emberPos, 3));
  emberGeo.setAttribute("color", new THREE.BufferAttribute(emberCol, 3));
  const embers = new THREE.Points(
    emberGeo,
    new THREE.PointsMaterial({
      size: 1.5, map: emberTex, vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
    }),
  );
  embers.frustumCulled = false;
  scene.add(embers);
  let emberHead = 0;

  // ---- smoke (alpha points: per-vertex size + opacity, rise + grow) --------
  const smokePos = new Float32Array(SMOKE_CAP * 3).fill(-9999);
  const smokeCol = new Float32Array(SMOKE_CAP * 3);
  const smokeSize = new Float32Array(SMOKE_CAP);
  const smokeAlpha = new Float32Array(SMOKE_CAP);
  const smokeVel = new Float32Array(SMOKE_CAP * 3);
  const smokeAge = new Float32Array(SMOKE_CAP);
  const smokeLife = new Float32Array(SMOKE_CAP);
  const smokeGeo = new THREE.BufferGeometry();
  smokeGeo.setAttribute("position", new THREE.BufferAttribute(smokePos, 3));
  smokeGeo.setAttribute("color", new THREE.BufferAttribute(smokeCol, 3));
  smokeGeo.setAttribute("aSize", new THREE.BufferAttribute(smokeSize, 1));
  smokeGeo.setAttribute("aAlpha", new THREE.BufferAttribute(smokeAlpha, 1));
  const smokeMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: smokeTex } },
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aAlpha;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vAlpha = aAlpha;
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vColor, t.a * vAlpha);
      }
    `,
    vertexColors: true,
  });
  smokeMat.customProgramCacheKey = () => "vfxSmoke";
  const smoke = new THREE.Points(smokeGeo, smokeMat);
  smoke.frustumCulled = false;
  scene.add(smoke);
  let smokeHead = 0;

  // ---- ground decals (scorch + blood) -------------------------------------
  // Each decal is a flat disc whose vertices sit on the analytic ground; a spawn
  // just re-drapes and rescales that disc (crater-aware) instead of clipping a
  // fresh DecalGeometry against the whole terrain. Each mesh keeps a map from the
  // start so swapping textures never toggles USE_MAP (which would recompile).
  const disc = buildDiscTemplate();

  interface DecalRec { mesh: THREE.Mesh; cx: number; cz: number; radius: number; }

  // Re-drape a decal's disc onto the current ground at (cx, cz), rotated by `yaw`
  // and scaled to `diameter`. Vertices ride terrainHeight (+ a hair) so scorch/
  // blood follow the carved crater bowl; local normals keep it lit like the ground.
  function drape(rec: DecalRec, diameter: number, yaw: number): void {
    const pos = rec.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (let i = 0; i < disc.count; i++) {
      const lx = disc.local[i * 2];
      const lz = disc.local[i * 2 + 1];
      const wx = rec.cx + (lx * cos - lz * sin) * diameter;
      const wz = rec.cz + (lx * sin + lz * cos) * diameter;
      pos.setXYZ(i, wx, terrainHeight(wx, wz) + 0.05, wz);
    }
    pos.needsUpdate = true;
    rec.mesh.geometry.computeVertexNormals();
    rec.radius = diameter * 0.5;
  }

  function makeDecalPool(count: number, offset: number, renderOrder: number): DecalRec[] {
    const pool: DecalRec[] = [];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshStandardMaterial({
        map: scorchTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: offset,
        polygonOffsetUnits: offset,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(disc.count * 3), 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(disc.uv.slice(), 2));
      geo.setIndex(new THREE.BufferAttribute(disc.index.slice(), 1));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = false;
      scene.add(mesh);
      const rec: DecalRec = { mesh, cx: 0, cz: 0, radius: 1 };
      // Prewarm at a real terrain point so compileAsync links the program.
      drape(rec, 2, 0);
      pool.push(rec);
    }
    return pool;
  }

  function placeDecal(pool: DecalRec[], head: number, point: THREE.Vector3, diameter: number, texture: THREE.Texture, tint: number, opacity: number): void {
    const rec = pool[head];
    rec.cx = point.x;
    rec.cz = point.z;
    drape(rec, diameter, Math.random() * Math.PI * 2);
    const m = rec.mesh.material as THREE.MeshStandardMaterial;
    m.map = texture;
    m.color.setHex(tint);
    m.opacity = opacity;
  }

  const decals = makeDecalPool(DECAL_CAP, -4, 2);
  let decalHead = 0;
  function spawnDecal(point: THREE.Vector3, diameter: number, texture: THREE.Texture, tint: number, opacity: number): void {
    placeDecal(decals, decalHead, point, diameter, texture, tint, opacity);
    decalHead = (decalHead + 1) % DECAL_CAP;
  }

  // Blood gets its own ring so gore doesn't evict scorch, and vice versa; drawn
  // over scorch marks (renderOrder 3) with a stronger polygon offset.
  const bloodDecals = makeDecalPool(BLOOD_DECAL_CAP, -5, 3);
  let bloodHead = 0;
  function spawnBloodDecal(point: THREE.Vector3, diameter: number, texture: THREE.Texture, tint: number, opacity: number): void {
    placeDecal(bloodDecals, bloodHead, point, diameter, texture, tint, opacity);
    bloodHead = (bloodHead + 1) % BLOOD_DECAL_CAP;
  }

  // Re-drape decals overlapping a freshly carved crater so they follow the new
  // bowl instead of hanging over it. Cheap: a handful of ~90-vertex discs.
  function conformDecals(cx: number, cz: number, reach: number): void {
    for (const pool of [decals, bloodDecals]) {
      for (const rec of pool) {
        if ((rec.mesh.material as THREE.MeshStandardMaterial).opacity <= 0) continue;
        const dx = rec.cx - cx;
        const dz = rec.cz - cz;
        const rr = reach + rec.radius;
        if (dx * dx + dz * dz > rr * rr) continue;
        drape(rec, rec.radius * 2, discYaw(rec));
      }
    }
  }
  // Preserve each decal's random rotation across a re-drape by deriving a stable
  // yaw from its current first ring vertex (avoids storing yaw separately).
  function discYaw(rec: DecalRec): number {
    const pos = rec.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    return Math.atan2(pos.getZ(1) - rec.cz, pos.getX(1) - rec.cx);
  }

  // ---- one shared flaring light (added now so materials compile with it) ---
  const light = new THREE.PointLight(0xff9a4a, 0, 60, 2);
  light.position.set(0, -9999, 0);
  scene.add(light);
  let lightAge = 0;
  let lightLife = 1;
  let lightPeak = 0;

  function spawnExplosion(point: THREE.Vector3, radius: number): void {
    // fireball
    let f = fires.find((x) => !x.active) ?? fires[0];
    f.active = true; f.age = 0; f.life = 0.55; f.radius = radius * 0.85;
    f.mesh.position.copy(point); f.mesh.position.y += radius * 0.25;
    f.mesh.scale.setScalar(radius * 0.3);
    f.mat.opacity = 1; f.mat.color.setHex(0xfff1c0);

    // shockwave
    let w = waves.find((x) => !x.active) ?? waves[0];
    w.active = true; w.age = 0; w.life = 0.5; w.radius = radius * 2.4;
    w.mesh.position.set(point.x, point.y + 0.15, point.z);
    w.mesh.scale.setScalar(radius * 0.3);
    w.mat.opacity = 0.9;

    // light flare
    light.position.set(point.x, point.y + radius * 0.4, point.z);
    lightAge = 0; lightLife = 0.45; lightPeak = 6 + radius * 1.6;

    // embers (fast, flung outward)
    const nE = Math.min(120, Math.floor(40 + radius * 6));
    for (let i = 0; i < nE; i++) {
      const k = emberHead;
      emberHead = (emberHead + 1) % EMBER_CAP;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.3, Math.random() - 0.5).normalize();
      const sp = radius * (0.8 + Math.random() * 1.6);
      emberPos[k * 3] = point.x; emberPos[k * 3 + 1] = point.y + 0.5; emberPos[k * 3 + 2] = point.z;
      emberVel[k * 3] = dir.x * sp; emberVel[k * 3 + 1] = dir.y * sp; emberVel[k * 3 + 2] = dir.z * sp;
      emberAge[k] = 0; emberLife[k] = 0.5 + Math.random() * 0.9;
    }

    // lingering coals: slow, long-lived embers that settle in the crater and
    // glow as they cool, leaving the pit smouldering after the blast.
    const nC = Math.min(34, Math.floor(12 + radius * 1.4));
    for (let i = 0; i < nC; i++) {
      const k = emberHead;
      emberHead = (emberHead + 1) % EMBER_CAP;
      const ang = Math.random() * Math.PI * 2;
      const rr = Math.random() * radius * 0.55;
      emberPos[k * 3] = point.x + Math.cos(ang) * rr;
      emberPos[k * 3 + 1] = point.y + 0.3 + Math.random() * 0.6;
      emberPos[k * 3 + 2] = point.z + Math.sin(ang) * rr;
      emberVel[k * 3] = (Math.random() - 0.5) * 1.2;
      emberVel[k * 3 + 1] = 0.4 + Math.random() * 1.0;
      emberVel[k * 3 + 2] = (Math.random() - 0.5) * 1.2;
      emberAge[k] = 0; emberLife[k] = 2.6 + Math.random() * 2.2;
    }

    // smoke
    const nS = Math.min(48, Math.floor(18 + radius * 2.2));
    for (let i = 0; i < nS; i++) {
      const k = smokeHead;
      smokeHead = (smokeHead + 1) % SMOKE_CAP;
      const ang = Math.random() * Math.PI * 2;
      const rr = Math.random() * radius * 0.5;
      smokePos[k * 3] = point.x + Math.cos(ang) * rr;
      smokePos[k * 3 + 1] = point.y + 1 + Math.random() * 2;
      smokePos[k * 3 + 2] = point.z + Math.sin(ang) * rr;
      smokeVel[k * 3] = (Math.random() - 0.5) * 1.5;
      smokeVel[k * 3 + 1] = 2.5 + Math.random() * 2.5;
      smokeVel[k * 3 + 2] = (Math.random() - 0.5) * 1.5;
      smokeAge[k] = 0; smokeLife[k] = 1.2 + Math.random() * 1.1;
      smokeSize[k] = radius * (0.5 + Math.random() * 0.5);
      const g = 0.16 + Math.random() * 0.16;
      smokeCol[k * 3] = g * 1.1; smokeCol[k * 3 + 1] = g; smokeCol[k * 3 + 2] = g * 0.95;
      smokeAlpha[k] = 0;
    }

    // scorch mark on the ground (projected after the crater is carved)
    spawnDecal(point, radius * 1.95, scorchTex, 0x1f140b, 0.9);

    shake.addTrauma(THREE.MathUtils.clamp(radius / 13, 0.35, 1));
  }

  function update(dt: number, _time: number): void {
    for (const f of fires) {
      if (!f.active) continue;
      f.age += dt;
      const u = f.age / f.life;
      if (u >= 1) { f.active = false; f.mat.opacity = 0; f.mesh.position.y = -9999; continue; }
      f.mesh.scale.setScalar(f.radius * (0.3 + 0.7 * (1 - (1 - u) * (1 - u))));
      f.mat.opacity = (1 - u) * (1 - u);
      _c.copy(_hot).lerp(_cool, u); f.mat.color.copy(_c);
    }

    for (const w of waves) {
      if (!w.active) continue;
      w.age += dt;
      const u = w.age / w.life;
      if (u >= 1) { w.active = false; w.mat.opacity = 0; w.mesh.position.y = -9999; continue; }
      w.mesh.scale.set(w.radius * (0.3 + u * 0.9), 1, w.radius * (0.3 + u * 0.9));
      w.mat.opacity = 0.9 * (1 - u);
    }

    if (lightPeak > 0) {
      lightAge += dt;
      const u = lightAge / lightLife;
      if (u >= 1) { light.intensity = 0; lightPeak = 0; }
      else light.intensity = lightPeak * (1 - u) * (1 - u);
    }

    // embers
    let eDirty = false;
    for (let i = 0; i < EMBER_CAP; i++) {
      if (emberAge[i] >= emberLife[i]) {
        if (emberPos[i * 3 + 1] !== -9999) { emberPos[i * 3 + 1] = -9999; eDirty = true; }
        continue;
      }
      emberAge[i] += dt;
      emberVel[i * 3 + 1] -= 18 * dt;
      emberPos[i * 3] += emberVel[i * 3] * dt;
      emberPos[i * 3 + 1] += emberVel[i * 3 + 1] * dt;
      emberPos[i * 3 + 2] += emberVel[i * 3 + 2] * dt;
      const life = 1 - emberAge[i] / emberLife[i];
      _c.copy(_cool).lerp(_hot, life * life);
      emberCol[i * 3] = _c.r * life; emberCol[i * 3 + 1] = _c.g * life; emberCol[i * 3 + 2] = _c.b * life;
      eDirty = true;
    }
    if (eDirty) { emberGeo.attributes.position.needsUpdate = true; emberGeo.attributes.color.needsUpdate = true; }

    // smoke
    let sDirty = false;
    for (let i = 0; i < SMOKE_CAP; i++) {
      if (smokeAge[i] >= smokeLife[i]) {
        if (smokeAlpha[i] !== 0) { smokeAlpha[i] = 0; smokePos[i * 3 + 1] = -9999; sDirty = true; }
        continue;
      }
      smokeAge[i] += dt;
      const u = smokeAge[i] / smokeLife[i];
      smokeVel[i * 3 + 1] *= 1 - dt * 0.6;
      smokePos[i * 3] += smokeVel[i * 3] * dt;
      smokePos[i * 3 + 1] += smokeVel[i * 3 + 1] * dt;
      smokePos[i * 3 + 2] += smokeVel[i * 3 + 2] * dt;
      smokeSize[i] += dt * 4;
      smokeAlpha[i] = Math.sin(Math.min(u, 1) * Math.PI) * 0.5;
      sDirty = true;
    }
    if (sDirty) {
      smokeGeo.attributes.position.needsUpdate = true;
      smokeGeo.attributes.aSize.needsUpdate = true;
      smokeGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  function dispose(): void {
    scene.remove(embers, smoke, light);
    for (const f of fires) scene.remove(f.mesh);
    for (const w of waves) scene.remove(w.mesh);
    for (const d of decals) scene.remove(d.mesh);
    for (const d of bloodDecals) scene.remove(d.mesh);
  }

  return {
    spawnExplosion,
    spawnDecal,
    spawnBloodDecal,
    conformDecals,
    scorchTexture: scorchTex,
    splatTexture: splatTex,
    update,
    dispose,
  };
}
