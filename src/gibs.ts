import * as THREE from "three";
import type { Physics } from "./physics";
import type { Vfx } from "./vfx";
import type { KilledUnicorn, GibParts } from "./unicorn";
import { softDot } from "./textures";

// ---------------------------------------------------------------------------
// Geometry-accurate gore gibs. The unicorn's merged rest-pose triangle soup is
// baked to the death-moment world matrix, then whole triangles are binned by
// centroid into up to 8 regions (head+horn, torso, hindquarters, 4 legs, tail).
// Each region becomes a tumbling rigid body with a convex-hull collider (cuboid
// fallback). Blood: a red spray burst, a ground pool + splatter decals. The
// instant blast hides that we use the bind pose rather than the animated one.
// ---------------------------------------------------------------------------

const BLOOD_CAP = 800;
const REGIONS = 8;

// Gore palette. Chunks are vertex-coloured so they read as torn wet flesh from
// any angle (dark clotted maroon, bright wet red, the odd streak of coat) — not
// the old pastel pink. Saturated reds sit well below the bloom threshold, so
// blood stays vividly red instead of blooming out to white.
const _gFlesh = new THREE.Color(0x9a1414);
const _gDeep = new THREE.Color(0x4a0606);
const _gCoat = new THREE.Color(0xd98c98);
const _gBright = new THREE.Color(0xc01818);
const _gMist = new THREE.Color(0x8a0f0f);
const _gMist2 = new THREE.Color(0xb52222);

// Charred palette for the electrocution death: ashen blacks/greys with the odd
// glowing electric-blue ember fleck.
const _eChar = new THREE.Color(0x141417);
const _eAsh = new THREE.Color(0x3c3c44);
const _eSpark = new THREE.Color(0x7fe0ff);

// "gore" → the meteor's bloody shatter; "electro" → a charred, bloodless
// crumble for an electrocuted unicorn (the sparks + scorch come from electro.ts).
export type GibMode = "gore" | "electro";

export interface GibSystem {
  spawn(killed: KilledUnicorn, parts: GibParts, blastPoint: THREE.Vector3, blastRadius: number, now: number, mode?: GibMode): void;
  update(dt: number): void;
}

const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _ctr = new THREE.Vector3();
const _col = new THREE.Color();

function regionOf(cx: number, cy: number, cz: number, bb: THREE.Box3): number {
  const hy = Math.max(bb.max.y - bb.min.y, 1e-3);
  const hz = Math.max(bb.max.z - bb.min.z, 1e-3);
  const ny = (cy - bb.min.y) / hy;
  const nz = (cz - bb.min.z) / hz;
  const midX = (bb.min.x + bb.max.x) * 0.5;
  if (nz > 0.72) return 0; // head + neck (front)
  if (ny < 0.36) {
    // legs (low): split left/right + front/back
    const rightBit = cx > midX ? 0 : 1;
    const backBit = nz < 0.5 ? 2 : 0;
    return 1 + rightBit + backBit; // 1..4
  }
  if (nz < 0.14) return 5; // tail
  if (nz < 0.45) return 6; // hindquarters
  return 7; // torso
}

export function createGibs(scene: THREE.Scene, physics: Physics, vfx: Vfx): GibSystem {
  const RAPIER = physics.RAPIER;
  // Per-vertex colours carry the gore (base white so they show at full strength).
  const bloodied = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  // Prewarm the chunk material (needs a colour attribute so the compiled
  // vertexColors program matches the real chunks).
  const warmGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  warmGeo.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(warmGeo.attributes.position.count * 3).fill(0.5), 3),
  );
  const warm = new THREE.Mesh(warmGeo, bloodied);
  warm.position.set(0, -9999, 0);
  scene.add(warm);

  // Charred chunk material for electrocuted unicorns: dark ash carrying a cold
  // electric cast (emissive) so the crumble reads as fried, not bloody.
  const charred = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    emissive: 0x123040,
    emissiveIntensity: 0.6,
    roughness: 0.85,
    metalness: 0.1,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const warmE = new THREE.Mesh(warmGeo, charred);
  warmE.position.set(0, -9999, 0);
  scene.add(warmE);

  // Paint a chunk's vertices ashen-black with sparse glowing-blue embers.
  function charColors(geo: THREE.BufferGeometry): void {
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const cols = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      _col.copy(_eChar).lerp(_eAsh, Math.random() * 0.7);
      if (Math.random() > 0.9) _col.lerp(_eSpark, 0.7);
      cols[i * 3] = _col.r; cols[i * 3 + 1] = _col.g; cols[i * 3 + 2] = _col.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  }

  // Paint a chunk's vertices with a bloody two-tone: mostly wet flesh, dark
  // clots, and an occasional streak of blood-soaked coat.
  function gorifyColors(geo: THREE.BufferGeometry): void {
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const cols = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      _col.copy(_gFlesh).lerp(_gDeep, Math.random() * 0.85);
      if (Math.random() > 0.82) _col.lerp(_gCoat, 0.5);
      cols[i * 3] = _col.r; cols[i * 3 + 1] = _col.g; cols[i * 3 + 2] = _col.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  }

  // ---- blood (alpha points: per-vertex colour/size/alpha, JS gravity) ------
  // One buffer drives two looks: fast falling spray droplets (full gravity) and
  // a big slow expanding mist puff (near-zero gravity, grows then fades).
  const bPos = new Float32Array(BLOOD_CAP * 3).fill(-9999);
  const bVel = new Float32Array(BLOOD_CAP * 3);
  const bCol = new Float32Array(BLOOD_CAP * 3);
  const bAge = new Float32Array(BLOOD_CAP);
  const bLife = new Float32Array(BLOOD_CAP);
  const bSize = new Float32Array(BLOOD_CAP);
  const bAlpha = new Float32Array(BLOOD_CAP);
  const bA0 = new Float32Array(BLOOD_CAP); // peak alpha (fades from here)
  const bGrav = new Float32Array(BLOOD_CAP); // gravity multiplier
  const bGrow = new Float32Array(BLOOD_CAP); // size growth per second
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute("position", new THREE.BufferAttribute(bPos, 3));
  bGeo.setAttribute("aColor", new THREE.BufferAttribute(bCol, 3));
  bGeo.setAttribute("aSize", new THREE.BufferAttribute(bSize, 1));
  bGeo.setAttribute("aAlpha", new THREE.BufferAttribute(bAlpha, 1));
  const bMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: softDot("rgba(255,255,255,1)", "rgba(255,255,255,0.7)", "rgba(255,255,255,0)", 0.5, 48) } },
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vAlpha = aAlpha;
        vColor = aColor;
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
  });
  bMat.customProgramCacheKey = () => "gibBlood";
  const blood = new THREE.Points(bGeo, bMat);
  blood.frustumCulled = false;
  scene.add(blood);
  let bHead = 0;

  // Fast droplets that arc out and rain down.
  function spawnSpray(p: THREE.Vector3, count: number, radius: number): void {
    for (let i = 0; i < count; i++) {
      const k = bHead;
      bHead = (bHead + 1) % BLOOD_CAP;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.95 + 0.2, Math.random() - 0.5).normalize();
      const sp = radius * (0.6 + Math.random() * 1.7);
      _col.copy(_gDeep).lerp(_gFlesh, Math.random()).lerp(_gBright, Math.random() * 0.4);
      bPos[k * 3] = p.x + (Math.random() - 0.5) * 0.8;
      bPos[k * 3 + 1] = p.y + 1.4 + (Math.random() - 0.5) * 0.8;
      bPos[k * 3 + 2] = p.z + (Math.random() - 0.5) * 0.8;
      bVel[k * 3] = dir.x * sp; bVel[k * 3 + 1] = dir.y * sp; bVel[k * 3 + 2] = dir.z * sp;
      bCol[k * 3] = _col.r; bCol[k * 3 + 1] = _col.g; bCol[k * 3 + 2] = _col.b;
      bAge[k] = 0; bLife[k] = 0.7 + Math.random() * 1.2;
      bSize[k] = 2.0 + Math.random() * 3.2;
      bAlpha[k] = 1.0; bA0[k] = 1.0;
      bGrav[k] = 1.0; bGrow[k] = -0.4;
    }
  }

  // A big crimson burst that balloons outward at the kill, then dissipates.
  function spawnMist(p: THREE.Vector3, count: number, radius: number): void {
    for (let i = 0; i < count; i++) {
      const k = bHead;
      bHead = (bHead + 1) % BLOOD_CAP;
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6 + 0.15, Math.random() - 0.5).normalize();
      const sp = radius * (0.18 + Math.random() * 0.5);
      _col.copy(_gMist).lerp(_gMist2, Math.random() * 0.5);
      bPos[k * 3] = p.x + (Math.random() - 0.5) * 1.2;
      bPos[k * 3 + 1] = p.y + 1.6 + (Math.random() - 0.5) * 1.2;
      bPos[k * 3 + 2] = p.z + (Math.random() - 0.5) * 1.2;
      bVel[k * 3] = dir.x * sp; bVel[k * 3 + 1] = dir.y * sp; bVel[k * 3 + 2] = dir.z * sp;
      bCol[k * 3] = _col.r; bCol[k * 3 + 1] = _col.g; bCol[k * 3 + 2] = _col.b;
      bAge[k] = 0; bLife[k] = 0.45 + Math.random() * 0.45;
      // Cap the point size + growth so each mist puff doesn't balloon into a
      // huge full-screen transparent splat (overdraw spike during the burst).
      bSize[k] = radius * (0.4 + Math.random() * 0.4);
      bAlpha[k] = 0.7; bA0[k] = 0.7;
      bGrav[k] = 0.06; bGrow[k] = radius * 0.9;
    }
  }

  function spawn(killed: KilledUnicorn, parts: GibParts, blastPoint: THREE.Vector3, blastRadius: number, now: number, mode: GibMode = "gore"): void {
    const electro = mode === "electro";
    const chunkMat = electro ? charred : bloodied;
    const src = parts.geometry;
    const pos = src.getAttribute("position") as THREE.BufferAttribute;
    if (!src.boundingBox) src.computeBoundingBox();
    const bb = src.boundingBox!;
    const mw = killed.matrixWorld;
    const h = killed.heading;
    const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));

    // bin whole triangles (world-space verts) into regions
    const bins: number[][] = Array.from({ length: REGIONS }, () => []);
    for (let t = 0; t < pos.count; t += 3) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) { cx += pos.getX(t + k); cy += pos.getY(t + k); cz += pos.getZ(t + k); }
      const r = regionOf(cx / 3, cy / 3, cz / 3, bb);
      const arr = bins[r];
      for (let k = 0; k < 3; k++) {
        _v.set(pos.getX(t + k), pos.getY(t + k), pos.getZ(t + k)).applyMatrix4(mw);
        arr.push(_v.x, _v.y, _v.z);
      }
    }

    for (let r = 0; r < REGIONS; r++) {
      const arr = bins[r];
      if (arr.length < 12) continue; // too few triangles to matter

      // world centroid
      let sx = 0, sy = 0, sz = 0;
      const n = arr.length / 3;
      for (let i = 0; i < arr.length; i += 3) { sx += arr[i]; sy += arr[i + 1]; sz += arr[i + 2]; }
      sx /= n; sy /= n; sz /= n;

      // verts relative to centroid
      const rel = new Float32Array(arr.length);
      _box.makeEmpty();
      for (let i = 0; i < arr.length; i += 3) {
        rel[i] = arr[i] - sx; rel[i + 1] = arr[i + 1] - sy; rel[i + 2] = arr[i + 2] - sz;
        _box.expandByPoint(_v.set(rel[i], rel[i + 1], rel[i + 2]));
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(rel, 3));
      geo.computeVertexNormals();
      if (electro) charColors(geo); else gorifyColors(geo);

      const mesh = new THREE.Mesh(geo, chunkMat);
      mesh.castShadow = true;
      let obj: THREE.Object3D = mesh;
      if (r === 0) {
        // head: attach the horn pointing up-forward (tumbles with the chunk)
        const grp = new THREE.Group();
        grp.add(mesh);
        const horn = new THREE.Mesh(parts.hornGeo, parts.hornMat);
        horn.scale.setScalar(0.75 / 0.55);
        horn.rotation.order = "YXZ";
        horn.rotation.set(0.5, h, 0);
        horn.position.set(fwd.x * 0.25, 0.35, fwd.z * 0.25);
        horn.castShadow = true;
        grp.add(horn);
        obj = grp;
      }
      obj.position.set(sx, sy, sz);
      scene.add(obj);

      // collider: convex hull of the chunk (cuboid fallback if degenerate).
      // Subsample the points so the hull computation stays cheap — the result
      // is visually identical for a fast-tumbling chunk.
      const nPts = rel.length / 3;
      let hullPts = rel;
      if (nPts > 72) {
        const stride = Math.ceil(nPts / 72);
        const out: number[] = [];
        for (let i = 0; i < nPts; i += stride) out.push(rel[i * 3], rel[i * 3 + 1], rel[i * 3 + 2]);
        hullPts = new Float32Array(out);
      }
      let colDesc = RAPIER.ColliderDesc.convexHull(hullPts);
      if (!colDesc) {
        _box.getSize(_size);
        colDesc = RAPIER.ColliderDesc.cuboid(
          Math.max(_size.x * 0.5, 0.1),
          Math.max(_size.y * 0.5, 0.1),
          Math.max(_size.z * 0.5, 0.1),
        );
      }
      colDesc.setDensity(1.2).setFriction(0.7).setRestitution(0.2);

      const dx = sx - blastPoint.x, dz = sz - blastPoint.z;
      const len = Math.hypot(dx, dz) || 1;
      // Gentler dispersal than a full blast so the chunks stay clustered around
      // the kill and read as unmistakable gore rather than tiny distant specks.
      // Electrocution crumbles in place, so its chunks barely scatter.
      const disp = electro ? 0.45 : 1;
      const sp = blastRadius * (0.2 + Math.random() * 0.4) * disp;
      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(sx, sy, sz)
          .setLinvel((dx / len) * sp, blastRadius * (0.32 + Math.random() * 0.5) * disp, (dz / len) * sp)
          .setAngvel({ x: (Math.random() - 0.5) * 16, y: (Math.random() - 0.5) * 16, z: (Math.random() - 0.5) * 16 })
          .setLinearDamping(0.08)
          .setAngularDamping(0.25),
      );
      physics.world.createCollider(colDesc, body);
      physics.add({
        body,
        object: obj,
        kind: "gib",
        bornAt: now,
        maxLife: 6,
        fade: 1.5,
        onExpire: () => { scene.remove(obj); geo.dispose(); },
      });
    }

    // blood: a big mist burst + heavy spray, then ground gore (one large pool +
    // several splatters) in the dedicated blood-decal ring. Skipped entirely for
    // an electrocution — that death is charred + bloodless (electro.ts supplies
    // the sparks and the scorched ground mark instead).
    if (electro) return;
    const P = killed.position;
    spawnMist(P, 14, blastRadius);
    spawnSpray(P, 170, blastRadius);
    bGeo.attributes.aColor.needsUpdate = true;

    vfx.spawnBloodDecal(_ctr.set(P.x, P.y, P.z), blastRadius * 0.7 + 5, vfx.scorchTexture, 0x6e0808, 0.92);
    // A central pool + two splatters (plus the explosion's own scorch decal): each
    // is a cheap draped disc now, so the count is about looks, not cost.
    for (let s = 0; s < 2; s++) {
      const a = Math.random() * Math.PI * 2;
      const d = 2 + Math.random() * (blastRadius * 0.5);
      vfx.spawnBloodDecal(
        _ctr.set(P.x + Math.cos(a) * d, P.y, P.z + Math.sin(a) * d),
        3 + Math.random() * 5,
        vfx.splatTexture,
        0x8a1010,
        0.82,
      );
    }
  }

  function update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < BLOOD_CAP; i++) {
      if (bAge[i] >= bLife[i]) {
        if (bAlpha[i] !== 0) { bAlpha[i] = 0; bPos[i * 3 + 1] = -9999; dirty = true; }
        continue;
      }
      bAge[i] += dt;
      bVel[i * 3 + 1] -= 26 * bGrav[i] * dt; // gravity (mist barely falls)
      bPos[i * 3] += bVel[i * 3] * dt;
      bPos[i * 3 + 1] += bVel[i * 3 + 1] * dt;
      bPos[i * 3 + 2] += bVel[i * 3 + 2] * dt;
      bSize[i] = Math.max(0.05, bSize[i] + bGrow[i] * dt);
      bAlpha[i] = bA0[i] * (1 - bAge[i] / bLife[i]);
      dirty = true;
    }
    if (dirty) {
      bGeo.attributes.position.needsUpdate = true;
      bGeo.attributes.aAlpha.needsUpdate = true;
      bGeo.attributes.aSize.needsUpdate = true;
    }
  }

  return { spawn, update };
}
