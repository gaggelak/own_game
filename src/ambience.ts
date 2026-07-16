import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { terrainHeight, WORLD } from "./terrain";
import { softDot } from "./textures";

// Non-interactive scenery that just lives and drifts: the rainbow arc, drifting
// clouds, floating sparkle motes and fluttering butterflies. Pulled out of
// main.ts so it stays pure orchestration; create once, call update() per frame.

interface Butterfly {
  group: THREE.Group;
  left: THREE.Mesh;
  right: THREE.Mesh;
  cx: number;
  cz: number;
  radius: number;
  speed: number;
  phase: number;
  flap: number;
}

export interface Ambience {
  update(dt: number, t: number): void;
}

const SPARKLES = 600;

export function createAmbience(scene: THREE.Scene): Ambience {
  // ---- Rainbow arc (concentric half-tori) — static -------------------------
  const rainbow = new THREE.Group();
  const rainbowColors = [
    0xff6b6b, 0xffa64d, 0xffe14d, 0x6bd96b, 0x4db8ff, 0x6b6bff, 0xb86bff,
  ];
  rainbowColors.forEach((col, i) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(70 + i * 1.7, 0.8, 8, 80, Math.PI),
      new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        fog: false,
      }),
    );
    rainbow.add(ring);
  });
  rainbow.position.set(-10, -6, -170);
  scene.add(rainbow);

  // ---- Clouds (drifting low-poly puffs) ------------------------------------
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    flatShading: true,
    transparent: true,
    opacity: 0.92,
  });
  // Fewer, smaller puffs than before: the camera can fly through them, and each
  // transparent puff is a full-screen overdraw event (amplified by bloom), so
  // trimming the count + footprint bounds that spike without losing the look.
  const cloudGeo = new THREE.IcosahedronGeometry(2.1, 0);
  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(Math.random() * 2);
    for (let p = 0; p < puffs; p++) {
      const puff = new THREE.Mesh(cloudGeo, cloudMat);
      puff.position.set((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 1.3, (Math.random() - 0.5) * 4.5);
      puff.scale.set(0.9 + Math.random() * 0.8, 0.65 + Math.random() * 0.35, 0.9 + Math.random() * 0.8);
      cloud.add(puff);
    }
    cloud.position.set(
      (Math.random() - 0.5) * 260,
      45 + Math.random() * 30,
      (Math.random() - 0.5) * 260,
    );
    clouds.push(cloud);
    scene.add(cloud);
  }

  // ---- Sparkles (floating magical motes) -----------------------------------
  const sparkleGeo = new THREE.BufferGeometry();
  const sparklePos = new Float32Array(SPARKLES * 3);
  const sparkleSpeed = new Float32Array(SPARKLES);
  for (let i = 0; i < SPARKLES; i++) {
    sparklePos[i * 3] = (Math.random() - 0.5) * WORLD;
    sparklePos[i * 3 + 1] = Math.random() * 40;
    sparklePos[i * 3 + 2] = (Math.random() - 0.5) * WORLD;
    sparkleSpeed[i] = 1 + Math.random() * 2.5;
  }
  sparkleGeo.setAttribute("position", new THREE.BufferAttribute(sparklePos, 3));
  const sparkles = new THREE.Points(
    sparkleGeo,
    new THREE.PointsMaterial({
      size: 0.9,
      map: softDot("rgba(255,255,255,1)", "rgba(255,235,250,0.8)", "rgba(255,255,255,0)", 0.3),
      color: 0xfff0fa,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }),
  );
  scene.add(sparkles);

  // ---- Butterflies (fluttering, flapping wings) ----------------------------
  const makeWing = (): THREE.BufferGeometry => {
    const fore = new THREE.CircleGeometry(0.13, 10).translate(0, 0.02, 0.08);
    const hind = new THREE.CircleGeometry(0.09, 10).translate(0, 0.02, -0.08);
    return mergeGeometries([fore, hind], false);
  };
  const wingGeo = makeWing();
  const butterflyPalette = [0xff8fc7, 0xffd166, 0x8fd3ff, 0xc6a8ff, 0xff9a7a];
  const butterflies: Butterfly[] = [];
  for (let i = 0; i < 16; i++) {
    const group = new THREE.Group();
    const color = butterflyPalette[i % butterflyPalette.length];
    const wingMat = new THREE.MeshStandardMaterial({
      color,
      side: THREE.DoubleSide,
      roughness: 0.5,
      emissive: color,
      emissiveIntensity: 0.2,
      transparent: true,
      opacity: 0.95,
    });
    const left = new THREE.Mesh(wingGeo, wingMat);
    const right = new THREE.Mesh(wingGeo, wingMat);
    right.scale.x = -1;
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.018, 0.12, 3, 6),
      new THREE.MeshStandardMaterial({ color: 0x2a2233, roughness: 0.6 }),
    );
    body.rotation.x = Math.PI / 2;
    group.add(left, right, body);

    const cx = (Math.random() - 0.5) * 110;
    const cz = (Math.random() - 0.5) * 110;
    butterflies.push({
      group,
      left,
      right,
      cx,
      cz,
      radius: 4 + Math.random() * 10,
      speed: 0.3 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      flap: 8 + Math.random() * 6,
    });
    scene.add(group);
  }

  return {
    update(dt: number, t: number): void {
      // Sparkles rise and wrap.
      for (let i = 0; i < SPARKLES; i++) {
        let y = sparklePos[i * 3 + 1] + sparkleSpeed[i] * dt;
        if (y > 42) y = 0;
        sparklePos[i * 3 + 1] = y;
        sparklePos[i * 3] += Math.sin(t + i) * 0.6 * dt; // frame-rate independent drift
      }
      sparkleGeo.attributes.position.needsUpdate = true;

      // Clouds drift.
      for (const cloud of clouds) {
        cloud.position.x += dt * 1.5;
        if (cloud.position.x > WORLD / 2 + 30) cloud.position.x = -WORLD / 2 - 30;
      }

      // Butterflies flutter on looping paths.
      for (const b of butterflies) {
        const a = t * b.speed + b.phase;
        const x = b.cx + Math.cos(a) * b.radius;
        const z = b.cz + Math.sin(a * 1.3) * b.radius;
        const y = terrainHeight(x, z) + 2.2 + Math.sin(t * 2 + b.phase) * 0.6;
        b.group.position.set(x, y, z);
        b.group.rotation.y = -a;
        const wing = Math.sin(t * b.flap + b.phase) * 0.9;
        b.left.rotation.y = wing;
        b.right.rotation.y = -wing;
      }
    },
  };
}
