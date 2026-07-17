import * as THREE from "three";
import { terrainHeight, WORLD, WATER_LEVEL } from "./terrain";
import {
  loadScene,
  extractParts,
  scatter,
  scatterChunked,
  type Placement,
  type FitOpts,
  type ScatterChunk,
} from "./assets";
import { initialPreset, QUALITY } from "./quality";

// Shared wind time, updated each frame from the main loop.
const windTime = { value: 0 };

// Up to 4 active blast impacts that flatten grass. Each vec4 is
// (worldX, worldZ, radius, strength); strength decays as the grass recovers.
// Shared across every grass material clone and baked into the shader from the
// first compile so impacts never trigger a recompile.
const IMPACT_SLOTS = 4;
const IMPACT_RECOVER = 9; // seconds for flattened grass to spring back
const grassImpacts = {
  value: Array.from({ length: IMPACT_SLOTS }, () => new THREE.Vector4(0, 0, 1, 0)),
};
const impactBorn = new Array<number>(IMPACT_SLOTS).fill(-1e9);
const impactStrength0 = new Array<number>(IMPACT_SLOTS).fill(0);
let impactCursor = 0;

// Grass is scattered into per-cell chunks so three.js can frustum-cull the ones
// off-screen, and so we can distance-cull and locally clear (crater) them. The
// cull uses true 3D distance to the chunk centre, so zooming/craning the camera
// up and out also drops the grass (not just panning it off-screen).
const GRASS_CELL = 24;
// Grass view distance is preset-driven (low trims it in) and can change live
// when the player cycles quality, so it's a mutable cull threshold rather than a
// const. Default matches the medium/high MAX (170) until a preset overrides it.
// Slack of one half-cell diagonal so a chunk stays fully drawn out to the view
// distance before its centre crosses the threshold (no visible cull ring).
let grassCullSq = (170 + GRASS_CELL * 0.71) ** 2;
/** Set the grass chunk view distance (world units). Hot-swappable per preset. */
export function setGrassViewDistance(dist: number): void {
  grassCullSq = (dist + GRASS_CELL * 0.71) ** 2;
}
const grassChunks: ScatterChunk[] = [];

const NATURE = "/models/nature/";

// ---------------------------------------------------------------------------
// Retained props (trees/rocks/bushes) so blasts can topple individual instances.
// Each PropGroup is one model variant: the InstancedMeshes for its parts share
// one placement array. A coarse uniform grid indexes instances for spatial
// queries. Grass/flowers/mushrooms/lilies are NOT retained.
// ---------------------------------------------------------------------------
export type PropKind = "tree" | "rock" | "bush";

interface PropGroup {
  meshes: THREE.InstancedMesh[];
  places: Placement[];
  baseSize: THREE.Vector3; // union bbox of the parts (model space, pre-scale)
  hidden: Uint8Array;
  kind: PropKind;
}

export interface PropHit {
  meshes: THREE.InstancedMesh[]; // share geometry+material to build the topple mesh
  position: THREE.Vector3; // world base point
  yaw: number;
  scale: number;
  scaleY: number;
  size: THREE.Vector3; // world-space bounding size
  group: PropGroup;
  index: number;
}

const GRID_CELL = 8;
const propGroups: PropGroup[] = [];
const propGrid = new Map<number, { group: PropGroup; index: number }[]>();
const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);

// Clearable ground cover (flowers, mushrooms): not retained props (they can't
// topple) and not chunked grass, but still zeroed out inside a fresh crater so
// they don't hang in the air over the carved bowl. A flat list is enough — only
// ~1k placements total, scanned linearly on the rare impact.
interface DecoGroup {
  meshes: THREE.InstancedMesh[];
  places: Placement[];
  hidden: Uint8Array;
}
const decoGroups: DecoGroup[] = [];

function cellKey(x: number, z: number): number {
  const cx = Math.floor((x + WORLD / 2) / GRID_CELL);
  const cz = Math.floor((z + WORLD / 2) / GRID_CELL);
  return cx * 1000 + cz;
}

function registerPropGroup(
  meshes: THREE.InstancedMesh[],
  places: Placement[],
  parts: { geometry: THREE.BufferGeometry }[],
  kind: PropKind,
): void {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    if (p.geometry.boundingBox) box.union(tmp.copy(p.geometry.boundingBox));
  }
  const baseSize = new THREE.Vector3();
  box.getSize(baseSize);
  const group: PropGroup = { meshes, places, baseSize, hidden: new Uint8Array(places.length), kind };
  propGroups.push(group);
  for (let i = 0; i < places.length; i++) {
    const k = cellKey(places[i].x, places[i].z);
    let arr = propGrid.get(k);
    if (!arr) propGrid.set(k, (arr = []));
    arr.push({ group, index: i });
  }
}

function queryProps(point: THREE.Vector3, radius: number, max: number): PropHit[] {
  const hits: { hit: PropHit; d2: number }[] = [];
  const cxMin = Math.floor((point.x - radius + WORLD / 2) / GRID_CELL);
  const cxMax = Math.floor((point.x + radius + WORLD / 2) / GRID_CELL);
  const czMin = Math.floor((point.z - radius + WORLD / 2) / GRID_CELL);
  const czMax = Math.floor((point.z + radius + WORLD / 2) / GRID_CELL);
  const r2 = radius * radius;
  for (let cx = cxMin; cx <= cxMax; cx++) {
    for (let cz = czMin; cz <= czMax; cz++) {
      const arr = propGrid.get(cx * 1000 + cz);
      if (!arr) continue;
      for (const { group, index } of arr) {
        if (group.hidden[index]) continue;
        const pl = group.places[index];
        const dx = pl.x - point.x;
        const dz = pl.z - point.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        hits.push({
          d2,
          hit: {
            meshes: group.meshes,
            position: new THREE.Vector3(pl.x, pl.y, pl.z),
            yaw: pl.yaw,
            scale: pl.scale,
            scaleY: pl.scaleY,
            size: new THREE.Vector3(
              group.baseSize.x * pl.scale,
              group.baseSize.y * pl.scale * pl.scaleY,
              group.baseSize.z * pl.scale,
            ),
            group,
            index,
          },
        });
      }
    }
  }
  hits.sort((a, b) => a.d2 - b.d2);
  return hits.slice(0, max).map((h) => h.hit);
}

function hideInstance(hit: PropHit): void {
  hit.group.hidden[hit.index] = 1;
  for (const im of hit.group.meshes) {
    im.setMatrixAt(hit.index, _zeroMat);
    im.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Placement sampling
// ---------------------------------------------------------------------------
function sampleLand(
  count: number,
  minH: number,
  maxH: number,
  maxSlope: number,
  spread = WORLD - 20,
): Placement[] {
  const out: Placement[] = [];
  let attempts = 0;
  const cap = count * 30;
  while (out.length < count && attempts < cap) {
    attempts++;
    const x = (Math.random() - 0.5) * spread;
    const z = (Math.random() - 0.5) * spread;
    const h = terrainHeight(x, z);
    if (h < minH || h > maxH) continue;
    const slope =
      Math.abs(h - terrainHeight(x + 1.5, z)) + Math.abs(h - terrainHeight(x, z + 1.5));
    if (slope > maxSlope) continue;
    out.push({ x, z, y: h, yaw: Math.random() * Math.PI * 2, scale: 1, scaleY: 1 });
  }
  return out;
}

function sampleWater(count: number): Placement[] {
  const out: Placement[] = [];
  let attempts = 0;
  const cap = count * 40;
  while (out.length < count && attempts < cap) {
    attempts++;
    const x = (Math.random() - 0.5) * (WORLD - 30);
    const z = (Math.random() - 0.5) * (WORLD - 30);
    if (terrainHeight(x, z) < WATER_LEVEL - 0.6) {
      out.push({
        x,
        z,
        // Sit above the water-ripple crest (amplitude ~0.26) so pads don't dip
        // under the surface as it swells.
        y: WATER_LEVEL + 0.32,
        yaw: Math.random() * Math.PI * 2,
        scale: 1,
        scaleY: 1,
      });
    }
  }
  return out;
}

function setScale(places: Placement[], min: number, max: number, yJitter = 0.12): void {
  for (const p of places) {
    p.scale = min + Math.random() * (max - min);
    p.scaleY = 1 - yJitter + Math.random() * yJitter * 2;
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Wind shader injection (grass sway)
// ---------------------------------------------------------------------------
function applyWind(mat: THREE.Material, strength: number): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windTime;
    shader.uniforms.uImpacts = grassImpacts;
    shader.vertexShader =
      "uniform float uTime;\nuniform vec4 uImpacts[4];\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 iPos = instanceMatrix[3].xyz;
        #else
          vec3 iPos = vec3(0.0);
        #endif
        float ph = uTime * 1.5 + iPos.x * 0.25 + iPos.z * 0.2;
        float gust = 0.55 + 0.45 * sin(uTime * 0.5 + iPos.x * 0.06 + iPos.z * 0.04);
        float bend = max(transformed.y, 0.0);
        float sway = (sin(ph) + 0.3 * sin(ph * 2.3)) * ${strength.toFixed(3)} * gust;
        transformed.x += sway * bend;
        transformed.z += cos(ph * 0.8) * ${(strength * 0.6).toFixed(3)} * gust * bend;
        for (int k = 0; k < 4; k++) {
          vec4 im = uImpacts[k];
          if (im.w <= 0.0) continue;
          vec2 dd = iPos.xz - im.xy;
          float dist = length(dd);
          if (dist < im.z) {
            float push = im.w * (1.0 - dist / im.z);
            vec2 dir = dist > 0.001 ? dd / dist : vec2(1.0, 0.0);
            transformed.xz += dir * push * 3.0 * bend; // splay blades outward
            transformed.y -= bend * 0.82 * push;       // press them flat
          }
        }`,
      );
  };
  mat.customProgramCacheKey = () => "wind" + strength.toFixed(3);
}

// ---------------------------------------------------------------------------
// Scatter a set of model variants across placements, splitting the placements
// evenly between the variant URLs.
// ---------------------------------------------------------------------------
async function scatterVariants(
  scene: THREE.Scene,
  urls: string[],
  places: Placement[],
  opts: FitOpts,
  kind?: PropKind,
  castShadow = true,
  clearable = false,
): Promise<void> {
  shuffle(places);
  const per = Math.ceil(places.length / urls.length);
  await Promise.all(
    urls.map(async (url, i) => {
      const chunk = places.slice(i * per, (i + 1) * per);
      if (chunk.length === 0) return;
      const parts = extractParts(await loadScene(NATURE + url), opts);
      const ims = scatter(parts, chunk);
      for (const im of ims) {
        im.castShadow = castShadow;
        scene.add(im);
      }
      if (kind) registerPropGroup(ims, chunk, parts, kind);
      if (clearable) decoGroups.push({ meshes: ims, places: chunk, hidden: new Uint8Array(chunk.length) });
    }),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface Flora {
  update(time: number, cameraPos?: THREE.Vector3): void;
  setImpact(point: THREE.Vector3, radius: number, strength: number, time: number): void;
  clearGrassAt(point: THREE.Vector3, radius: number): void;
  clearDecoAt(point: THREE.Vector3, radius: number): void;
  queryProps(point: THREE.Vector3, radius: number, max: number): PropHit[];
  hideInstance(hit: PropHit): void;
}

const TREES = [
  "tree_default.glb",
  "tree_oak.glb",
  "tree_fat.glb",
  "tree_tall.glb",
  "tree_detailed.glb",
  "tree_pineTallA.glb",
  "tree_pineRoundA.glb",
];
const BUSHES = ["plant_bush.glb", "plant_bushDetailed.glb", "plant_bushLarge.glb", "plant_bushSmall.glb"];
const ROCKS = ["rock_largeA.glb", "rock_largeB.glb", "rock_largeC.glb", "rock_smallA.glb", "rock_smallB.glb", "stone_largeA.glb", "stone_smallA.glb", "stone_tallA.glb"];
const FLOWERS = ["flower_redA.glb", "flower_purpleA.glb", "flower_yellowA.glb", "flower_redB.glb", "flower_purpleC.glb"];
const MUSHROOMS = ["mushroom_red.glb", "mushroom_tan.glb", "mushroom_redGroup.glb"];
const LILIES = ["lily_large.glb", "lily_small.glb"];

export async function populateFlora(scene: THREE.Scene): Promise<Flora> {
  // Trees.
  const treePlaces = sampleLand(420, WATER_LEVEL + 1.2, 13, 3);
  setScale(treePlaces, 0.75, 1.4, 0.2);
  const treesDone = scatterVariants(scene, TREES, treePlaces, { target: 6, fit: "height" }, "tree");

  // Bushes.
  const bushPlaces = sampleLand(260, WATER_LEVEL + 0.7, 9, 3);
  setScale(bushPlaces, 0.7, 1.5);
  const bushesDone = scatterVariants(scene, BUSHES, bushPlaces, { target: 1.3, fit: "height" }, "bush");

  // Rocks + stones.
  const rockPlaces = sampleLand(150, WATER_LEVEL - 0.5, 16, 100);
  setScale(rockPlaces, 0.5, 1.8, 0.25);
  const rocksDone = scatterVariants(scene, ROCKS, rockPlaces, { target: 1.4, fit: "height" }, "rock");

  // Flowers. Small ground cover — no shadow casting (cheaper shadow pass).
  // Clearable so a meteor crater doesn't leave them floating over the bowl.
  const flowerPlaces = sampleLand(900, WATER_LEVEL + 0.7, 8, 2.2);
  setScale(flowerPlaces, 0.7, 1.3);
  const flowersDone = scatterVariants(scene, FLOWERS, flowerPlaces, { target: 0.6, fit: "height" }, undefined, false, true);

  // Mushrooms.
  const mushPlaces = sampleLand(120, WATER_LEVEL + 0.6, 8, 2);
  setScale(mushPlaces, 0.7, 1.4);
  const mushDone = scatterVariants(scene, MUSHROOMS, mushPlaces, { target: 0.4, fit: "height" }, undefined, false, true);

  // Lily pads on the water.
  const lilyPlaces = sampleWater(80);
  setScale(lilyPlaces, 0.7, 1.4);
  const lilyDone = scatterVariants(scene, LILIES, lilyPlaces, { target: 1.0, fit: "width" }, undefined, false);

  // Grass — a dense carpet from a single model, with wind. Scattered into a grid
  // of per-cell chunks (one shared wind material) so off-screen + far cells cull.
  // Density + view distance come from the boot quality preset (low thins it out).
  const bootKnobs = QUALITY[initialPreset()];
  setGrassViewDistance(bootKnobs.grassViewDist);
  const grassPlaces = sampleLand(bootKnobs.grassCount, WATER_LEVEL + 0.2, 10, 3.5);
  setScale(grassPlaces, 0.8, 1.5, 0.3);
  const grassDone = (async () => {
    const parts = extractParts(await loadScene(NATURE + "grass.glb"), {
      target: 0.36,
      fit: "height",
    });
    for (const part of parts) {
      const withWind = (m: THREE.Material) => {
        const c = m.clone();
        applyWind(c, 0.22);
        return c;
      };
      part.material = Array.isArray(part.material)
        ? part.material.map(withWind)
        : withWind(part.material);
    }
    for (const chunk of scatterChunked(parts, grassPlaces, GRASS_CELL)) {
      grassChunks.push(chunk);
      for (const im of chunk.meshes) scene.add(im);
    }
  })();

  await Promise.all([treesDone, bushesDone, rocksDone, flowersDone, mushDone, lilyDone, grassDone]);

  return {
    update(time: number, cameraPos?: THREE.Vector3) {
      windTime.value = time;
      for (let i = 0; i < IMPACT_SLOTS; i++) {
        const age = time - impactBorn[i];
        grassImpacts.value[i].w = impactStrength0[i] * Math.max(0, 1 - age / IMPACT_RECOVER);
      }
      // Hide grass chunks whose centre is beyond the view distance. Three.js
      // frustum-culls the rest by their per-chunk bounding spheres.
      if (cameraPos) {
        for (const chunk of grassChunks) {
          const dx = chunk.cx - cameraPos.x;
          const dy = chunk.cy - cameraPos.y;
          const dz = chunk.cz - cameraPos.z;
          const visible = dx * dx + dy * dy + dz * dz < grassCullSq;
          for (const im of chunk.meshes) im.visible = visible;
        }
      }
    },
    setImpact(point: THREE.Vector3, radius: number, strength: number, time: number) {
      const i = impactCursor;
      impactCursor = (impactCursor + 1) % IMPACT_SLOTS;
      grassImpacts.value[i].set(point.x, point.z, radius, strength);
      impactBorn[i] = time;
      impactStrength0[i] = strength;
    },
    // Permanently remove grass blades inside a circle (the meteor crater) by
    // zeroing their instance matrices — the bare scorched bowl shows no grass.
    clearGrassAt(point: THREE.Vector3, radius: number) {
      const r2 = radius * radius;
      // Only touch chunks whose cell could overlap the circle (centre within
      // radius + one half-cell diagonal).
      const reach = radius + GRASS_CELL * 0.71;
      const reach2 = reach * reach;
      for (const chunk of grassChunks) {
        const cdx = chunk.cx - point.x;
        const cdz = chunk.cz - point.z;
        if (cdx * cdx + cdz * cdz > reach2) continue;
        let cleared = false;
        for (let i = 0; i < chunk.places.length; i++) {
          const pl = chunk.places[i];
          const dx = pl.x - point.x;
          const dz = pl.z - point.z;
          if (dx * dx + dz * dz > r2) continue;
          for (const im of chunk.meshes) im.setMatrixAt(i, _zeroMat);
          cleared = true;
        }
        if (cleared) for (const im of chunk.meshes) im.instanceMatrix.needsUpdate = true;
      }
    },
    // Permanently hide flower/mushroom instances inside a circle (the meteor
    // crater), so ground cover doesn't float over the carved bowl.
    clearDecoAt(point: THREE.Vector3, radius: number) {
      const r2 = radius * radius;
      for (const g of decoGroups) {
        let cleared = false;
        for (let i = 0; i < g.places.length; i++) {
          if (g.hidden[i]) continue;
          const pl = g.places[i];
          const dx = pl.x - point.x;
          const dz = pl.z - point.z;
          if (dx * dx + dz * dz > r2) continue;
          g.hidden[i] = 1;
          for (const im of g.meshes) im.setMatrixAt(i, _zeroMat);
          cleared = true;
        }
        if (cleared) for (const im of g.meshes) im.instanceMatrix.needsUpdate = true;
      }
    },
    queryProps,
    hideInstance,
  };
}
