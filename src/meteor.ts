import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Physics, PhysicsHandle } from "./physics";
import { loadScene } from "./assets";
import { terrainHeight } from "./terrain";
import { softDot } from "./textures";

// ---------------------------------------------------------------------------
// God-hand lava meteor. Hold the left button to CONJURE a molten orb in front
// of the camera; while held it GATHERS into a ball — loose rocks orbit, spiral
// inward and melt into a growing molten sphere, embers swirl off it, and it
// swells + glows hotter the longer you charge. Release to HURL it: a true ballistic arc
// (solved analytically against gravity) flings it out over the meadow toward
// where you aimed — a hard flick leads the aim farther and flattens the arc, so
// it flies and falls like a thrown rock instead of dropping straight down. It
// detonates on the analytic ground test (the collider ignores the terrain so it
// never bounces). Bigger charge → bigger blast.
// ---------------------------------------------------------------------------

const G = 22; // matches world gravity magnitude (physics.ts)
const DEG = Math.PI / 180;
const HOLD_DIST = 15; // how far in front of the camera the orb is held while charging
const LIFT_MIN = 6; // keep it at least this far above the ground beneath it
const ORB_R = 1.2; // physics collider radius
const POOL_SIZE = 9; // up to MAX_FLYING airborne + 1 charging
const MAX_FLYING = 8; // beyond this, the oldest detonates instead of vanishing
const TRAIL_LEN = 28;

const CHARGE_TIME = 0.9; // seconds of holding to reach full charge

// Throw solve: the launch angle eases from a high lob to a flat hurl with flick power.
const ANGLE_BASE = 42;
const ANGLE_FLAT = 23;
const ANGLE_STEEP = 62; // fallback for targets the base angle can't reach
const MAX_THROW_SPEED = 96;
const FLICK_FULL = 2600; // px/sec flick that counts as full power
const LEAD_K = 0.16; // world units of aim lead per px of flick
const LEAD_MAX = 60;

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
  update(dt: number, time: number): void;
  setWeapon(kind: WeaponKind): void;
  getWeapon(): WeaponKind;
  dispose(): void;
}

export interface MeteorOpts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  physics: Physics;
  domElement: HTMLElement;
  onImpact: (point: THREE.Vector3, velocity: THREE.Vector3, radius: number, kind: WeaponKind) => void;
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
}

const _ndc = new THREE.Vector2();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _trailC = new THREE.Color(); // scratch; per-weapon trail colours live in WEAPONS

// Solve a launch velocity (out) that carries `start` through `target` under
// gravity G at the given launch angle. Returns false if unreachable there.
function solveAngle(
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
  const tn = Math.tan(th);
  const denom = 2 * c * c * (R * tn - h);
  if (denom <= 0) return false;
  let v = Math.sqrt((G * R * R) / denom);
  if (!isFinite(v) || v <= 0) return false;
  v = Math.min(v, MAX_THROW_SPEED);
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

  // ---- gesture state --------------------------------------------------------
  let charging: Orb | null = null;
  let holdTime = 0;
  let pointerId = -1;
  let savedAutoRotate = controls.autoRotate;
  let restoreTimer: number | undefined;
  let lastTime = 0;
  const samples: { x: number; y: number; t: number }[] = [];

  // Held position: a fixed distance in front of the cursor, lifted above terrain.
  function conjurePos(clientX: number, clientY: number, out: THREE.Vector3): void {
    const rect = domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(_ndc, camera);
    out.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, HOLD_DIST);
    const gh = terrainHeight(out.x, out.z);
    if (out.y < gh + LIFT_MIN) out.y = gh + LIFT_MIN;
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

  function disableOrbit(): void {
    if (controls.enabled) savedAutoRotate = controls.autoRotate;
    controls.enabled = false;
    controls.autoRotate = false;
    if (restoreTimer !== undefined) { clearTimeout(restoreTimer); restoreTimer = undefined; }
  }

  function onDown(e: PointerEvent): void {
    // Left button only, and never while already charging. No throw cooldown: every
    // distinct press conjures + throws, so rapid taps reliably spam projectiles.
    if (e.button !== 0 || charging) return;
    const orb = acquire(currentWeapon);
    if (!orb) return;
    disableOrbit(); // capture phase runs before OrbitControls' own handler
    e.preventDefault();
    e.stopPropagation();
    pointerId = e.pointerId;
    try { domElement.setPointerCapture(pointerId); } catch { /* ignore */ }

    charging = orb;
    holdTime = 0;
    samples.length = 0;
    samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });

    conjurePos(e.clientX, e.clientY, _hit);
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
  }

  function onMove(e: PointerEvent): void {
    if (!charging || e.pointerId !== pointerId) return;
    conjurePos(e.clientX, e.clientY, _hit);
    charging.group.position.copy(_hit);
    samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (samples.length > 8) samples.shift();
  }

  // Flick over the last ~120ms: pixel speed + pixel delta (dx right+, dy down+).
  function flick(): { speed: number; dx: number; dy: number } {
    if (samples.length < 2) return { speed: 0, dx: 0, dy: 0 };
    const newest = samples[samples.length - 1];
    let old = samples[0];
    for (let i = samples.length - 1; i >= 0; i--) {
      old = samples[i];
      if (newest.t - samples[i].t > 120) break;
    }
    const dtm = (newest.t - old.t) / 1000;
    const dx = newest.x - old.x;
    const dy = newest.y - old.y;
    const speed = dtm > 1e-4 ? Math.hypot(dx, dy) / dtm : 0;
    return { speed, dx, dy };
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
    onImpact(_hit.clone(), _tmp.clone(), radius, rec.orb.kind);
    physics.remove(rec.handle); // onExpire splices flying + parks the orb
  }

  function launch(orb: Orb, upX: number, upY: number): void {
    while (flying.length >= MAX_FLYING) detonateOldest();
    const spawn = orb.group.position;
    if (!groundUnder(upX, upY, _aim)) _aim.set(spawn.x, terrainHeight(spawn.x, spawn.z), spawn.z);

    const f = flick();
    // Camera ground basis for leading the aim in the flick direction.
    const e = camera.matrixWorld.elements;
    _right.set(e[0], e[1], e[2]).setY(0);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _fwd.set(-e[8], 0, -e[10]);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    // Flick up-screen (dy<0) leads forward toward the horizon; sideways leads laterally.
    const mag = Math.hypot(f.dx, f.dy);
    if (f.speed > 1 && mag > 1e-3) {
      const lead = Math.min(mag * LEAD_K, LEAD_MAX);
      const inv = 1 / mag;
      _aim.addScaledVector(_right, f.dx * inv * lead).addScaledVector(_fwd, -f.dy * inv * lead);
      _aim.y = terrainHeight(_aim.x, _aim.z);
    }

    const power = Math.min(f.speed / FLICK_FULL, 1);
    const angle = ANGLE_BASE + (ANGLE_FLAT - ANGLE_BASE) * power;
    if (!solveAngle(spawn, _aim, angle, _vel) && !solveAngle(spawn, _aim, ANGLE_STEEP, _vel)) {
      // Unreachable arc — gentle forward lob so a throw always launches.
      _tmp.copy(_aim).sub(spawn);
      _tmp.y = 0;
      if (_tmp.lengthSq() < 1e-6) _tmp.copy(_fwd);
      _tmp.normalize();
      _vel.set(_tmp.x * 16, 16, _tmp.z * 16);
    }

    const charge = Math.min(holdTime / CHARGE_TIME, 1);
    orb.group.scale.setScalar(0.6 + charge * 0.6);
    orb.core.scale.setScalar(1); // launches as a complete ball (arcs keep crackling in flight)
    orb.embers.visible = false;
    for (const fr of orb.frags) fr.mesh.visible = false;

    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setLinvel(_vel.x, _vel.y, _vel.z)
        .setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 })
        .setLinearDamping(0.02)
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

  function endGesture(launchIt: boolean, upX: number, upY: number): void {
    if (!charging) return;
    const orb = charging;
    charging = null;
    if (pointerId !== -1) {
      try { domElement.releasePointerCapture(pointerId); } catch { /* ignore */ }
      pointerId = -1;
    }
    if (launchIt) {
      launch(orb, upX, upY);
    } else {
      park(orb);
    }
    controls.enabled = true;
    restoreTimer = window.setTimeout(() => {
      controls.autoRotate = savedAutoRotate;
      restoreTimer = undefined;
    }, 1500);
  }

  function onUp(e: PointerEvent): void {
    if (!charging || e.pointerId !== pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    endGesture(true, e.clientX, e.clientY);
  }
  function onCancel(e: PointerEvent): void {
    if (!charging || e.pointerId !== pointerId) return;
    endGesture(false, e.clientX, e.clientY);
  }
  function onBlur(): void {
    if (charging) endGesture(false, 0, 0);
  }

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
    update(dt: number, time: number): void {
      lastTime = time;
      lavaTime.value = time; // flow + flicker the lava veins on every meteor orb
      elecTime.value = time; // crackle the electric filaments on every water orb

      if (charging) {
        holdTime += dt;
        const k = Math.min(holdTime / CHARGE_TIME, 1);
        const pulse = 0.85 + 0.15 * Math.sin(holdTime * 18);
        charging.coreGlow.value = (0.9 + k * 1.3) * pulse;
        charging.haloMat.opacity = (0.06 + k * 0.12) * pulse;
        charging.group.scale.setScalar(0.6 + k * 0.6);
        charging.group.rotation.y += dt * 0.9;
        // The ball itself swells from a small seed as it swallows the rock.
        const coreScale = 0.5 + 0.5 * k;
        charging.core.scale.setScalar(coreScale);

        // Each rock orbits, then makes a staggered plunge inward and melts into
        // the ball — it shrinks to nothing as it reaches the molten surface, so
        // the whole loose cloud gathers into one clean sphere by full charge.
        const surface = ORB_R * coreScale;
        for (const fr of charging.frags) {
          fr.ang += dt * fr.spin;
          const kp = Math.min(Math.max((k - fr.t0) / (1 - fr.t0), 0), 1); // this rock's own plunge 0..1
          const ease = kp * kp * (3 - 2 * kp);
          const rad = fr.rad * (1 - ease) + surface * 0.9 * ease;
          fr.mesh.position.set(Math.cos(fr.ang) * rad, fr.y * (1 - ease), Math.sin(fr.ang) * rad);
          fr.mesh.rotation.x += dt * fr.spin * 0.5;
          fr.mesh.scale.setScalar(fr.base * (1 - ease)); // melts away as it lands
          fr.mesh.visible = ease < 0.985;
        }
        // Embers swirl up off the molten surface.
        const pos = charging.embers.geometry.attributes.position as THREE.BufferAttribute;
        const arr = pos.array as Float32Array;
        for (let e = 0; e < EMBERS; e++) {
          charging.emAng[e] += dt * charging.emSpin[e];
          charging.emY[e] += dt * charging.emVy[e];
          if (charging.emY[e] > 3) charging.emY[e] = -1.2;
          const rad = charging.emRad[e] * (0.7 + 0.3 * k);
          arr[e * 3] = Math.cos(charging.emAng[e]) * rad;
          arr[e * 3 + 1] = charging.emY[e];
          arr[e * 3 + 2] = Math.sin(charging.emAng[e]) * rad;
        }
        pos.needsUpdate = true;

        // Water ball: arcs crackle louder as it charges.
        if (charging.arcs) updateOrbArcs(charging);
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
          onImpact(_hit.clone(), _tmp.clone(), radius, rec.orb.kind);
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
    dispose(): void {
      domElement.removeEventListener("pointerdown", onDown, true);
      domElement.removeEventListener("pointermove", onMove, true);
      domElement.removeEventListener("pointerup", onUp, true);
      domElement.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onBlur);
      if (restoreTimer !== undefined) clearTimeout(restoreTimer);
    },
  };
}
