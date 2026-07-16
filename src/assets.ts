import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { asset } from "./base";

const loader = new GLTFLoader();
const sceneCache = new Map<string, Promise<THREE.Group>>();

// Callers pass root-absolute paths ("/models/…"); asset() makes them base-aware
// so the models resolve under any host prefix. Cache by the resolved URL.
export function loadScene(url: string): Promise<THREE.Group> {
  const resolved = asset(url);
  let p = sceneCache.get(resolved);
  if (!p) {
    p = loader.loadAsync(resolved).then((gltf) => gltf.scene);
    sceneCache.set(resolved, p);
  }
  return p;
}

export function loadGLTF(url: string) {
  return loader.loadAsync(asset(url));
}

// Kenney models are KHR_materials_unlit (flat color, no texture). Convert to a
// lit MeshStandardMaterial so they respond to the scene's lighting + shadows.
// The kit's baked palette skews turquoise/pale, so override the common nature
// material names with natural greens/browns for a cohesive look.
const COLOR_OVERRIDES: Record<string, number> = {
  leafsGreen: 0x6cb83c,
  leafs: 0x6cb83c,
  leafsDark: 0x2c6630,
  grass: 0x7cc24a,
  woodBark: 0x795334,
  woodBarkDark: 0x5e3f28,
  wood: 0x795334,
  dirt: 0x8a6a43,
};

const matCache = new Map<number, THREE.MeshStandardMaterial>();
function toStandard(src: THREE.Material): THREE.MeshStandardMaterial {
  const override = COLOR_OVERRIDES[src.name];
  const color =
    override !== undefined
      ? new THREE.Color(override)
      : ((src as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0xffffff));
  const key = color.getHex();
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
    });
    matCache.set(key, m);
  }
  return m;
}

export interface Placement {
  x: number;
  z: number;
  y: number;
  yaw: number;
  scale: number;
  scaleY: number;
}

export interface ProtoPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

export interface FitOpts {
  target: number;
  fit?: "height" | "width";
}

// Flatten a loaded model into normalized, world-baked geometry parts whose base
// sits at y=0 and which are centered on x/z, scaled to a target size.
export function extractParts(scene: THREE.Object3D, opts: FitOpts): ProtoPart[] {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const measure = opts.fit === "width" ? Math.max(size.x, size.z) : size.y;
  const scale = opts.target / Math.max(measure, 1e-4);
  const cx = ((box.min.x + box.max.x) / 2) * scale;
  const cz = ((box.min.z + box.max.z) / 2) * scale;
  const baseY = box.min.y * scale;

  const parts: ProtoPart[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as THREE.Mesh).isMesh) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    g.scale(scale, scale, scale);
    g.translate(-cx, -baseY, -cz);
    const material = Array.isArray(mesh.material)
      ? mesh.material.map(toStandard)
      : toStandard(mesh.material);
    parts.push({ geometry: g, material });
  });
  return parts;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export function scatter(parts: ProtoPart[], places: Placement[]): THREE.InstancedMesh[] {
  return parts.map((part) => {
    const im = new THREE.InstancedMesh(part.geometry, part.material, places.length);
    im.castShadow = true;
    im.receiveShadow = true;
    for (let i = 0; i < places.length; i++) {
      const pl = places[i];
      _p.set(pl.x, pl.y, pl.z);
      _q.setFromAxisAngle(_yAxis, pl.yaw);
      _s.set(pl.scale, pl.scale * pl.scaleY, pl.scale);
      _m.compose(_p, _q, _s);
      im.setMatrixAt(i, _m);
    }
    im.instanceMatrix.needsUpdate = true;
    return im;
  });
}

// One grid cell of a chunked scatter: every part's InstancedMesh for this cell,
// sharing the parts' geometry+material refs (so the whole carpet stays a single
// compiled program), plus the cell's placements and centre for distance culling
// and localized edits (e.g. clearing grass inside a crater).
export interface ScatterChunk {
  meshes: THREE.InstancedMesh[];
  places: Placement[];
  cx: number;
  cy: number;
  cz: number;
}

// Like `scatter`, but splits the placements into a uniform xz grid so each cell
// becomes its own InstancedMesh with a tight, instance-aware bounding sphere.
// Three.js then frustum-culls off-screen cells automatically; the caller adds
// per-frame distance culling on top. Meshes across cells share one
// geometry+material ref, so no extra programs/state changes are introduced.
export function scatterChunked(
  parts: ProtoPart[],
  places: Placement[],
  cellSize: number,
): ScatterChunk[] {
  const buckets = new Map<string, Placement[]>();
  for (const pl of places) {
    const key = Math.floor(pl.x / cellSize) + "," + Math.floor(pl.z / cellSize);
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(pl);
  }

  const chunks: ScatterChunk[] = [];
  for (const bucket of buckets.values()) {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const pl of bucket) {
      sx += pl.x;
      sy += pl.y;
      sz += pl.z;
    }
    const meshes = parts.map((part) => {
      const im = new THREE.InstancedMesh(part.geometry, part.material, bucket.length);
      im.castShadow = false;
      im.receiveShadow = true;
      for (let i = 0; i < bucket.length; i++) {
        const pl = bucket[i];
        _p.set(pl.x, pl.y, pl.z);
        _q.setFromAxisAngle(_yAxis, pl.yaw);
        _s.set(pl.scale, pl.scale * pl.scaleY, pl.scale);
        _m.compose(_p, _q, _s);
        im.setMatrixAt(i, _m);
      }
      im.instanceMatrix.needsUpdate = true;
      // Compute the cull sphere now so frame 1 doesn't hitch computing it lazily.
      im.computeBoundingSphere();
      return im;
    });
    chunks.push({
      meshes,
      places: bucket,
      cx: sx / bucket.length,
      cy: sy / bucket.length,
      cz: sz / bucket.length,
    });
  }
  return chunks;
}
