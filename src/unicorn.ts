import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { loadGLTF } from "./assets";
import { terrainHeight, WATER_LEVEL } from "./terrain";

const HORSE_URL = "/models/unicorn_base.glb";
const TARGET_H = 2.8; // world-space withers height

// Horn placement (world-space, relative to the animated head bone). The horn is
// NOT parented to the bone because Quaternius rigs carry large bone scales.
const HORN_UP = 0.18; // world units above the head bone
const HORN_FWD = 0.16; // world units forward along facing
const HORN_TILT = 0.5; // forward pitch (toward +Z facing)
const HORN_WORLD_SIZE = 0.75;

// Electrocution death: a struck unicorn stands convulsing + crackling for a beat
// before it blows apart, instead of dying instantly like under a meteor.
const ELECTRIFIED_MIN = 1.8; // seconds it stands electrified …
const ELECTRIFIED_VAR = 1.2; // … plus up to this much, so a struck group doesn't pop in unison
const ELECTRIFIED_H = 3.0; // body height the crawling arcs cover
const _eFlash = new THREE.Color(0x3aa6ff);

const _v = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Gold spiral horn (built once, shared)
// ---------------------------------------------------------------------------
function makeHornGeometry(): THREE.BufferGeometry {
  const cone = new THREE.ConeGeometry(0.08, 0.55, 10).translate(0, 0.275, 0);
  const pts: THREE.Vector3[] = [];
  const turns = 4;
  const seg = 64;
  const height = 0.55;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = t * turns * Math.PI * 2;
    const r = 0.085 * (1 - t * 0.9);
    pts.push(new THREE.Vector3(Math.cos(a) * r, t * height, Math.sin(a) * r));
  }
  const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 90, 0.02, 6, false);
  return mergeGeometries([cone, tube], false);
}
const HORN_GEO = makeHornGeometry();
const HORN_NATIVE_H = 0.55;
const hornMat = new THREE.MeshStandardMaterial({
  color: 0xffd34d,
  roughness: 0.22,
  metalness: 0.7,
  emissive: 0x6a4a00,
  emissiveIntensity: 0.4,
});

// Flowing rainbow mane: a shader on the shared "Hair" material so every
// unicorn gets it. Colours cycle along the strands (flowing) and the mane
// drifts with a gentle wave.
const maneTime = { value: 0 };

function applyRainbowMane(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = maneTime;
    shader.vertexShader = ("varying vec3 vMane;\n" + shader.vertexShader).replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vMane = position;",
    );
    shader.fragmentShader = (
      "uniform float uTime;\nvarying vec3 vMane;\nvec3 rainbowMane(float t){ return 0.55 + 0.45 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }\n" +
      shader.fragmentShader
    )
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n  vec3 maneCol = rainbowMane(vMane.y * 1.1 + vMane.x * 0.4 + uTime * 0.25);\n  diffuseColor.rgb = maneCol;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n  totalEmissiveRadiance += maneCol * 0.25;",
      );
  };
  mat.customProgramCacheKey = () => "rainbowMane";
  mat.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Recolour the horse into a unicorn (white coat, rainbow mane).
// ---------------------------------------------------------------------------
function unicornify(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const mat = m as THREE.MeshStandardMaterial;
      switch (mat.name) {
        case "Main":
        case "Main_Light":
          mat.color.set(0xfff4fb);
          break;
        case "Hair":
          applyRainbowMane(mat);
          break;
        case "Muzzle":
          mat.color.set(0xf6c6d6);
          break;
      }
    }
  });
}

function approachAngle(current: number, target: number, t: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * Math.min(t, 1);
}

function randomLandPoint(out: THREE.Vector2): void {
  for (let i = 0; i < 40; i++) {
    const x = (Math.random() - 0.5) * 120;
    const z = (Math.random() - 0.5) * 120;
    if (terrainHeight(x, z) > WATER_LEVEL + 1.4) {
      out.set(x, z);
      return;
    }
  }
  out.set(0, 0);
}

interface Unicorn {
  wrapper: THREE.Group;
  model: THREE.Object3D;
  mesh: THREE.SkinnedMesh | null;
  mixer: THREE.AnimationMixer;
  headBone: THREE.Object3D;
  horn: THREE.Mesh;
  speed: number;
  target: THREE.Vector2;
  id: number;
  flashMats: THREE.MeshStandardMaterial[]; // per-unicorn body materials, flashed while electrified
}

// Pin the world-space horn onto the forehead, following the animated head bone
// and the body's current yaw. Shared by the roaming + convulsing update paths.
function placeHorn(u: Unicorn, yaw: number): void {
  u.headBone.updateWorldMatrix(true, false);
  u.headBone.getWorldPosition(_v);
  _v.x += Math.sin(yaw) * HORN_FWD;
  _v.z += Math.cos(yaw) * HORN_FWD;
  _v.y += HORN_UP;
  u.horn.position.copy(_v);
  u.horn.rotation.set(HORN_TILT, yaw, 0);
}

// A unicorn mid-electrocution: frozen in place, convulsing + crackling, counting
// down to its explosion.
interface Dying {
  unicorn: Unicorn;
  t: number; // elapsed electrified time
  dur: number; // total before it blows apart
  baseX: number;
  baseY: number;
  baseZ: number;
}

// Snapshot of a unicorn at the moment it is killed, used to spawn gibs.
export interface KilledUnicorn {
  position: THREE.Vector3; // world ground position
  heading: number; // wrapper yaw
  matrixWorld: THREE.Matrix4; // model-root world matrix: world = matrixWorld * rootLocalVert
}

// Rest-pose geometry for geometry-accurate gibs (cached once, shared).
export interface GibParts {
  geometry: THREE.BufferGeometry; // merged triangle soup in model-root-local space
  hornGeo: THREE.BufferGeometry;
  hornMat: THREE.Material;
}

export interface Herd {
  // Roams the living herd and advances any electrocuted unicorns; returns the
  // ones that finished convulsing and exploded THIS frame (caller spawns gibs).
  update(dt: number, time: number): KilledUnicorn[];
  // Meteor: instant gory kill. Returns the unicorns removed this call.
  killAt(point: THREE.Vector3, radius: number): KilledUnicorn[];
  // Water ball: mark unicorns in range as standing-electrified (they explode a
  // few seconds later via update). Returns their positions for the zap bolts.
  electrocuteAt(point: THREE.Vector3, radius: number): THREE.Vector3[];
  // Visit every currently-electrified unicorn (for per-frame crackle VFX).
  forEachElectrified(cb: (x: number, y: number, z: number, height: number) => void): void;
  aliveCount(): number; // roaming + still-standing electrified
  getHorsePartsForGibs(): GibParts;
}

export async function createHerd(scene: THREE.Scene, count: number): Promise<Herd> {
  const gltf = await loadGLTF(HORSE_URL);
  const template = gltf.scene;
  unicornify(template);

  // Normalize scale + base offset, and auto-detect which way the model faces.
  template.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(template);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = TARGET_H / Math.max(size.y, 1e-4);
  const baseY = box.min.y * scale;

  const head = template.getObjectByName("Head");
  const body = template.getObjectByName("Body") ?? template;
  const hp = new THREE.Vector3();
  const bp = new THREE.Vector3();
  head?.getWorldPosition(hp);
  body.getWorldPosition(bp);
  const faceYaw = Math.atan2(hp.x - bp.x, hp.z - bp.z); // model forward angle

  const gallop = gltf.animations.find((c) => /(^|\|)gallop$/i.test(c.name));
  const walk = gltf.animations.find((c) => /(^|\|)walk$/i.test(c.name));

  const unicorns: Unicorn[] = []; // roaming, alive
  const dying: Dying[] = []; // electrocuted, standing + convulsing until they pop
  let nextId = 0;

  function spawnUnicorn(): void {
    const model = cloneSkeleton(template);
    let mesh: THREE.SkinnedMesh | null = null;
    // Clone the body materials per unicorn so one can flash electric-blue while
    // electrified without lighting up the whole herd (the shared rainbow mane +
    // muzzle stay shared). Unicorns are individual meshes, so this adds no draw
    // calls, and the clones share the compiled program (identical features).
    const flashMats: THREE.MeshStandardMaterial[] = [];
    model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) mesh = sm;
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const swapped = mats.map((mat) => {
        const std = mat as THREE.MeshStandardMaterial;
        if (std.name === "Main" || std.name === "Main_Light") {
          const c = std.clone();
          flashMats.push(c);
          return c;
        }
        return mat;
      });
      m.material = Array.isArray(m.material) ? swapped : swapped[0];
    });

    const inner = new THREE.Group();
    inner.scale.setScalar(scale);
    inner.position.y = -baseY;
    inner.rotation.y = -faceYaw; // align model forward to +Z
    inner.add(model);

    const wrapper = new THREE.Group();
    wrapper.add(inner);
    scene.add(wrapper);

    // Horn lives in world space and tracks the head bone each frame.
    const horn = new THREE.Mesh(HORN_GEO, hornMat);
    horn.castShadow = true;
    horn.scale.setScalar(HORN_WORLD_SIZE / HORN_NATIVE_H);
    horn.rotation.order = "YXZ";
    scene.add(horn);
    const headBone = model.getObjectByName("Head") ?? inner;

    const galloping = Math.random() < 0.5;
    const mixer = new THREE.AnimationMixer(model);
    const clip = (galloping ? gallop : walk) ?? gltf.animations[0];
    const action = mixer.clipAction(clip);
    action.time = Math.random() * clip.duration;
    action.timeScale = galloping ? 1.1 : 1.0;
    action.play();

    const start = new THREE.Vector2();
    randomLandPoint(start);
    wrapper.position.set(start.x, terrainHeight(start.x, start.y), start.y);
    const target = new THREE.Vector2();
    randomLandPoint(target);

    unicorns.push({
      wrapper,
      model,
      mesh,
      mixer,
      headBone,
      horn,
      speed: galloping ? 6 + Math.random() * 3 : 1.8 + Math.random() * 1.2,
      target,
      id: nextId++,
      flashMats,
    });
  }

  for (let i = 0; i < count; i++) spawnUnicorn();

  // Merge the horse's primitive geometries (position only) into one triangle
  // soup expressed in model-root-local space. At death, `world = matrixWorld *
  // rootLocalVert` recovers the rest pose at the visible scale. Cached once.
  let cachedGib: GibParts | null = null;
  function getHorsePartsForGibs(): GibParts {
    if (cachedGib) return cachedGib;
    template.updateMatrixWorld(true);
    const invRoot = template.matrixWorld.clone().invert();
    const geos: THREE.BufferGeometry[] = [];
    template.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!pos) return;
      const ng = new THREE.BufferGeometry();
      ng.setAttribute("position", pos.clone());
      if (mesh.geometry.index) ng.setIndex(mesh.geometry.index.clone());
      ng.applyMatrix4(invRoot.clone().multiply(mesh.matrixWorld));
      geos.push(ng.toNonIndexed());
    });
    const merged = (geos.length > 1 ? mergeGeometries(geos, false) : geos[0]) ?? geos[0];
    merged.computeVertexNormals();
    merged.computeBoundingBox();
    cachedGib = { geometry: merged, hornGeo: HORN_GEO, hornMat };
    return cachedGib;
  }

  return {
    update(dt: number, time: number): KilledUnicorn[] {
      maneTime.value = time;
      // Roam the living herd.
      for (const u of unicorns) {
        u.mixer.update(dt);
        const g = u.wrapper;
        const dx = u.target.x - g.position.x;
        const dz = u.target.y - g.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 3) {
          randomLandPoint(u.target);
        } else {
          const inv = 1 / dist;
          const vx = dx * inv;
          const vz = dz * inv;
          g.position.x += vx * u.speed * dt;
          g.position.z += vz * u.speed * dt;
          g.rotation.y = approachAngle(g.rotation.y, Math.atan2(vx, vz), dt * 2.5);
        }
        g.position.y = terrainHeight(g.position.x, g.position.z);

        placeHorn(u, g.rotation.y);
      }

      // Advance electrocuted unicorns: convulse + flash in place, then explode.
      const exploded: KilledUnicorn[] = [];
      for (let i = dying.length - 1; i >= 0; i--) {
        const d = dying[i];
        d.t += dt;
        const u = d.unicorn;
        const g = u.wrapper;
        // Convulsion: a fast jitter around the spot it was struck.
        g.position.set(
          d.baseX + (Math.random() - 0.5) * 0.08,
          d.baseY,
          d.baseZ + (Math.random() - 0.5) * 0.08,
        );
        g.rotation.z = (Math.random() - 0.5) * 0.14;
        // Flash the body electric-blue, flickering hard.
        const flick = 0.6 + Math.random() * 1.9;
        for (const m of u.flashMats) {
          m.emissive.copy(_eFlash);
          m.emissiveIntensity = flick;
        }
        // Keep the horn pinned to the (frozen, jittering) head.
        const yaw = g.rotation.y;
        placeHorn(u, yaw);

        if (d.t >= d.dur) {
          g.updateWorldMatrix(true, true);
          exploded.push({
            position: new THREE.Vector3(d.baseX, d.baseY, d.baseZ),
            heading: yaw,
            matrixWorld: u.model.matrixWorld.clone(),
          });
          scene.remove(g, u.horn);
          dying.splice(i, 1);
        }
      }
      return exploded;
    },
    killAt(point: THREE.Vector3, radius: number): KilledUnicorn[] {
      const killed: KilledUnicorn[] = [];
      const r2 = radius * radius;
      for (let i = unicorns.length - 1; i >= 0; i--) {
        const u = unicorns[i];
        const dx = u.wrapper.position.x - point.x;
        const dz = u.wrapper.position.z - point.z;
        if (dx * dx + dz * dz > r2) continue;
        u.wrapper.updateWorldMatrix(true, true);
        killed.push({
          position: u.wrapper.position.clone(),
          heading: u.wrapper.rotation.y,
          matrixWorld: u.model.matrixWorld.clone(),
        });
        u.mixer.stopAllAction();
        scene.remove(u.wrapper, u.horn);
        unicorns.splice(i, 1);
      }
      // A meteor also shatters any unicorn mid-electrocution in range — otherwise
      // it stands invulnerable for its convulsion (up to ~3s) and the hit reads
      // as a miss. It gibs bloodily now instead of finishing its electric pop.
      for (let i = dying.length - 1; i >= 0; i--) {
        const u = dying[i].unicorn;
        const dx = u.wrapper.position.x - point.x;
        const dz = u.wrapper.position.z - point.z;
        if (dx * dx + dz * dz > r2) continue;
        u.wrapper.updateWorldMatrix(true, true);
        killed.push({
          position: u.wrapper.position.clone(),
          heading: u.wrapper.rotation.y,
          matrixWorld: u.model.matrixWorld.clone(),
        });
        u.mixer.stopAllAction();
        scene.remove(u.wrapper, u.horn);
        dying.splice(i, 1);
      }
      return killed;
    },
    electrocuteAt(point: THREE.Vector3, radius: number): THREE.Vector3[] {
      const hits: THREE.Vector3[] = [];
      const r2 = radius * radius;
      for (let i = unicorns.length - 1; i >= 0; i--) {
        const u = unicorns[i];
        const dx = u.wrapper.position.x - point.x;
        const dz = u.wrapper.position.z - point.z;
        if (dx * dx + dz * dz > r2) continue;
        // Freeze the gallop where it stands; it convulses in update() instead.
        const bx = u.wrapper.position.x, by = u.wrapper.position.y, bz = u.wrapper.position.z;
        dying.push({
          unicorn: u,
          t: 0,
          dur: ELECTRIFIED_MIN + Math.random() * ELECTRIFIED_VAR,
          baseX: bx,
          baseY: by,
          baseZ: bz,
        });
        hits.push(new THREE.Vector3(bx, by, bz));
        unicorns.splice(i, 1);
      }
      return hits;
    },
    forEachElectrified(cb: (x: number, y: number, z: number, height: number) => void): void {
      for (const d of dying) {
        const p = d.unicorn.wrapper.position;
        cb(p.x, p.y, p.z, ELECTRIFIED_H);
      }
    },
    aliveCount() {
      return unicorns.length + dying.length;
    },
    getHorsePartsForGibs,
  };
}
