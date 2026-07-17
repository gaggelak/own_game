import * as THREE from "three";
import { fbm, valueNoise } from "./noise";
import { initialPreset, QUALITY } from "./quality";

export const WORLD = 240; // terrain spans -120..120
export const WATER_LEVEL = 0;

// Drives the water-ripple vertex shader; advanced once per frame from the loop.
// Also reused as the clock for the crater rim-heat glow below.
export const waterTime = { value: 0 };

// Crater rim heat: the last few impact craters glow molten at the rim and cool to
// black over ~10s, feeding bloom exactly like the meteor's own lava veins so the
// blast and the wound it leaves share a material language. Six ring-buffered slots
// (worldX, worldZ, radius, bornTime); born far in the past = an empty slot.
const RIM_SLOTS = 6;
const rimGlow = {
  value: Array.from({ length: RIM_SLOTS }, () => new THREE.Vector4(0, 0, 1, -1e9)),
};
let rimCursor = 0;
function registerRimHeat(cx: number, cz: number, radius: number): void {
  rimGlow.value[rimCursor].set(cx, cz, radius, waterTime.value);
  rimCursor = (rimCursor + 1) % RIM_SLOTS;
}

// Lake basins carved into the heightfield so water always has somewhere to sit.
const lakes = [
  { x: -34, z: 22, r: 30, depth: 8 },
  { x: 52, z: -38, r: 24, depth: 7 },
  { x: 14, z: 70, r: 20, depth: 6 },
];

// The undisturbed ground: rolling hills + lake basins, with NO impact craters.
// `terrainHeight` layers the crater register on top of this. Kept separate so a
// crater's depth is subtracted from the pristine surface (and so the collider,
// built once at load, can sample the pristine ground).
function baseHeight(x: number, z: number): number {
  // Large rolling hills, biased so most of the map sits comfortably above water.
  const base = fbm(x * 0.011 + 100, z * 0.011 + 100);
  let h = Math.pow(base, 1.2) * 22 - 3;
  // Medium-frequency detail for gentle undulation.
  h += (fbm(x * 0.045 + 50, z * 0.045 + 50) - 0.5) * 3.5;

  // Carve smooth lake basins.
  for (const l of lakes) {
    const d = Math.hypot(x - l.x, z - l.z);
    if (d < l.r) {
      const f = 1 - d / l.r;
      h -= l.depth * (f * f * (3 - 2 * f));
    }
  }
  return h;
}

// Impact craters, newest last. Every meteor impact registers one here so the
// analytic ground — sampled by the herd, the camera clamp, the meteor's own
// detonation test, aiming, decals, etc. — matches the carved visual mesh. The
// physics trimesh collider stays pristine (built once at load): resting bodies
// float a hair over a bowl, which the post-impact chaos hides.
interface Crater {
  x: number;
  z: number;
  r: number; // bowl radius
  depth: number;
}
const CRATER_CAP = 128;
const craters: Crater[] = [];

// Apply one crater's deformation to a height sampled at (x, z). Shared by the
// analytic lookup and the visual resample so both use identical math.
function applyCrater(h: number, cr: Crater, x: number, z: number): number {
  const reach = cr.r * 1.3;
  if (Math.abs(x - cr.x) > reach || Math.abs(z - cr.z) > reach) return h;
  const d = Math.hypot(x - cr.x, z - cr.z);
  if (d > reach) return h;
  const t = d / cr.r;
  if (t < 1) h -= cr.depth * (1 - t * t); // parabolic bowl, deepest at centre
  const rt = (d - cr.r * 0.7) / (cr.r * 0.55); // raised lip around the rim
  if (rt > 0 && rt < 1) h += cr.depth * 0.3 * Math.sin(rt * Math.PI);
  return h;
}

export function terrainHeight(x: number, z: number): number {
  const base = baseHeight(x, z);
  let h = base;
  for (const cr of craters) h = applyCrater(h, cr, x, z);
  // On land, keep crater floors above the water line — otherwise the flat water
  // plane at y=0 shows blue through a dug-out pit. Lakebeds (already at/below
  // water) are left alone, so lake-edge impacts still splash.
  if (h < WATER_LEVEL + 0.4 && base > WATER_LEVEL + 0.4) h = WATER_LEVEL + 0.4;
  return h;
}

export interface Terrain {
  mesh: THREE.Mesh;
  water: THREE.Mesh;
  geo: THREE.PlaneGeometry;
}

export interface TerrainCollider {
  vertices: Float32Array; // world-space xyz triples
  indices: Uint32Array; // triangle list
}

// Build a triangle mesh of the ground from the analytic `terrainHeight`, in the
// same world coordinates as the visual terrain. Using a trimesh (instead of a
// Rapier heightfield) keeps the collider's orientation identical to the visible
// surface with no axis-convention guesswork. 128x128 cells (~32k tris) is far
// finer than needed for stable resting yet cheap for a static collider.
export function buildTerrainCollider(res = 128): TerrainCollider {
  const n = res + 1;
  const vertices = new Float32Array(n * n * 3);
  for (let iz = 0; iz < n; iz++) {
    const z = (iz / res - 0.5) * WORLD;
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / res - 0.5) * WORLD;
      const k = (iz * n + ix) * 3;
      vertices[k] = x;
      vertices[k + 1] = terrainHeight(x, z);
      vertices[k + 2] = z;
    }
  }
  const indices = new Uint32Array(res * res * 6);
  let p = 0;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = iz * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[p++] = a; indices[p++] = c; indices[p++] = b;
      indices[p++] = b; indices[p++] = c; indices[p++] = d;
    }
  }
  return { vertices, indices };
}

export function buildTerrain(): Terrain {
  // 160 segments keeps the rolling hills smooth while keeping the baseline render
  // (and each per-impact crater's vertex window) far cheaper than the original 256.
  const segments = 160;
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, segments, segments);
  geo.rotateX(-Math.PI / 2); // lie flat in the XZ plane

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  const sand = new THREE.Color(0xeaddb0);
  const grassLow = new THREE.Color(0x9ada7a);
  const grassHigh = new THREE.Color(0x57b562);
  const rock = new THREE.Color(0xb6a892);
  const snow = new THREE.Color(0xffffff);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);

    if (h < WATER_LEVEL + 0.7) {
      c.copy(sand);
    } else if (h < 5) {
      c.copy(grassLow).lerp(grassHigh, (h - 0.7) / 4.3);
    } else if (h < 10) {
      c.copy(grassHigh);
    } else if (h < 14) {
      c.copy(grassHigh).lerp(rock, (h - 10) / 4);
    } else {
      c.copy(rock).lerp(snow, Math.min((h - 14) / 4, 1));
    }

    // Patchy brightness variation so the ground reads less flat.
    const patch = fbm(x * 0.08 + 17, z * 0.08 + 17);
    c.multiplyScalar(0.85 + patch * 0.3);
    // Occasional dirt/earth patches on the grassy band.
    if (h > WATER_LEVEL + 0.7 && h < 11) {
      const dirt = valueNoise(x * 0.14 + 200, z * 0.14 + 200);
      if (dirt > 0.74) {
        c.lerp(new THREE.Color(0x9c7a4f), ((dirt - 0.74) / 0.26) * 0.55);
      }
    }

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  pos.needsUpdate = true;
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  // Crater rim-heat glow: fresh craters glow molten and cool over ~10s. HDR
  // emissive (values >1) so it punches through the locked bloom threshold like
  // the meteor's lava veins. The soot vertex colours baked in by carveCrater stay
  // as the permanent scar under the fading glow.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterTime;
    shader.uniforms.uGlow = rimGlow;
    shader.vertexShader =
      "varying vec3 vTerrWorld;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader =
      `uniform float uTime;
       uniform vec4 uGlow[${RIM_SLOTS}];
       varying vec3 vTerrWorld;\n` +
      shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        for (int i = 0; i < ${RIM_SLOTS}; i++) {
          vec4 g = uGlow[i];
          if (g.w < -1.0e8) continue;              // empty slot
          float rn = length(vTerrWorld.xz - g.xy) / g.z;
          float ring = smoothstep(0.55, 0.8, rn) * smoothstep(1.15, 0.95, rn);
          float bowl = smoothstep(0.5, 0.0, rn) * 0.15; // faint hot floor, not a light pool
          float heat = exp(-(uTime - g.w) / 3.5);   // cools to ~0 by ~10s
          vec3 hot = mix(vec3(2.2, 0.5, 0.1), vec3(2.4, 1.2, 0.3), heat);
          totalEmissiveRadiance += hot * (ring + bowl) * heat * 0.8;
        }`,
      );
  };
  mat.customProgramCacheKey = () => "terrainRimHeat";
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  // Translucent water plane. Ripples are displaced on the GPU from `waterTime`
  // (a tiny onBeforeCompile patch) instead of rewriting + re-uploading all 6561
  // vertex positions on the CPU every frame — identical look, no per-frame loop.
  const wgeo = new THREE.PlaneGeometry(WORLD, WORLD, 80, 80);
  wgeo.rotateX(-Math.PI / 2);

  // Bake a per-vertex "depth below the waterline" from the PRISTINE ground, so
  // the fragment shader can tint deep water darker and lick foam onto the
  // shoreline with no render target and no per-frame CPU work. Lakebeds are never
  // crater-clamped, so this stays correct for the whole run.
  const wpos = wgeo.attributes.position;
  const depths = new Float32Array(wpos.count);
  for (let i = 0; i < wpos.count; i++) {
    depths[i] = WATER_LEVEL - terrainHeight(wpos.getX(i), wpos.getZ(i));
  }
  wgeo.setAttribute("aDepth", new THREE.BufferAttribute(depths, 1));

  const water = new THREE.Mesh(wgeo, buildWaterMaterial());
  water.position.y = WATER_LEVEL;

  return { mesh, water, geo };
}

// The wave displacement (kept identical to the original so `low` water is a byte
// match): y += sin(px*0.18 + t*1.4)*0.13 + cos(pz*0.22 + t*1.1)*0.13.
const WAVE_VERT = `transformed.y += sin(position.x * 0.18 + uTime * 1.4) * 0.13
                       + cos(position.z * 0.22 + uTime * 1.1) * 0.13;`;

// Preset-driven water: `low` keeps the flat translucent plane with just the wave
// bob; medium/high add analytic wave normals (so the sun glints across crests),
// a depth tint, a fresnel edge that picks up the pastel sky, and a soft animated
// shoreline foam. High adds a second high-frequency normal octave + bloom-crossing
// sparkle glints. All in the one onBeforeCompile — no render targets.
function buildWaterMaterial(): THREE.MeshStandardMaterial {
  const knobs = QUALITY[initialPreset()];
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5fc6e0,
    transparent: true,
    opacity: 0.74,
    roughness: 0.12,
    // Chrome-lake guard: with IBL on (medium/high) the envmap would over-reflect
    // a metallic water, so drop metalness where the extra shading takes over.
    metalness: knobs.waterExtra ? 0.1 : 0.25,
  });

  if (!knobs.waterExtra) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = waterTime;
      shader.vertexShader =
        "uniform float uTime;\n" +
        shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n        ${WAVE_VERT}`);
    };
    mat.customProgramCacheKey = () => "water";
    return mat;
  }

  const sparkle = knobs.waterSparkle;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterTime;
    shader.uniforms.uShallow = { value: new THREE.Color(0x86dbe0) };
    shader.uniforms.uDeep = { value: new THREE.Color(0x1f7fa8) };
    shader.uniforms.uEdge = { value: new THREE.Color(0xffd9ec) };

    shader.vertexShader =
      `uniform float uTime;
       attribute float aDepth;
       varying float vDepth;
       varying vec3 vWPos;
       varying vec3 vWNormal;\n` +
      shader.vertexShader
        .replace(
          "#include <beginnormal_vertex>",
          // Analytic normal from the exact wave derivatives, plus (high) a faster,
          // finer octave used ONLY in the normal — micro-ripple glints, no extra
          // vertex displacement.
          `float wnx = 0.0234 * cos(position.x * 0.18 + uTime * 1.4);
           float wnz = -0.0286 * sin(position.z * 0.22 + uTime * 1.1);
           ${sparkle ? `wnx += 0.027 * cos(position.x * 0.9 + uTime * 3.2);
           wnz += -0.033 * sin(position.z * 1.1 + uTime * 2.6);` : ``}
           vec3 objectNormal = normalize(vec3(-wnx, 1.0, -wnz));`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           ${WAVE_VERT}
           vDepth = aDepth;
           vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
           vWNormal = normalize(mat3(modelMatrix) * objectNormal);`,
        );

    shader.fragmentShader =
      `uniform vec3 uShallow;
       uniform vec3 uDeep;
       uniform vec3 uEdge;
       uniform float uTime;
       varying float vDepth;
       varying vec3 vWPos;
       varying vec3 vWNormal;\n` +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         float wx = vWPos.x, wz = vWPos.z;
         // Deeper water reads darker + more saturated; shallows go milky pastel.
         // The ponds are shallow (~3-4 units), so saturate quickly (by ~2 units)
         // or the teal never shows.
         float depthT = smoothstep(0.3, 2.0, vDepth);
         vec3 wcol = mix(uShallow, uDeep, depthT);
         // Fresnel: grazing angles (far lake edges at this camera pitch) pick up
         // the pastel sky and turn more opaque — a cheap stand-in for reflection.
         vec3 V = normalize(cameraPosition - vWPos);
         float fres = pow(1.0 - clamp(dot(normalize(vWNormal), V), 0.0, 1.0), 3.0);
         wcol += uEdge * fres * 0.22;
         // Deep water hides more of the bright lakebed, so the tint actually reads.
         float alpha = clamp(0.6 + depthT * 0.3 + fres * 0.2, 0.6, 0.95);
         // A thin animated shoreline lick from the baked shore distance — kept
         // narrow (only the first ~0.3 units of depth) so it reads as foam, not ice.
         float foam = smoothstep(0.28, 0.03, vDepth
                      + sin(wx * 2.1 + uTime * 1.7) * 0.07
                      + sin(wz * 1.7 - uTime * 1.3) * 0.07);
         wcol = mix(wcol, vec3(0.92), foam * 0.5);
         alpha = max(alpha, foam * 0.8);
         ${sparkle ? `// Occasional crest pixels cross the bloom threshold → twinkle.
         float spark = step(0.997, sin(wx * 13.7 + uTime * 3.0) * sin(wz * 11.3 - uTime * 2.2));
         wcol += spark * 0.6;` : ``}
         diffuseColor.rgb = wcol;
         diffuseColor.a = alpha;`,
      );
  };
  mat.customProgramCacheKey = () => "water" + (sparkle ? "H" : "M");
  return mat;
}

const _scorch = new THREE.Color(0x241a12);
const _rimDirt = new THREE.Color(0x6f553a);
const _cc = new THREE.Color();

// Re-sample the visual mesh's height + normal (and optionally scorch colour) for
// every vertex in the grid window around (ccx, ccz). Reads x/z straight from the
// position attribute (only Y is ever mutated), so no grid-index math can drift.
// Normals are computed analytically from `terrainHeight` finite differences —
// O(window) — instead of `computeVertexNormals` over all ~51k triangles.
function resampleWindow(
  pos: THREE.BufferAttribute,
  col: THREE.BufferAttribute | undefined,
  nrm: THREE.BufferAttribute | undefined,
  n: number, // vertices per row (segments + 1)
  cell: number, // world units per grid cell
  ccx: number,
  ccz: number,
  reach: number,
  scorch: { radius: number } | null,
): void {
  const seg = n - 1;
  const half = WORLD / 2;
  // +1 cell of margin so vertices whose analytic normal samples reach into the
  // deformed region also get their normals refreshed.
  const ixMin = Math.max(0, Math.floor((ccx - reach + half) / cell) - 1);
  const ixMax = Math.min(seg, Math.ceil((ccx + reach + half) / cell) + 1);
  const izMin = Math.max(0, Math.floor((ccz - reach + half) / cell) - 1);
  const izMax = Math.min(seg, Math.ceil((ccz + reach + half) / cell) + 1);
  const e = cell;
  for (let iz = izMin; iz <= izMax; iz++) {
    for (let ix = ixMin; ix <= ixMax; ix++) {
      const i = iz * n + ix;
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, terrainHeight(x, z));
      if (nrm) {
        const nx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
        const nz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
        const inv = 1 / Math.hypot(nx, 2 * e, nz);
        nrm.setXYZ(i, nx * inv, 2 * e * inv, nz * inv);
      }
      if (scorch && col) {
        const d = Math.hypot(x - ccx, z - ccz);
        const t = d / scorch.radius;
        _cc.fromBufferAttribute(col, i);
        const soot = Math.max(0, 1 - t); // strongest at centre
        _cc.lerp(_scorch, soot * 0.85);
        const rt = (d - scorch.radius * 0.7) / (scorch.radius * 0.55);
        if (rt > 0 && rt < 1) _cc.lerp(_rimDirt, Math.sin(rt * Math.PI) * 0.4);
        col.setXYZ(i, _cc.r, _cc.g, _cc.b);
      }
    }
  }
}

// Deform the visual terrain into a crater: a bowl with a raised, scorched rim.
// Registers the crater so the analytic `terrainHeight` matches, then re-samples
// only the affected vertex window (height + analytic normals + soot colour).
export function carveCrater(
  geo: THREE.BufferGeometry,
  cx: number,
  cz: number,
  radius: number,
  depth: number,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute | undefined;
  const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const n = Math.round(Math.sqrt(pos.count)); // segments + 1
  const cell = WORLD / (n - 1);

  // Cap the register: retire the oldest crater and heal its window (the visual
  // mesh there springs back to whatever craters remain). Rare in practice.
  if (craters.length >= CRATER_CAP) {
    const old = craters.shift()!;
    resampleWindow(pos, col, nrm, n, cell, old.x, old.z, old.r * 1.3, null);
  }
  craters.push({ x: cx, z: cz, r: radius, depth });
  registerRimHeat(cx, cz, radius);
  resampleWindow(pos, col, nrm, n, cell, cx, cz, radius * 1.3, { radius });

  pos.needsUpdate = true;
  if (col) col.needsUpdate = true;
  if (nrm) nrm.needsUpdate = true;
}
