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

// New waves gallop in from the rainbow side: outside the ±60 roaming area, but
// well inside the ±120 terrain (and clear of all three lakes).
function entranceLandPoint(out: THREE.Vector2): void {
  for (let i = 0; i < 40; i++) {
    const x = (Math.random() - 0.5) * 120;
    const z = -78 - Math.random() * 26;
    if (terrainHeight(x, z) > WATER_LEVEL + 1.4) {
      out.set(x, z);
      return;
    }
  }
  out.set(0, -90);
}

// ---------------------------------------------------------------------------
// Panic. Any impact scatters the herd nearby, which is what turns aiming into
// tactics: cheap uncharged shots shepherd them into a cluster, and the fully
// charged meteor cashes the cluster in.
// ---------------------------------------------------------------------------
const FLEE_MIN = 3; // seconds of blind panic …
const FLEE_VAR = 1; // … plus up to this much, so a scattered group re-calms raggedly
const FLEE_SPEED_MULT = 2.2;
const FLEE_SPEED_MIN = 9; // even a plodder bolts (its walk speed × 2.2 is still a stroll)
const FLEE_SPEED_MAX = 16;
const FLEE_DIST = 20; // how far ahead it aims when bolting …
const FLEE_DIST_VAR = 8;
const FLEE_BOUND = 70; // … while staying well inside the ±120 terrain
// Straight away first, then progressively more sideways (±30° … ±120°). A
// unicorn with its back to a lake or the map edge should bolt ALONG it, not
// wheel around through the fire — only a fully boxed-in one gives up and picks
// anywhere at all.
const FLEE_ANGLES = [0, 0.52, -0.52, 1.05, -1.05, 1.57, -1.57, 2.09, -2.09];
const GALLOP_FLEE_TIMESCALE = 1.35; // hooves keep up with the panicked ground speed

type Gait = "walk" | "gallop";

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
  walkAction: THREE.AnimationAction;
  gallopAction: THREE.AnimationAction;
  gait: Gait; // what's playing now
  restGait: Gait; // what it drifts back to once it calms down
  baseSpeed: number; // its unpanicked roaming speed
  fleeTimer: number; // > 0 = bolting
  fleeFromX: number; // the blast it's running from, so it keeps running AWAY
  fleeFromZ: number;
}

// Crossfade walk↔gallop. Both actions are always playing at weights 1/0, so
// panic is a blend rather than a snap.
function setGait(u: Unicorn, gait: Gait, fade: number): void {
  if (u.gait === gait) return;
  const from = u.gait === "gallop" ? u.gallopAction : u.walkAction;
  const to = gait === "gallop" ? u.gallopAction : u.walkAction;
  u.gait = gait;
  if (from === to) return; // both clips fell back to the same one — nothing to blend
  to.enabled = true;
  to.setEffectiveWeight(1);
  from.crossFadeTo(to, fade, false);
}

// Aim a bolting unicorn away from `dx,dz` (the vector from the blast to it),
// deflecting around water and the map edge rather than drowning itself.
function fleeTarget(u: Unicorn, dx: number, dz: number): void {
  let ax = dx;
  let az = dz;
  const len = Math.hypot(ax, az);
  if (len < 1e-3) {
    const a = Math.random() * Math.PI * 2; // struck dead-centre: any way but here
    ax = Math.cos(a);
    az = Math.sin(a);
  } else {
    ax /= len;
    az /= len;
  }
  const dist = FLEE_DIST + Math.random() * FLEE_DIST_VAR;
  const px = u.wrapper.position.x;
  const pz = u.wrapper.position.z;
  for (const off of FLEE_ANGLES) {
    const c = Math.cos(off);
    const s = Math.sin(off);
    const tx = px + (ax * c - az * s) * dist;
    const tz = pz + (ax * s + az * c) * dist;
    if (
      Math.abs(tx) <= FLEE_BOUND &&
      Math.abs(tz) <= FLEE_BOUND &&
      terrainHeight(tx, tz) > WATER_LEVEL + 1.4
    ) {
      u.target.set(tx, tz);
      return;
    }
  }
  randomLandPoint(u.target); // boxed in — just go somewhere
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
  chainDepth: number; // 0 = struck by the player, N = Nth link of a domino cascade
}

// Snapshot of a unicorn at the moment it is killed, used to spawn gibs.
export interface KilledUnicorn {
  position: THREE.Vector3; // world ground position
  heading: number; // wrapper yaw
  matrixWorld: THREE.Matrix4; // model-root world matrix: world = matrixWorld * rootLocalVert
  chainDepth: number; // how deep into a domino cascade this death was
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
  // chainDepth tags cascade victims so the score can pay out DOMINO ×N.
  electrocuteAt(point: THREE.Vector3, radius: number, chainDepth?: number): THREE.Vector3[];
  // Scatter the roaming herd away from an impact — the herding half of the game.
  scareAt(point: THREE.Vector3, radius: number): void;
  // Visit every currently-electrified unicorn (for per-frame crackle VFX).
  forEachElectrified(cb: (x: number, y: number, z: number, height: number) => void): void;
  // Visit every roaming (still-alive, not-yet-doomed) unicorn.
  forEachRoaming(cb: (x: number, y: number, z: number) => void): void;
  aliveCount(): number; // roaming + still-standing electrified
  roamingCount(): number; // just the ones still on their feet — a level's win condition
  // Add a wave, applying its difficulty knobs to the whole herd. `entrances`
  // makes them gallop in from the meadow edge instead of appearing in place.
  spawnWave(count: number, opts?: WaveOpts): void;
  // Clear the meadow entirely (starting a fresh run).
  reset(): void;
  getHorsePartsForGibs(): GibParts;
}

export interface WaveOpts {
  speedMult?: number;
  gallopFraction?: number; // 0..1 — how much of the wave gallops rather than walks
  scareRadiusMult?: number;
  entrances?: boolean;
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
  // Difficulty knobs: later levels field a faster, twitchier herd.
  let speedMult = 1;
  let scareRadiusMult = 1;

  function spawnUnicorn(opts: { gallop?: boolean; entrance?: boolean } = {}): void {
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

    // Both gaits run at once (weights 1/0) so panic can crossfade into a gallop
    // instead of snapping. Offset by the same phase fraction, so a unicorn that
    // switches gait mid-stride doesn't visibly reset its legs.
    const galloping = opts.gallop ?? Math.random() < 0.5;
    const mixer = new THREE.AnimationMixer(model);
    const fallback = gltf.animations[0];
    const walkClip = walk ?? fallback;
    const gallopClip = gallop ?? fallback;
    const walkAction = mixer.clipAction(walkClip);
    const gallopAction = mixer.clipAction(gallopClip);
    const phase = Math.random();
    walkAction.time = phase * walkClip.duration;
    gallopAction.time = phase * gallopClip.duration;
    walkAction.play();
    gallopAction.play();
    if (walkAction !== gallopAction) {
      // Distinct clips: blend between them.
      walkAction.timeScale = 1.0;
      gallopAction.timeScale = 1.1;
      walkAction.setEffectiveWeight(galloping ? 0 : 1);
      gallopAction.setEffectiveWeight(galloping ? 1 : 0);
    } else {
      // The rig only had one clip — keep it at full weight and just re-time it.
      walkAction.timeScale = galloping ? 1.1 : 1.0;
    }

    const start = new THREE.Vector2();
    if (opts.entrance) entranceLandPoint(start);
    else randomLandPoint(start);
    wrapper.position.set(start.x, terrainHeight(start.x, start.y), start.y);
    const target = new THREE.Vector2();
    randomLandPoint(target); // always head INTO the meadow, wherever it started

    const baseSpeed = galloping ? 6 + Math.random() * 3 : 1.8 + Math.random() * 1.2;
    const u: Unicorn = {
      wrapper,
      model,
      mesh,
      mixer,
      headBone,
      horn,
      speed: baseSpeed * speedMult,
      target,
      id: nextId++,
      flashMats,
      walkAction,
      gallopAction,
      gait: galloping ? "gallop" : "walk",
      restGait: galloping ? "gallop" : "walk",
      baseSpeed,
      fleeTimer: 0,
      fleeFromX: 0,
      fleeFromZ: 0,
    };
    unicorns.push(u);

    // Running in from the edge reuses the panic machinery: it gallops on at flee
    // speed, then settles into its natural gait once the timer burns off. (A
    // walker plodding 90 units in at 2/sec would eat most of the level's clock.)
    if (opts.entrance) {
      u.fleeTimer = FLEE_MIN + Math.random() * FLEE_VAR;
      u.fleeFromX = start.x;
      u.fleeFromZ = start.y - 20; // "behind" it, so away = deeper into the meadow
      u.speed =
        Math.min(Math.max(baseSpeed * FLEE_SPEED_MULT, FLEE_SPEED_MIN), FLEE_SPEED_MAX) * speedMult;
      setGait(u, "gallop", 0);
      u.gallopAction.timeScale = GALLOP_FLEE_TIMESCALE;
    }
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
        // Panic burns off: drop back to the spawn gait and go back to grazing.
        if (u.fleeTimer > 0) {
          u.fleeTimer -= dt;
          if (u.fleeTimer <= 0) {
            u.speed = u.baseSpeed * speedMult;
            u.gallopAction.timeScale = 1.1;
            setGait(u, u.restGait, 0.4);
            randomLandPoint(u.target);
          }
        }
        const g = u.wrapper;
        const dx = u.target.x - g.position.x;
        const dz = u.target.y - g.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 3) {
          // Still spooked on arrival? Keep running AWAY from the blast rather
          // than picking a random target that might lead back into it.
          if (u.fleeTimer > 0) {
            fleeTarget(u, g.position.x - u.fleeFromX, g.position.z - u.fleeFromZ);
          } else {
            randomLandPoint(u.target);
          }
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
            chainDepth: d.chainDepth,
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
          chainDepth: 0, // a roaming unicorn was never part of a cascade
        });
        u.mixer.stopAllAction();
        scene.remove(u.wrapper, u.horn);
        unicorns.splice(i, 1);
      }
      // A meteor also shatters any unicorn mid-electrocution in range — otherwise
      // it stands invulnerable for its convulsion (up to ~3s) and the hit reads
      // as a miss. It gibs bloodily now instead of finishing its electric pop.
      for (let i = dying.length - 1; i >= 0; i--) {
        const d = dying[i];
        const u = d.unicorn;
        const dx = u.wrapper.position.x - point.x;
        const dz = u.wrapper.position.z - point.z;
        if (dx * dx + dz * dz > r2) continue;
        u.wrapper.updateWorldMatrix(true, true);
        killed.push({
          position: u.wrapper.position.clone(),
          heading: u.wrapper.rotation.y,
          matrixWorld: u.model.matrixWorld.clone(),
          chainDepth: d.chainDepth, // cut short mid-cascade — it still earned its link
        });
        u.mixer.stopAllAction();
        scene.remove(u.wrapper, u.horn);
        dying.splice(i, 1);
      }
      return killed;
    },
    electrocuteAt(point: THREE.Vector3, radius: number, chainDepth = 0): THREE.Vector3[] {
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
          chainDepth,
        });
        hits.push(new THREE.Vector3(bx, by, bz));
        unicorns.splice(i, 1);
      }
      return hits;
    },
    scareAt(point: THREE.Vector3, radius: number): void {
      const r = radius * scareRadiusMult;
      const r2 = r * r;
      for (const u of unicorns) {
        const dx = u.wrapper.position.x - point.x;
        const dz = u.wrapper.position.z - point.z;
        if (dx * dx + dz * dz > r2) continue;
        u.fleeTimer = FLEE_MIN + Math.random() * FLEE_VAR;
        u.fleeFromX = point.x;
        u.fleeFromZ = point.z;
        u.speed =
          Math.min(Math.max(u.baseSpeed * FLEE_SPEED_MULT, FLEE_SPEED_MIN), FLEE_SPEED_MAX) *
          speedMult;
        fleeTarget(u, dx, dz);
        setGait(u, "gallop", 0.25);
        u.gallopAction.timeScale = GALLOP_FLEE_TIMESCALE;
      }
    },
    forEachElectrified(cb: (x: number, y: number, z: number, height: number) => void): void {
      for (const d of dying) {
        const p = d.unicorn.wrapper.position;
        cb(p.x, p.y, p.z, ELECTRIFIED_H);
      }
    },
    forEachRoaming(cb: (x: number, y: number, z: number) => void): void {
      for (const u of unicorns) {
        const p = u.wrapper.position;
        cb(p.x, p.y, p.z);
      }
    },
    aliveCount() {
      return unicorns.length + dying.length;
    },
    roamingCount() {
      return unicorns.length;
    },
    spawnWave(count: number, opts: WaveOpts = {}): void {
      speedMult = opts.speedMult ?? 1;
      scareRadiusMult = opts.scareRadiusMult ?? 1;
      const gallopFraction = opts.gallopFraction ?? 0.5;
      // The knobs apply to the standing herd too, so a Zen top-up can't leave
      // old unicorns running at a stale difficulty.
      for (const u of unicorns) if (u.fleeTimer <= 0) u.speed = u.baseSpeed * speedMult;
      for (let i = 0; i < count; i++) {
        spawnUnicorn({ gallop: Math.random() < gallopFraction, entrance: opts.entrances });
      }
    },
    reset(): void {
      for (const u of unicorns) {
        u.mixer.stopAllAction();
        scene.remove(u.wrapper, u.horn);
      }
      for (const d of dying) {
        d.unicorn.mixer.stopAllAction();
        scene.remove(d.unicorn.wrapper, d.unicorn.horn);
      }
      unicorns.length = 0;
      dying.length = 0;
    },
    getHorsePartsForGibs,
  };
}
