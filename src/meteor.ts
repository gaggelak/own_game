import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Physics, PhysicsHandle } from "./physics";
import { loadScene } from "./assets";
import { terrainHeight } from "./terrain";
import { softDot } from "./textures";

// ---------------------------------------------------------------------------
// God-hand lava meteor. Hold the left button to CONJURE a molten orb at a fixed
// slot in front of the camera; while held it GATHERS into a ball — loose rocks
// orbit, spiral inward and melt into a growing molten sphere — and a force
// meter fills. The cursor AIMS: a dotted ballistic arc + landing ring preview
// exactly where the shot will land and how big the blast will be. Release to
// HURL it along the shown arc — deterministic, so the same aim + the same force
// always lands the same spot, and a quick tap fires a short shot instantly. It
// detonates on the analytic ground test (the collider ignores the terrain so it
// never bounces). Bigger force → farther AND bigger blast.
// ---------------------------------------------------------------------------

const G = 22; // matches world gravity magnitude (physics.ts)
const DEG = Math.PI / 180;
const LIFT_MIN = 6; // keep it at least this far above the ground beneath it
const ORB_R = 1.2; // physics collider radius
const POOL_SIZE = 13; // up to MAX_FLYING airborne + 1 charging
const MAX_FLYING = 12; // beyond this, the oldest detonates instead of vanishing
const TRAIL_LEN = 28;

const CHARGE_TIME = 0.9; // seconds of holding to reach full force

// Throw solve: direction comes from the cursor's ground point, speed from the
// force meter. The launch angle is FIXED so every throw flies the same shape —
// aim and force are the only two knobs, which is what makes it learnable.
// (If tuning ever wants force linear in DISTANCE instead of speed, the swap is
// v = sqrt(lerp(MIN_V², MAX_V², force)).)
const LAUNCH_ANGLE = 42; // deg
const SIN_A = Math.sin(LAUNCH_ANGLE * DEG);
const COS_A = Math.cos(LAUNCH_ANGLE * DEG);
const MIN_FORCE = 0.15; // force floor: a tap still fires a useful short shot
const MIN_V = 14; // launch speed at zero force
const MAX_V = 56; // full force: flat range ≈ v²·sin(2·42°)/G ≈ 141 — the meadow's far side

// The orb charges at a FIXED camera-relative slot (lower-centre of the screen),
// so the launch origin is stable and reproducible while the cursor aims freely.
const ANCHOR_NDC_Y = -0.45;
const ANCHOR_DIST = 14; // world units along that ray from the camera

// Trajectory preview. PREVIEW_STEP must equal the physics timestep (physics.ts)
// — the march integrates exactly like Rapier so the drawn arc IS the flight.
const PREVIEW_STEP = 1 / 60;
const MAX_PREVIEW_STEPS = 400; // 6.7 s of flight — covers a full slingshot lob
const ARC_DOT_SPACING = 2.0; // world units between arc dots
const MAX_ARC_DOTS = 224; // a 65° lob's arc length, at the spacing above
const ARC_FLOW_SPEED = 10; // u/s of dot-flow phase toward the landing point
const RING_DOTS = 48;
const RING_LIFT = 0.3; // ring dots hover this far above the terrain
const HOVER_DOTS = 16; // small aim marker under the cursor between gestures
const HOVER_R = 1.5;

// ---- Throw styles (T cycles) — three models to A/B/C the feel --------------
// charge    — hold = force (distance + radius), the cursor aims live.
// slingshot — press LOCKS the ring where the cursor was; dragging DOWN flattens
//             and speeds the arc, dragging UP lobs it (drag OFFSET, not flick
//             velocity: visible, stable, reversible). Hold time = blast radius.
// hurl      — the cursor IS the landing point, live until release; flight time
//             is short and near-constant so every throw SLAMS down where you
//             point. Hold time = blast radius.
export type ThrowMode = "charge" | "slingshot" | "hurl";
const THROW_MODES: ThrowMode[] = ["charge", "slingshot", "hurl"];
const SLING_DRAG_PX = 220; // pixels of drag for a full flat/lob deflection
const SLING_ANGLE_NEUTRAL = 42;
const SLING_ANGLE_FLAT = 20; // full down-drag: fast and flat
const SLING_ANGLE_LOB = 65; // full up-drag: slow mortar lob
const HURL_AVG_SPEED = 95; // u/s of horizontal travel — sets the slam's pace
const HURL_T_MIN = 0.38; // s: close slams arrive almost instantly
const HURL_T_MAX = 1.05; // s: even cross-meadow slams stay quick

// Blast radius grows mostly with charge, a little with impact speed.
const BASE_RADIUS = 7;
const CHARGE_RADIUS = 7;
const RADIUS_PER_SPEED = 0.08;
const RADIUS_MIN = 8;
const RADIUS_MAX = 22;

const FRAGS = 16; // loose rocks/droplets that spiral in and merge INTO the ball while charging
const EMBERS = 26;

// Electric arcs that crackle around the water/electric orb (regenerated each
// frame). Bolts × sub-segments → total line segments.
const ARC_BOLTS = 5;
const ARC_SUB = 4;
const ARC_SEG = ARC_BOLTS * ARC_SUB;

// The core is a molten lava BALL (icosphere below); the loose rocks that gather
// and melt into it are imported Kenney models, so the scene still reads as real
// stone coalescing rather than hand-built primitives.
const CHUNK_URL = "/models/nature/rock_smallB.glb"; // the gathering rocks

// The god-hand can hurl two projectiles: the molten "meteor" and an "waterball"
// — a crackling electric water orb that electrocutes unicorns on impact. Both
// share all the gesture/physics/trail machinery below; only the orb's look and
// the impact effect (dispatched to main.ts via onImpact's `kind`) differ.
export type WeaponKind = "meteor" | "waterball";

export interface MeteorSystem {
  /** dt is sim time (freezes with hitstop); dtReal drives the charge gesture. */
  update(dt: number, time: number, dtReal: number): void;
  setWeapon(kind: WeaponKind): void;
  getWeapon(): WeaponKind;
  /** Cancels any charge in progress, advances to the next style, returns it. */
  cycleThrowMode(): ThrowMode;
  getThrowMode(): ThrowMode;
  dispose(): void;
}

// What the throw itself was like, for whoever scores the impact: how long it
// was charged, and where it was hurled from (so a cross-meadow shot can pay
// out as one). Cloned at launch — the orb's own position is overwritten in
// flight, and detonateOldest() fires long after launch()'s scope is gone.
export interface ImpactInfo {
  charge: number; // 0..1
  launchPos: THREE.Vector3;
}

export interface MeteorOpts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  physics: Physics;
  domElement: HTMLElement;
  onImpact: (
    point: THREE.Vector3,
    velocity: THREE.Vector3,
    radius: number,
    kind: WeaponKind,
    info: ImpactInfo,
  ) => void;
}

// Meteor sprites share the base gradient but sit at midStop 0.4 with a warm
// (or, for the water ball, cool) transparent edge.
function makeSoftDot(hot: string, mid: string, outer = "rgba(255,80,0,0)"): THREE.CanvasTexture {
  return softDot(hot, mid, outer, 0.4);
}

// Load an imported rock model, merge its meshes into one centred geometry and
// scale it so its bounding sphere ≈ `radius`. Centred (not base-at-y=0) so the
// meteor tumbles around its own middle. Position-only + recomputed normals so
// the molten material flat-shades cleanly.
async function loadMeteorRock(url: string, radius: number): Promise<THREE.BufferGeometry> {
  const root = await loadScene(url);
  root.updateMatrixWorld(true);
  const geos: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const ng = new THREE.BufferGeometry();
    ng.setAttribute("position", pos.clone());
    if (mesh.geometry.index) ng.setIndex(mesh.geometry.index.clone());
    ng.applyMatrix4(mesh.matrixWorld);
    geos.push(ng.toNonIndexed());
  });
  const merged =
    geos.length > 1 ? mergeGeometries(geos, false) : (geos[0] ?? new THREE.IcosahedronGeometry(radius, 1));
  merged.computeBoundingBox();
  const c = new THREE.Vector3();
  merged.boundingBox!.getCenter(c);
  merged.translate(-c.x, -c.y, -c.z);
  merged.computeBoundingSphere();
  const s = radius / Math.max(merged.boundingSphere!.radius, 1e-4);
  merged.scale(s, s, s);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

// Molten-rock material: a dark basalt body with glowing lava veins injected as
// emissive. The veins ride a cheap 3D value-noise fbm in object space (so they
// stay fixed to the rock as it tumbles/scales) and flow + flicker with `uTime`;
// `uGlow` scales their brightness so a charging orb can pulse hotter than ones
// already in flight. Bloom postprocessing turns the veins into real heat-glow,
// so the additive halo can stay subtle instead of smearing the whole orb.
// Cheap object-space value-noise fbm, shared verbatim by the lava veins and the
// electric filaments. Each orb material compiles as its own program (distinct
// customProgramCacheKey), so reusing the `vn*` names across both is safe.
const NOISE_GLSL = `
float vnHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vnHash(i + vec3(0.,0.,0.)), vnHash(i + vec3(1.,0.,0.)), f.x),
                 mix(vnHash(i + vec3(0.,1.,0.)), vnHash(i + vec3(1.,1.,0.)), f.x), f.y),
             mix(mix(vnHash(i + vec3(0.,0.,1.)), vnHash(i + vec3(1.,0.,1.)), f.x),
                 mix(vnHash(i + vec3(0.,1.,1.)), vnHash(i + vec3(1.,1.,1.)), f.x), f.y), f.z);
}
float vnFbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnNoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

const lavaTime = { value: 0 };
const LAVA_PRELUDE = `
uniform float uTime;
uniform float uGlow;
varying vec3 vLavaPos;
` + NOISE_GLSL;
const LAVA_EMISSIVE = `
  float lavaN = vnFbm(vLavaPos * 2.6 + vec3(0.0, uTime * 0.22, 0.0));
  float vein = pow(1.0 - smoothstep(0.0, 0.17, abs(lavaN - 0.5)), 1.4);
  float flick = 0.7 + 0.3 * sin(uTime * 5.0 + lavaN * 10.0);
  vec3 lavaCol = mix(vec3(0.85, 0.10, 0.0), vec3(1.0, 0.72, 0.18), vein);
  totalEmissiveRadiance += lavaCol * vein * flick * uGlow;
`;

function applyLava(mat: THREE.MeshStandardMaterial, glow: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = lavaTime;
    shader.uniforms.uGlow = glow;
    shader.vertexShader = ("varying vec3 vLavaPos;\n" + shader.vertexShader).replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vLavaPos = position;",
    );
    shader.fragmentShader = (LAVA_PRELUDE + shader.fragmentShader).replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>" + LAVA_EMISSIVE,
    );
  };
  mat.customProgramCacheKey = () => "meteorLava";
  mat.needsUpdate = true;
}

// Electric-water material: a deep translucent blue body lit from within by fast
// crackling cyan filaments (the same cheap object-space fbm as the lava veins,
// but thinner + much faster so they read as electricity) plus a fresnel rim so
// the orb glows watery at its silhouette. `uGlow` scales the charge brightness;
// bloom turns the filaments + rim into real glow. `cameraPosition` is a built-in
// uniform three.js injects into every material's fragment shader.
const elecTime = { value: 0 };
const ELEC_PRELUDE = `
uniform float uTime;
uniform float uGlow;
varying vec3 vElecPos;
varying vec3 vElecN;
varying vec3 vElecW;
` + NOISE_GLSL;
const ELEC_EMISSIVE = `
  float eN = vnFbm(vElecPos * 3.0 + vec3(0.0, uTime * 0.6, uTime * 0.2));
  float fil = pow(1.0 - smoothstep(0.0, 0.10, abs(eN - 0.5)), 2.2);
  float flick = 0.6 + 0.4 * sin(uTime * 22.0 + eN * 30.0);
  vec3 elecCol = mix(vec3(0.15, 0.55, 1.0), vec3(0.7, 0.95, 1.0), fil);
  float fres = pow(1.0 - max(dot(normalize(vElecN), normalize(cameraPosition - vElecW)), 0.0), 2.5);
  totalEmissiveRadiance += elecCol * fil * flick * uGlow;
  totalEmissiveRadiance += vec3(0.15, 0.5, 0.85) * fres * (0.55 + 0.45 * uGlow);
`;

function applyElectric(mat: THREE.MeshStandardMaterial, glow: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = elecTime;
    shader.uniforms.uGlow = glow;
    shader.vertexShader = (
      "varying vec3 vElecPos;\nvarying vec3 vElecN;\nvarying vec3 vElecW;\n" + shader.vertexShader
    ).replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vElecPos = position;\n  vElecN = mat3(modelMatrix) * normal;\n  vElecW = (modelMatrix * vec4(transformed, 1.0)).xyz;",
    );
    shader.fragmentShader = (ELEC_PRELUDE + shader.fragmentShader).replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>" + ELEC_EMISSIVE,
    );
  };
  mat.customProgramCacheKey = () => "meteorElectric";
  mat.needsUpdate = true;
}

interface Frag {
  mesh: THREE.Mesh;
  ang: number; // orbit angle
  rad: number; // starting orbit radius (before it plunges in)
  spin: number; // angular speed while orbiting
  y: number; // starting vertical offset
  base: number; // full scale before it melts in
  t0: number; // charge fraction at which this rock begins its final plunge (staggers the stream)
}

interface Orb {
  group: THREE.Group;
  core: THREE.Mesh; // the molten lava ball (grows as it accretes while charging)
  coreMat: THREE.MeshStandardMaterial;
  coreGlow: { value: number }; // per-orb lava brightness (charging orb pulses hotter)
  haloMat: THREE.MeshBasicMaterial;
  frags: Frag[];
  embers: THREE.Points;
  emAng: Float32Array;
  emRad: Float32Array;
  emY: Float32Array;
  emVy: Float32Array;
  emSpin: Float32Array;
  trail: THREE.Points;
  trailPos: Float32Array;
  trailCol: Float32Array;
  head: number;
  free: boolean;
  kind: WeaponKind;
  arcs: THREE.LineSegments | null; // electric bolts around the orb (water ball only)
  arcPos: Float32Array | null;
}

interface Flying {
  orb: Orb;
  handle: PhysicsHandle;
  charge: number;
  launchPos: THREE.Vector3; // cloned at launch; the orb's own position moves
}

const _ndc = new THREE.Vector2();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _trailC = new THREE.Color(); // scratch; per-weapon trail colours live in WEAPONS

// Slingshot solve: the launch speed that carries `start` through `target` at
// `angleDeg`. Deliberately UNCAPPED — a silent speed cap would land short of
// the locked ring; the caller keeps angles solvable instead. False only when
// the target sits too far above the start for this angle.
function solveAtAngle(
  start: THREE.Vector3,
  target: THREE.Vector3,
  angleDeg: number,
  out: THREE.Vector3,
): boolean {
  const dx = target.x - start.x;
  const dz = target.z - start.z;
  const R = Math.hypot(dx, dz);
  if (R < 1e-3) return false;
  const h = target.y - start.y;
  const th = angleDeg * DEG;
  const c = Math.cos(th);
  const denom = 2 * c * c * (R * Math.tan(th) - h);
  if (denom <= 0) return false;
  const v = Math.sqrt((G * R * R) / denom);
  if (!isFinite(v) || v <= 0) return false;
  const inv = 1 / R;
  out.set(dx * inv * v * c, v * Math.sin(th), dz * inv * v * c);
  return true;
}

export async function createMeteorSystem(opts: MeteorOpts): Promise<MeteorSystem> {
  const { scene, camera, controls, physics, domElement, onImpact } = opts;
  const RAPIER = physics.RAPIER;
  const raycaster = new THREE.Raycaster();
  // Trail/particle sprites — warm for the meteor, cool for the water ball.
  const trailDot = makeSoftDot("rgba(255,255,255,1)", "rgba(255,180,90,0.85)");
  const emberDot = makeSoftDot("rgba(255,240,200,1)", "rgba(255,150,60,0.9)");
  const trailDotWater = makeSoftDot("rgba(255,255,255,1)", "rgba(150,220,255,0.85)", "rgba(40,120,255,0)");
  const sparkDot = makeSoftDot("rgba(255,255,255,1)", "rgba(130,220,255,0.9)", "rgba(40,120,255,0)");

  // The core is a faceted BALL (low-poly icosphere, so it stays cohesive with
  // the scene's flat-shaded look while reading clearly as a sphere). Shared by
  // both weapons; only the material differs.
  const coreGeo = new THREE.IcosahedronGeometry(ORB_R, 3);
  const haloGeo = new THREE.IcosahedronGeometry(ORB_R * 1.32, 1);

  // Meteor: gathering rocks are imported boulders sharing one steady, cooler
  // molten material (the bright pulse is reserved for each orb's own core ball).
  const chunkGeo = await loadMeteorRock(CHUNK_URL, 1);
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x140d0a,
    emissive: 0x812200,
    emissiveIntensity: 0.25,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  });
  applyLava(rockMat, { value: 0.7 });

  // Water ball: gathering bits are small translucent blue droplets.
  const dropGeo = new THREE.IcosahedronGeometry(1, 1);
  const dropMat = new THREE.MeshStandardMaterial({
    color: 0x2aa0e0,
    emissive: 0x1a6fae,
    emissiveIntensity: 0.5,
    roughness: 0.2,
    metalness: 0,
    transparent: true,
    opacity: 0.82,
    flatShading: true,
  });

  // Everything weapon-specific about an orb's look lives here; the build + update
  // machinery below is shared and just reads from the active weapon's config.
  interface WeaponVisual {
    makeCore(glow: { value: number }): THREE.MeshStandardMaterial;
    fragGeo: THREE.BufferGeometry;
    fragMat: THREE.Material;
    emberTex: THREE.Texture;
    emberColor: number;
    haloColor: number;
    trailTex: THREE.Texture;
    trailHot: THREE.Color;
    trailCold: THREE.Color;
    hasArcs: boolean;
    previewColor: number; // tint for the trajectory arc + landing ring
  }
  const WEAPONS: Record<WeaponKind, WeaponVisual> = {
    meteor: {
      makeCore(glow) {
        const m = new THREE.MeshStandardMaterial({
          color: 0x140d0a, // near-black basalt; the lava veins supply the heat
          emissive: 0x812200,
          emissiveIntensity: 0.35,
          roughness: 0.9,
          metalness: 0,
          flatShading: true,
        });
        applyLava(m, glow);
        return m;
      },
      fragGeo: chunkGeo,
      fragMat: rockMat,
      emberTex: emberDot,
      emberColor: 0xffa850,
      haloColor: 0xff6a2a,
      trailTex: trailDot,
      trailHot: new THREE.Color(0xffd9a0),
      trailCold: new THREE.Color(0x661500),
      hasArcs: false,
      previewColor: 0xffa050,
    },
    waterball: {
      makeCore(glow) {
        const m = new THREE.MeshStandardMaterial({
          color: 0x0a2a4a, // deep water blue; the electric filaments supply the glow
          emissive: 0x07203a,
          emissiveIntensity: 0.4,
          roughness: 0.25,
          metalness: 0,
          transparent: true,
          opacity: 0.82,
          flatShading: true,
        });
        applyElectric(m, glow);
        return m;
      },
      fragGeo: dropGeo,
      fragMat: dropMat,
      emberTex: sparkDot,
      emberColor: 0x8fd3ff,
      haloColor: 0x49c8ff,
      trailTex: trailDotWater,
      trailHot: new THREE.Color(0xdff6ff),
      trailCold: new THREE.Color(0x0a3a66),
      hasArcs: true,
      previewColor: 0x55d8ff,
    },
  };

  // Build one pooled orb for the given weapon. Two pools (one per weapon) keep
  // each orb's materials/geometry baked in, so switching weapons is just picking
  // which pool to draw from — no per-frame re-skinning.
  function buildOrb(kind: WeaponKind): Orb {
    const wv = WEAPONS[kind];
    const group = new THREE.Group();

    // Each orb owns its core material + glow uniform so the charging one can
    // pulse brighter independently of any orbs already in flight.
    const coreGlow = { value: 1.0 };
    const coreMat = wv.makeCore(coreGlow);
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.castShadow = false;
    group.add(core);

    // Subtle additive aura — kept faint so it rims the orb instead of smearing
    // it into a blob (bloom on the core veins/filaments does the heavy lifting).
    const haloMat = new THREE.MeshBasicMaterial({
      color: wv.haloColor,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    group.add(new THREE.Mesh(haloGeo, haloMat));

    // Loose bits that orbit, spiral inward and merge into the ball as it charges
    // (rocks for the meteor, water droplets for the water ball).
    const frags: Frag[] = [];
    for (let f = 0; f < FRAGS; f++) {
      const m = new THREE.Mesh(wv.fragGeo, wv.fragMat);
      const base = 0.2 + Math.random() * 0.28;
      m.scale.setScalar(base);
      m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      m.castShadow = false;
      m.visible = false;
      frags.push({
        mesh: m,
        ang: Math.random() * 6.28,
        rad: 2.4 + Math.random() * 3.2,
        spin: (Math.random() * 2 - 1) * 2.4,
        y: (Math.random() * 2 - 1) * 2.2,
        base,
        t0: Math.random() * 0.6,
      });
      group.add(m);
    }

    const emPos = new Float32Array(EMBERS * 3);
    const emAng = new Float32Array(EMBERS);
    const emRad = new Float32Array(EMBERS);
    const emY = new Float32Array(EMBERS);
    const emVy = new Float32Array(EMBERS);
    const emSpin = new Float32Array(EMBERS);
    for (let e = 0; e < EMBERS; e++) {
      emAng[e] = Math.random() * 6.28;
      emRad[e] = 1.1 + Math.random() * 1.6;
      emY[e] = Math.random() * 3 - 1;
      emVy[e] = 1.2 + Math.random() * 2;
      emSpin[e] = (Math.random() * 2 - 1) * 2;
    }
    const emGeo = new THREE.BufferGeometry();
    emGeo.setAttribute("position", new THREE.BufferAttribute(emPos, 3));
    const embers = new THREE.Points(
      emGeo,
      new THREE.PointsMaterial({
        size: 0.42,
        map: wv.emberTex,
        color: wv.emberColor,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        fog: false,
      }),
    );
    embers.frustumCulled = false;
    embers.visible = false;
    group.add(embers);

    // Electric arcs crackling around the orb (water ball only); regenerated each
    // frame in the orb's local space so they ride the tumbling group.
    let arcs: THREE.LineSegments | null = null;
    let arcPos: Float32Array | null = null;
    if (wv.hasArcs) {
      arcPos = new Float32Array(ARC_SEG * 2 * 3);
      const arcGeo = new THREE.BufferGeometry();
      arcGeo.setAttribute("position", new THREE.BufferAttribute(arcPos, 3));
      arcs = new THREE.LineSegments(
        arcGeo,
        new THREE.LineBasicMaterial({
          color: 0xbff0ff,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      );
      arcs.frustumCulled = false;
      arcs.visible = false;
      group.add(arcs);
    }

    group.position.set(0, -9999, 0);
    scene.add(group);

    // Trail lives in world space (not parented to the tumbling group).
    const trailPos = new Float32Array(TRAIL_LEN * 3);
    const trailCol = new Float32Array(TRAIL_LEN * 3);
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
    tGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
    const trail = new THREE.Points(
      tGeo,
      new THREE.PointsMaterial({
        size: 2.2,
        map: wv.trailTex,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        fog: false,
      }),
    );
    trail.frustumCulled = false;
    trail.visible = false;
    scene.add(trail);

    return {
      group,
      core,
      coreMat,
      coreGlow,
      haloMat,
      frags,
      embers,
      emAng,
      emRad,
      emY,
      emVy,
      emSpin,
      trail,
      trailPos,
      trailCol,
      head: 0,
      free: true,
      kind,
      arcs,
      arcPos,
    };
  }

  // One pool per weapon. POOL_SIZE each is plenty: only one orb charges at a
  // time and at most MAX_FLYING are airborne across both weapons combined.
  const pools: Record<WeaponKind, Orb[]> = { meteor: [], waterball: [] };
  for (let i = 0; i < POOL_SIZE; i++) {
    pools.meteor.push(buildOrb("meteor"));
    pools.waterball.push(buildOrb("waterball"));
  }
  let currentWeapon: WeaponKind = "meteor";

  function acquire(kind: WeaponKind): Orb | null {
    for (const o of pools[kind]) if (o.free) { o.free = false; return o; }
    return null;
  }
  function park(o: Orb): void {
    o.free = true;
    o.group.position.set(0, -9999, 0);
    o.group.scale.setScalar(1);
    o.group.rotation.set(0, 0, 0);
    o.core.scale.setScalar(1);
    o.trail.visible = false;
    o.embers.visible = false;
    if (o.arcs) o.arcs.visible = false;
    for (const f of o.frags) f.mesh.visible = false;
  }

  // Regenerate the orb's electric arcs in local space: a handful of jagged bolts
  // that leap between random points around the (locally-scaled) core surface.
  const _a0 = new THREE.Vector3();
  const _a1 = new THREE.Vector3();
  const _aPerp1 = new THREE.Vector3();
  const _aPerp2 = new THREE.Vector3();
  const _aDir = new THREE.Vector3();
  function randOnSphere(out: THREE.Vector3, r: number): void {
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    out.set(Math.cos(t) * s * r, u * r, Math.sin(t) * s * r);
  }
  function updateOrbArcs(o: Orb): void {
    if (!o.arcs || !o.arcPos) return;
    const r = ORB_R * o.core.scale.x; // local radius of the visible core
    const pos = o.arcPos;
    for (let b = 0; b < ARC_BOLTS; b++) {
      randOnSphere(_a0, r * 0.92);
      randOnSphere(_a1, r * 1.15);
      _aDir.subVectors(_a1, _a0);
      const len = _aDir.length() || 1;
      _aDir.multiplyScalar(1 / len);
      _aPerp1.set(_aDir.y, -_aDir.z, _aDir.x).cross(_aDir).normalize();
      _aPerp2.crossVectors(_aDir, _aPerp1);
      const jit = r * 0.5;
      let px = _a0.x, py = _a0.y, pz = _a0.z;
      for (let s = 0; s < ARC_SUB; s++) {
        const t1 = (s + 1) / ARC_SUB;
        const taper = Math.sin(t1 * Math.PI);
        const o1 = (Math.random() - 0.5) * jit * taper;
        const o2 = (Math.random() - 0.5) * jit * taper;
        const nx = s === ARC_SUB - 1 ? _a1.x : _a0.x + (_a1.x - _a0.x) * t1 + _aPerp1.x * o1 + _aPerp2.x * o2;
        const ny = s === ARC_SUB - 1 ? _a1.y : _a0.y + (_a1.y - _a0.y) * t1 + _aPerp1.y * o1 + _aPerp2.y * o2;
        const nz = s === ARC_SUB - 1 ? _a1.z : _a0.z + (_a1.z - _a0.z) * t1 + _aPerp1.z * o1 + _aPerp2.z * o2;
        const v = (b * ARC_SUB + s) * 6;
        pos[v] = px; pos[v + 1] = py; pos[v + 2] = pz;
        pos[v + 3] = nx; pos[v + 4] = ny; pos[v + 5] = nz;
        px = nx; py = ny; pz = nz;
      }
    }
    o.arcs.geometry.attributes.position.needsUpdate = true;
  }

  const flying: Flying[] = [];

  // ---- trajectory preview: dotted arc + landing ring -------------------------
  // One neutral-white soft dot; the per-weapon tint rides material.color.
  const previewDot = makeSoftDot("rgba(255,255,255,1)", "rgba(255,255,255,0.85)", "rgba(255,255,255,0)");
  function buildPreviewPoints(cap: number, size: number): THREE.Points {
    const geo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", attr);
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size,
        map: previewDot,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        fog: false,
      }),
    );
    pts.frustumCulled = false;
    pts.visible = false;
    scene.add(pts);
    return pts;
  }
  const previewArc = buildPreviewPoints(MAX_ARC_DOTS, 1.1);
  const previewRing = buildPreviewPoints(RING_DOTS, 0.9);
  const previewArcPos = (previewArc.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const previewRingPos = (previewRing.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const previewArcMat = previewArc.material as THREE.PointsMaterial;
  const previewRingMat = previewRing.material as THREE.PointsMaterial;
  // Small aim marker under the cursor between gestures — marks the aim point,
  // never claims a blast size (that promise belongs to the charging ring).
  const hoverMarker = buildPreviewPoints(HOVER_DOTS, 0.7);
  const hoverPos = (hoverMarker.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const hoverMat = hoverMarker.material as THREE.PointsMaterial;
  hoverMat.opacity = 0.55;

  // Force meter (bottom-centre bar in index.html). Owned here rather than by
  // hud.ts: it's 60 Hz input-gesture state, not score presentation.
  const forceMeter = document.getElementById("force-meter");
  const forceFill = document.getElementById("force-fill");
  const modeEl = document.getElementById("throw-mode");
  function refreshModeLabel(): void {
    if (modeEl) modeEl.textContent = `THROW STYLE — ${throwMode.toUpperCase()}  [T]`;
  }

  // ---- gesture state --------------------------------------------------------
  let charging: Orb | null = null;
  let holdTime = 0;
  let pointerId = -1;
  let lastTime = 0;
  let realClock = 0; // real-time clock so the arc's dot-flow never hitstop-freezes
  let lastCursorX = 0;
  let lastCursorY = 0;
  let cursorSeen = false; // any pointermove yet — gates the hover marker
  let throwValid = false; // computeThrow has run for the current gesture
  let throwMode: ThrowMode = "charge";
  let downCursorY = 0; // press position — the slingshot drag is measured from here
  const lockedTarget = new THREE.Vector3(); // slingshot: ring locked at press
  let lockedValid = false;
  const lastGround = new THREE.Vector3(); // last cursor ground point that resolved
  let lastGroundValid = false;

  // Cursor → ground point, remembering the last good one so a sky-aim frame
  // doesn't blank the target (hurl keeps slamming at the meadow's edge).
  function aimPoint(cx: number, cy: number, out: THREE.Vector3): boolean {
    if (groundUnder(cx, cy, out)) {
      lastGround.copy(out);
      lastGroundValid = true;
      return true;
    }
    if (lastGroundValid) {
      out.copy(lastGround);
      return true;
    }
    return false;
  }

  // The orb's held slot: a fixed camera-relative anchor, lifted above terrain.
  // Re-evaluated every charging frame so WASD/zoom keeps the orb glued to it.
  const _anchorNdc = new THREE.Vector2(0, ANCHOR_NDC_Y);
  function anchorPos(out: THREE.Vector3): void {
    raycaster.setFromCamera(_anchorNdc, camera);
    out.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, ANCHOR_DIST);
    const gh = terrainHeight(out.x, out.z);
    if (out.y < gh + LIFT_MIN) out.y = gh + LIFT_MIN;
  }

  // The ONE deterministic throw solve, shared by preview and launch. Writes
  // `throwVel` per the active throw style; every style ends in a velocity the
  // same march + physics fly identically. In charge mode (and as the last-
  // resort fallback) the cursor gives a DIRECTION; when it can't (sky, dead
  // over the orb) the last direction holds.
  const throwVel = new THREE.Vector3();
  const lastDir = new THREE.Vector3();
  let lastDirValid = false;
  function computeThrow(force: number, cx: number, cy: number, anchor: THREE.Vector3): void {
    if (throwMode === "slingshot" && lockedValid) {
      // Drag OFFSET from the press point shapes the arc: down = flat + fast,
      // up = mortar lob, neutral = the standard 42°. Offset, not velocity —
      // visible, stable and reversible right up to release.
      const k = THREE.MathUtils.clamp((cy - downCursorY) / SLING_DRAG_PX, -1, 1);
      let angle =
        k >= 0
          ? SLING_ANGLE_NEUTRAL + (SLING_ANGLE_FLAT - SLING_ANGLE_NEUTRAL) * k
          : SLING_ANGLE_NEUTRAL + (SLING_ANGLE_LOB - SLING_ANGLE_NEUTRAL) * -k;
      // Solve to the DETONATION altitude (underside 0.2 above ground = centre
      // ORB_R + 0.2 up), not the ground: a flat arc reaches that height well
      // before the ground point, so aiming at the surface would land it short.
      _tmp.copy(lockedTarget);
      _tmp.y += ORB_R + 0.2;
      // A hilltop target can sit above the anchor: steepen until it solves.
      for (; angle <= 82; angle += 8) {
        if (solveAtAngle(anchor, _tmp, angle, throwVel)) return;
      }
      // Pathological (target essentially on top of the orb) — fall through.
    } else if (throwMode === "hurl" && aimPoint(cx, cy, _aim)) {
      // The cursor is the landing point; flight time is short and near-constant
      // so every throw slams down. Solving v = Δ/T (+ gravity make-up) always
      // succeeds — no unreachable targets, no speed cap, no lies.
      const dx = _aim.x - anchor.x;
      const dy = _aim.y + (ORB_R + 0.2) - anchor.y; // detonation altitude, as above
      const dz = _aim.z - anchor.z;
      const T = THREE.MathUtils.clamp(Math.hypot(dx, dz) / HURL_AVG_SPEED, HURL_T_MIN, HURL_T_MAX);
      throwVel.set(dx / T, dy / T + 0.5 * G * T, dz / T);
      return;
    }

    // Charge mode, and the fallback for the styles above.
    if (!lastDirValid) {
      // First aim ever: seed with the camera's forward azimuth.
      const e = camera.matrixWorld.elements;
      lastDir.set(-e[8], 0, -e[10]);
      if (lastDir.lengthSq() < 1e-6) lastDir.set(0, 0, -1);
      lastDir.normalize();
      lastDirValid = true;
    }
    if (groundUnder(cx, cy, _aim)) {
      _tmp.copy(_aim).sub(anchor);
      _tmp.y = 0;
      if (_tmp.lengthSq() > 1e-6) lastDir.copy(_tmp.normalize());
    }
    const v = MIN_V + (MAX_V - MIN_V) * force;
    throwVel.set(lastDir.x * v * COS_A, v * SIN_A, lastDir.z * v * COS_A);
  }

  // March the throw under gravity exactly as Rapier will fly it: semi-implicit
  // Euler at the fixed physics timestep (velocity BEFORE position), zero drag,
  // terminated by the same ground test that detonates a real orb in update().
  // Fills the arc buffer (a dot every ARC_DOT_SPACING, phased so the dots flow
  // toward the target), and leaves landing point + impact speed in _land/_landV.
  const _mp = new THREE.Vector3();
  const _mv = new THREE.Vector3();
  const _mprev = new THREE.Vector3();
  const _land = new THREE.Vector3();
  let _landV = 0;
  function marchTrajectory(start: THREE.Vector3, vel: THREE.Vector3): number {
    _mp.copy(start);
    _mv.copy(vel);
    let nDots = 0;
    let traveled = 0;
    let nextDot = ARC_DOT_SPACING - ((realClock * ARC_FLOW_SPEED) % ARC_DOT_SPACING);
    let prevDiff = _mp.y - ORB_R - 0.2 - terrainHeight(_mp.x, _mp.z);
    for (let i = 0; i < MAX_PREVIEW_STEPS; i++) {
      _mprev.copy(_mp);
      _mv.y -= G * PREVIEW_STEP;
      _mp.addScaledVector(_mv, PREVIEW_STEP);
      const stepLen = _mp.distanceTo(_mprev);
      const diff = _mp.y - ORB_R - 0.2 - terrainHeight(_mp.x, _mp.z);
      if (diff <= 0 && prevDiff > 0) {
        const s = prevDiff / (prevDiff - diff);
        _land.copy(_mprev).lerp(_mp, s);
        _land.y = terrainHeight(_land.x, _land.z);
        _landV = _mv.length();
        return nDots;
      }
      prevDiff = diff;
      traveled += stepLen;
      while (traveled >= nextDot && nDots < MAX_ARC_DOTS) {
        const back = (traveled - nextDot) / Math.max(stepLen, 1e-6);
        previewArcPos[nDots * 3] = _mp.x + (_mprev.x - _mp.x) * back;
        previewArcPos[nDots * 3 + 1] = _mp.y + (_mprev.y - _mp.y) * back;
        previewArcPos[nDots * 3 + 2] = _mp.z + (_mprev.z - _mp.z) * back;
        nDots++;
        nextDot += ARC_DOT_SPACING;
      }
    }
    // Step cap reached (shouldn't happen inside the meadow) — land it below.
    _land.set(_mp.x, terrainHeight(_mp.x, _mp.z), _mp.z);
    _landV = _mv.length();
    return nDots;
  }

  // Re-solve + redraw the whole preview for the current cursor/force. Also runs
  // once from onDown, so a same-frame tap always has a valid throwVel.
  function updatePreview(): void {
    if (!charging) return;
    const force = THREE.MathUtils.clamp(holdTime / CHARGE_TIME, MIN_FORCE, 1);
    computeThrow(force, lastCursorX, lastCursorY, charging.group.position);
    throwValid = true;

    const nDots = marchTrajectory(charging.group.position, throwVel);
    previewArc.geometry.setDrawRange(0, nDots);
    (previewArc.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

    // Landing ring, sized by the EXACT radius formula the detonation uses —
    // the ring is a promise, not an estimate.
    const radius = THREE.MathUtils.clamp(
      BASE_RADIUS + force * CHARGE_RADIUS + _landV * RADIUS_PER_SPEED,
      RADIUS_MIN,
      RADIUS_MAX,
    );
    for (let i = 0; i < RING_DOTS; i++) {
      const a = (i / RING_DOTS) * Math.PI * 2;
      const x = _land.x + Math.cos(a) * radius;
      const z = _land.z + Math.sin(a) * radius;
      previewRingPos[i * 3] = x;
      previewRingPos[i * 3 + 1] = terrainHeight(x, z) + RING_LIFT; // conform to slopes/craters
      previewRingPos[i * 3 + 2] = z;
    }
    (previewRing.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

    if (forceFill) forceFill.style.width = `${(force * 100).toFixed(1)}%`;
  }

  // Ground point under a screen position: march the cursor ray against the
  // analytic terrain, falling back to the flat y=0 plane.
  function groundUnder(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const rect = domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(_ndc, camera);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    let prev = o.y - terrainHeight(o.x, o.z);
    let t = 0;
    for (let i = 0; i < 520; i++) {
      t += 1.0;
      _tmp.copy(d).multiplyScalar(t).add(o);
      const diff = _tmp.y - terrainHeight(_tmp.x, _tmp.z);
      if (diff <= 0 && prev > 0) {
        const fr = prev / (prev - diff);
        out.copy(d).multiplyScalar(t - 1.0 + fr).add(o);
        out.y = terrainHeight(out.x, out.z);
        return true;
      }
      prev = diff;
      if (_tmp.y < -30) break;
    }
    if (raycaster.ray.intersectPlane(_groundPlane, out)) {
      out.y = terrainHeight(out.x, out.z);
      return true;
    }
    return false;
  }

  function onDown(e: PointerEvent): void {
    // Left button only, and never while already charging. No throw cooldown: every
    // distinct press conjures + throws, so rapid taps reliably spam projectiles.
    if (e.button !== 0 || charging) return;
    const orb = acquire(currentWeapon);
    if (!orb) return;
    // LMB can never orbit (mouseButtons.LEFT = null in main.ts); just make sure
    // the menu's idle auto-rotate is off the moment the first throw starts.
    controls.autoRotate = false;
    e.preventDefault();
    e.stopPropagation();
    pointerId = e.pointerId;
    try { domElement.setPointerCapture(pointerId); } catch { /* ignore */ }

    charging = orb;
    holdTime = 0;
    throwValid = false;
    lastCursorX = e.clientX;
    lastCursorY = e.clientY;
    downCursorY = e.clientY;
    // Slingshot: the ring locks HERE; the mouse now shapes the arc instead.
    lockedValid = throwMode === "slingshot" && aimPoint(e.clientX, e.clientY, lockedTarget);
    hoverMarker.visible = false;

    anchorPos(_hit);
    orb.group.position.copy(_hit);
    orb.group.scale.setScalar(0.6);
    orb.group.rotation.set(0, 0, 0);
    orb.trail.visible = false;
    orb.embers.visible = true;
    orb.core.scale.setScalar(0.5); // a small seed that grows as the bits merge in
    for (const f of orb.frags) f.mesh.visible = true;
    if (orb.arcs) orb.arcs.visible = true;
    orb.coreGlow.value = 1.0;
    orb.haloMat.opacity = 0.07;

    // Preview on, tinted for this orb's weapon; meter shown; one preview pass
    // right now so releasing this very frame still fires a solved throw.
    previewArcMat.color.setHex(WEAPONS[orb.kind].previewColor);
    previewRingMat.color.setHex(WEAPONS[orb.kind].previewColor);
    previewArc.visible = true;
    previewRing.visible = true;
    if (forceMeter) {
      forceMeter.classList.add("show");
      forceMeter.classList.toggle("water", orb.kind === "waterball");
    }
    updatePreview();
  }

  function onMove(e: PointerEvent): void {
    // Track the cursor at all times: the hover marker + the slingshot lock read
    // it between gestures, the live aim reads it during one.
    lastCursorX = e.clientX;
    lastCursorY = e.clientY;
    cursorSeen = true;
  }

  // When MAX_FLYING meteors are already airborne, detonate the oldest on the
  // ground beneath it instead of letting the physics registry silently evict it
  // (which left rapid-fire throws with no impact). Runs from launch(), outside
  // physics.add, so onImpact can't re-enter the eviction loop.
  function detonateOldest(): void {
    const rec = flying[0];
    if (!rec) return;
    const p = rec.handle.body.translation();
    const v = rec.handle.body.linvel();
    _tmp.set(v.x, v.y, v.z);
    const radius = THREE.MathUtils.clamp(
      BASE_RADIUS + rec.charge * CHARGE_RADIUS + _tmp.length() * RADIUS_PER_SPEED,
      RADIUS_MIN,
      RADIUS_MAX,
    );
    _hit.set(p.x, terrainHeight(p.x, p.z), p.z);
    onImpact(_hit.clone(), _tmp.clone(), radius, rec.orb.kind, {
      charge: rec.charge,
      launchPos: rec.launchPos,
    });
    physics.remove(rec.handle); // onExpire splices flying + parks the orb
  }

  function launch(orb: Orb): void {
    while (flying.length >= MAX_FLYING) detonateOldest();
    const spawn = orb.group.position;
    // charge == force: the same floored 0..1 that sized the preview, so
    // ImpactInfo.charge keeps its meaning for the scorer.
    const charge = THREE.MathUtils.clamp(holdTime / CHARGE_TIME, MIN_FORCE, 1);
    // throwVel is the arc the player was just shown (updatePreview runs every
    // charging frame, and once in onDown) — fire THAT, not a re-solve, so the
    // landing ring is honoured. The re-solve here is unreachable insurance.
    if (!throwValid) computeThrow(charge, lastCursorX, lastCursorY, spawn);

    orb.group.scale.setScalar(0.6 + charge * 0.6);
    orb.core.scale.setScalar(1); // launches as a complete ball (arcs keep crackling in flight)
    orb.embers.visible = false;
    for (const fr of orb.frags) fr.mesh.visible = false;

    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setLinvel(throwVel.x, throwVel.y, throwVel.z)
        .setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 })
        .setLinearDamping(0) // zero drag: the flight must match the marched preview exactly
        .setCcdEnabled(true),
    );
    physics.world.createCollider(
      // Collision groups: membership = group 1, filter = none — collides with
      // NOTHING, so it falls through the terrain trimesh and detonates purely on
      // the analytic ground test below (never bounces). CCD still guards a fast
      // small ball against tunneling past the detection threshold.
      RAPIER.ColliderDesc.ball(ORB_R)
        .setRestitution(0.1)
        .setFriction(0.6)
        .setDensity(6)
        .setCollisionGroups(0x00020000),
      body,
    );

    for (let i = 0; i < TRAIL_LEN; i++) {
      orb.trailPos[i * 3] = spawn.x;
      orb.trailPos[i * 3 + 1] = spawn.y;
      orb.trailPos[i * 3 + 2] = spawn.z;
    }
    orb.head = 0;
    orb.trail.visible = true;
    orb.trail.geometry.attributes.position.needsUpdate = true;

    const rec: Flying = {
      orb,
      charge,
      launchPos: spawn.clone(), // `spawn` is the orb's live position — snapshot it
      handle: {
        body,
        object: orb.group,
        kind: "meteor",
        bornAt: lastTime,
        maxLife: 7,
        onExpire: () => {
          const idx = flying.indexOf(rec);
          if (idx !== -1) flying.splice(idx, 1);
          park(orb);
        },
      },
    };
    flying.push(rec);
    physics.add(rec.handle);
  }

  function endGesture(launchIt: boolean): void {
    if (!charging) return;
    const orb = charging;
    charging = null;
    if (pointerId !== -1) {
      try { domElement.releasePointerCapture(pointerId); } catch { /* ignore */ }
      pointerId = -1;
    }
    previewArc.visible = false;
    previewRing.visible = false;
    if (forceMeter) forceMeter.classList.remove("show");
    if (launchIt) {
      launch(orb);
    } else {
      park(orb);
    }
  }

  function onUp(e: PointerEvent): void {
    if (!charging || e.pointerId !== pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    endGesture(true);
  }
  function onCancel(e: PointerEvent): void {
    if (!charging || e.pointerId !== pointerId) return;
    endGesture(false);
  }
  function onBlur(): void {
    if (charging) endGesture(false);
  }

  refreshModeLabel();
  domElement.addEventListener("pointerdown", onDown, true);
  domElement.addEventListener("pointermove", onMove, true);
  domElement.addEventListener("pointerup", onUp, true);
  domElement.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("blur", onBlur);

  function paintTrail(orb: Orb): void {
    const { trailHot, trailCold } = WEAPONS[orb.kind];
    const h = orb.head;
    for (let a = 0; a < TRAIL_LEN; a++) {
      const i = (h - a + TRAIL_LEN) % TRAIL_LEN;
      const k = 1 - a / TRAIL_LEN;
      _trailC.copy(trailCold).lerp(trailHot, k * k);
      orb.trailCol[i * 3] = _trailC.r;
      orb.trailCol[i * 3 + 1] = _trailC.g;
      orb.trailCol[i * 3 + 2] = _trailC.b;
    }
    orb.trail.geometry.attributes.color.needsUpdate = true;
  }

  return {
    update(dt: number, time: number, dtReal: number): void {
      lastTime = time;
      realClock += dtReal;
      lavaTime.value = time; // flow + flicker the lava veins on every meteor orb
      elecTime.value = time; // crackle the electric filaments on every water orb

      if (charging) {
        // The whole charge gesture runs on REAL time: the force meter, the arc
        // and the accretion show must stay butter-smooth even while a hitstop
        // freezes the sim. (Orbs in FLIGHT stay on sim dt below — they're physics.)
        holdTime += dtReal;
        anchorPos(charging.group.position); // stay glued to the slot through WASD/zoom
        const k = Math.min(holdTime / CHARGE_TIME, 1);
        const pulse = 0.85 + 0.15 * Math.sin(holdTime * 18);
        charging.coreGlow.value = (0.9 + k * 1.3) * pulse;
        charging.haloMat.opacity = (0.06 + k * 0.12) * pulse;
        charging.group.scale.setScalar(0.6 + k * 0.6);
        charging.group.rotation.y += dtReal * 0.9;
        // The ball itself swells from a small seed as it swallows the rock.
        const coreScale = 0.5 + 0.5 * k;
        charging.core.scale.setScalar(coreScale);

        // Each rock orbits, then makes a staggered plunge inward and melts into
        // the ball — it shrinks to nothing as it reaches the molten surface, so
        // the whole loose cloud gathers into one clean sphere by full charge.
        const surface = ORB_R * coreScale;
        for (const fr of charging.frags) {
          fr.ang += dtReal * fr.spin;
          const kp = Math.min(Math.max((k - fr.t0) / (1 - fr.t0), 0), 1); // this rock's own plunge 0..1
          const ease = kp * kp * (3 - 2 * kp);
          const rad = fr.rad * (1 - ease) + surface * 0.9 * ease;
          fr.mesh.position.set(Math.cos(fr.ang) * rad, fr.y * (1 - ease), Math.sin(fr.ang) * rad);
          fr.mesh.rotation.x += dtReal * fr.spin * 0.5;
          fr.mesh.scale.setScalar(fr.base * (1 - ease)); // melts away as it lands
          fr.mesh.visible = ease < 0.985;
        }
        // Embers swirl up off the molten surface.
        const pos = charging.embers.geometry.attributes.position as THREE.BufferAttribute;
        const arr = pos.array as Float32Array;
        for (let e = 0; e < EMBERS; e++) {
          charging.emAng[e] += dtReal * charging.emSpin[e];
          charging.emY[e] += dtReal * charging.emVy[e];
          if (charging.emY[e] > 3) charging.emY[e] = -1.2;
          const rad = charging.emRad[e] * (0.7 + 0.3 * k);
          arr[e * 3] = Math.cos(charging.emAng[e]) * rad;
          arr[e * 3 + 1] = charging.emY[e];
          arr[e * 3 + 2] = Math.sin(charging.emAng[e]) * rad;
        }
        pos.needsUpdate = true;

        // Water ball: arcs crackle louder as it charges.
        if (charging.arcs) updateOrbArcs(charging);

        // Re-solve + redraw the arc, ring and meter for this frame's aim/force.
        updatePreview();
      }

      // Aim marker between gestures: a small slowly-spinning dotted ring under
      // the cursor, tinted for the weapon you'd conjure. Marks aim, not blast.
      if (!charging && cursorSeen && aimPoint(lastCursorX, lastCursorY, _tmp)) {
        hoverMat.color.setHex(WEAPONS[currentWeapon].previewColor);
        for (let i = 0; i < HOVER_DOTS; i++) {
          const a = (i / HOVER_DOTS) * Math.PI * 2 + realClock * 0.8;
          const x = _tmp.x + Math.cos(a) * HOVER_R;
          const z = _tmp.z + Math.sin(a) * HOVER_R;
          hoverPos[i * 3] = x;
          hoverPos[i * 3 + 1] = terrainHeight(x, z) + RING_LIFT;
          hoverPos[i * 3 + 2] = z;
        }
        (hoverMarker.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        hoverMarker.visible = true;
      } else if (charging) {
        hoverMarker.visible = false;
      }

      for (let i = flying.length - 1; i >= 0; i--) {
        const rec = flying[i];
        const p = rec.handle.body.translation();
        rec.orb.group.rotation.x += dt * 5;
        rec.orb.group.rotation.z += dt * 2;
        rec.orb.head = (rec.orb.head + 1) % TRAIL_LEN;
        rec.orb.trailPos[rec.orb.head * 3] = p.x;
        rec.orb.trailPos[rec.orb.head * 3 + 1] = p.y;
        rec.orb.trailPos[rec.orb.head * 3 + 2] = p.z;
        rec.orb.trail.geometry.attributes.position.needsUpdate = true;
        paintTrail(rec.orb);
        if (rec.orb.arcs) updateOrbArcs(rec.orb);

        const groundY = terrainHeight(p.x, p.z);
        // Sole detonation trigger: fire the instant the underside reaches the
        // ground (small epsilon so it never visibly sinks) — every time, no bounce.
        if (p.y - ORB_R <= groundY + 0.2) {
          const v = rec.handle.body.linvel();
          _tmp.set(v.x, v.y, v.z);
          const speed = _tmp.length();
          const radius = THREE.MathUtils.clamp(
            BASE_RADIUS + rec.charge * CHARGE_RADIUS + speed * RADIUS_PER_SPEED,
            RADIUS_MIN,
            RADIUS_MAX,
          );
          _hit.set(p.x, groundY, p.z);
          onImpact(_hit.clone(), _tmp.clone(), radius, rec.orb.kind, {
            charge: rec.charge,
            launchPos: rec.launchPos,
          });
          physics.remove(rec.handle); // onExpire parks the orb + splices `flying`
        }
      }
    },
    setWeapon(kind: WeaponKind): void {
      currentWeapon = kind;
    },
    getWeapon(): WeaponKind {
      return currentWeapon;
    },
    cycleThrowMode(): ThrowMode {
      endGesture(false); // never carry a half-charged orb across styles
      throwMode = THROW_MODES[(THROW_MODES.indexOf(throwMode) + 1) % THROW_MODES.length];
      lockedValid = false;
      refreshModeLabel();
      return throwMode;
    },
    getThrowMode(): ThrowMode {
      return throwMode;
    },
    dispose(): void {
      domElement.removeEventListener("pointerdown", onDown, true);
      domElement.removeEventListener("pointermove", onMove, true);
      domElement.removeEventListener("pointerup", onUp, true);
      domElement.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onBlur);
      scene.remove(previewArc, previewRing, hoverMarker);
      previewArc.geometry.dispose();
      previewRing.geometry.dispose();
      hoverMarker.geometry.dispose();
      previewArcMat.dispose();
      previewRingMat.dispose();
      hoverMat.dispose();
      if (forceMeter) forceMeter.classList.remove("show", "water");
    },
  };
}
