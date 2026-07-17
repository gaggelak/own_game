import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { terrainHeight, WORLD } from "./terrain";
import { softDot } from "./textures";
import { initialPreset, QUALITY } from "./quality";

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
    const mat = new THREE.MeshBasicMaterial({
      color: col,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      fog: false,
    });
    // Push the arc into HDR so the locked bloom gives it a soft real glow.
    mat.color.multiplyScalar(1.6);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(70 + i * 1.7, 0.8, 8, 80, Math.PI), mat);
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
    vertexColors: true, // underside-mauve → top-white tint baked into cloudGeo
  });
  // Fewer, smaller puffs than before: the camera can fly through them, and each
  // transparent puff is a full-screen overdraw event (amplified by bloom), so
  // trimming the count + footprint bounds that spike without losing the look.
  const cloudGeo = new THREE.IcosahedronGeometry(2.1, 0);
  // Flat-bottomed pastel puffs: mauve underside fading to white on top, so they
  // read as lit blobs instead of flat white balls.
  {
    const cpos = cloudGeo.attributes.position;
    const ccol = new Float32Array(cpos.count * 3);
    const under = new THREE.Color(0xe8d6e4);
    const over = new THREE.Color(0xffffff);
    const tmp = new THREE.Color();
    for (let i = 0; i < cpos.count; i++) {
      tmp.copy(under).lerp(over, THREE.MathUtils.smoothstep(cpos.getY(i) / 2.1, -1, 1));
      ccol[i * 3] = tmp.r;
      ccol[i * 3 + 1] = tmp.g;
      ccol[i * 3 + 2] = tmp.b;
    }
    cloudGeo.setAttribute("color", new THREE.BufferAttribute(ccol, 3));
  }
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
  const sparkleCol = new Float32Array(SPARKLES * 3);
  // A five-pastel palette (pink / mint / lilac / gold / sky) instead of uniform
  // white confetti — variety at zero per-frame cost.
  const sparklePalette = [0xffc7e6, 0xbdf5d6, 0xd9c2ff, 0xffe9a8, 0xbfe3ff];
  const _sc = new THREE.Color();
  for (let i = 0; i < SPARKLES; i++) {
    sparklePos[i * 3] = (Math.random() - 0.5) * WORLD;
    sparklePos[i * 3 + 1] = Math.random() * 40;
    sparklePos[i * 3 + 2] = (Math.random() - 0.5) * WORLD;
    sparkleSpeed[i] = 1 + Math.random() * 2.5;
    _sc.setHex(sparklePalette[i % sparklePalette.length]);
    sparkleCol[i * 3] = _sc.r;
    sparkleCol[i * 3 + 1] = _sc.g;
    sparkleCol[i * 3 + 2] = _sc.b;
  }
  sparkleGeo.setAttribute("position", new THREE.BufferAttribute(sparklePos, 3));
  sparkleGeo.setAttribute("color", new THREE.BufferAttribute(sparkleCol, 3));
  const sparkles = new THREE.Points(
    sparkleGeo,
    new THREE.PointsMaterial({
      size: 0.9,
      map: softDot("rgba(255,255,255,1)", "rgba(255,235,250,0.8)", "rgba(255,255,255,0)", 0.3),
      vertexColors: true,
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
  // Shared materials + body geometry: one wing material per palette colour and a
  // single body material, instead of a fresh pair per butterfly (was 16×2 ≈ 32).
  const wingMats = butterflyPalette.map(
    (color) =>
      new THREE.MeshStandardMaterial({
        color,
        side: THREE.DoubleSide,
        roughness: 0.5,
        emissive: color,
        emissiveIntensity: 0.2,
        transparent: true,
        opacity: 0.95,
      }),
  );
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2233, roughness: 0.6 });
  const bodyGeo = new THREE.CapsuleGeometry(0.018, 0.12, 3, 6);
  const rich = QUALITY[initialPreset()].ambienceRich;
  const butterflies: Butterfly[] = [];
  for (let i = 0; i < (rich ? 28 : 16); i++) {
    const group = new THREE.Group();
    const wingMat = wingMats[i % wingMats.length];
    const left = new THREE.Mesh(wingGeo, wingMat);
    const right = new THREE.Mesh(wingGeo, wingMat);
    right.scale.x = -1;
    const body = new THREE.Mesh(bodyGeo, bodyMat);
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

  // ---- Pollen motes (warm golden drift under the canopy, high only) --------
  const POLLEN = 220;
  let pollenPos: Float32Array | null = null;
  let pollenPhase: Float32Array | null = null;
  let pollenBaseY: Float32Array | null = null;
  let pollenGeo: THREE.BufferGeometry | null = null;
  if (rich) {
    pollenGeo = new THREE.BufferGeometry();
    pollenPos = new Float32Array(POLLEN * 3);
    pollenPhase = new Float32Array(POLLEN);
    pollenBaseY = new Float32Array(POLLEN);
    for (let i = 0; i < POLLEN; i++) {
      const x = (Math.random() - 0.5) * 180;
      const z = (Math.random() - 0.5) * 180;
      const y = terrainHeight(x, z) + 1 + Math.random() * 4;
      pollenPos[i * 3] = x;
      pollenPos[i * 3 + 1] = y;
      pollenPos[i * 3 + 2] = z;
      pollenBaseY[i] = y;
      pollenPhase[i] = Math.random() * Math.PI * 2;
    }
    pollenGeo.setAttribute("position", new THREE.BufferAttribute(pollenPos, 3));
    const pollen = new THREE.Points(
      pollenGeo,
      new THREE.PointsMaterial({
        size: 0.45,
        map: softDot("rgba(255,245,200,1)", "rgba(255,240,180,0.7)", "rgba(255,240,180,0)", 0.35),
        color: 0xfff2c0,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    scene.add(pollen);
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

      // Pollen drifts slowly and bobs (high only).
      if (pollenPos && pollenGeo && pollenPhase && pollenBaseY) {
        for (let i = 0; i < POLLEN; i++) {
          pollenPos[i * 3] += Math.sin(t * 0.2 + pollenPhase[i]) * 0.25 * dt;
          pollenPos[i * 3 + 2] += Math.cos(t * 0.17 + pollenPhase[i]) * 0.2 * dt;
          pollenPos[i * 3 + 1] = pollenBaseY[i] + Math.sin(t * 0.5 + pollenPhase[i]) * 0.5;
        }
        pollenGeo.attributes.position.needsUpdate = true;
      }
    },
  };
}
