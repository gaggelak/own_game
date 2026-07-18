// ---------------------------------------------------------------------------
// Sky dome + image-based lighting.
//
// The dome is a big BackSide sphere with a gradient shader — same idea as the
// original inline dome, but now a 3-stop gradient (horizon → mid → zenith) with
// a horizon haze band and a "false sun": a warm bloom lobe planted in the sun's
// compass direction. The real sun is never in frame (the camera is pinned to a
// 50–60° polar band, so the top of the view sits just below horizontal), but its
// azimuth can be — the lobe peaks just over the bloom threshold so UnrealBloom
// paints a soft halo exactly where the light comes from, consistent with the
// shadows.
//
// Colours are fed as THREE.Color uniforms (sRGB→linear decoded by three's colour
// management), so their linear luminance is what matters against the locked bloom
// threshold of 0.85. The horizon stop sits just under it; only the false-sun lobe
// and the very skyline are allowed to bloom.
//
// This module also builds the IBL: a PMREM environment generated once from the
// dome alone, so water, the gold horns and every Standard material pick up a
// pastel-consistent sky reflection. IBL is medium/high only.
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { initialPreset, QUALITY } from "./quality";

// The single horizon pink. Fog + scene.background are unified to this so the far
// terrain edge dissolves seamlessly into the skyline (previously three slightly
// different pinks: dome bottom, fog, background).
export const HORIZON_COLOR = 0xffe3ee;

// Mirror of the DirectionalLight in main.ts (position 70,120,50). Kept here as a
// constant so the false-sun lobe lines up with the shadow direction without
// coupling the two files.
const SUN_POSITION = new THREE.Vector3(70, 120, 50);

function buildDome(): THREE.Mesh {
  const sunAzimuth = new THREE.Vector2(SUN_POSITION.x, SUN_POSITION.z).normalize();
  return new THREE.Mesh(
    new THREE.SphereGeometry(800, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uHorizon: { value: new THREE.Color(HORIZON_COLOR) },
        uMid: { value: new THREE.Color(0xffc9e4) },
        uZenith: { value: new THREE.Color(0x8fc9ff) },
        uHaze: { value: new THREE.Color(0xffeef2) },
        uSunColor: { value: new THREE.Color(0xfff0c4) },
        uSunAzimuth: { value: sunAzimuth },
        uOffset: { value: 120 },
        uExponent: { value: 0.7 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uHorizon;
        uniform vec3 uMid;
        uniform vec3 uZenith;
        uniform vec3 uHaze;
        uniform vec3 uSunColor;
        uniform vec2 uSunAzimuth;
        uniform float uOffset;
        uniform float uExponent;
        varying vec3 vWorld;

        void main() {
          vec3 wdir = normalize(vWorld);                              // true view dir
          vec3 gdir = normalize(vWorld + vec3(0.0, uOffset, 0.0));    // biased for the gradient
          float t = pow(clamp(gdir.y, 0.0, 1.0), uExponent);

          // 3-stop gradient: horizon → mid (at 0.18) → zenith. The mid stop
          // compresses the pastel band down so the blue actually reaches the frame.
          const float MID = 0.18;
          vec3 col = t < MID
            ? mix(uHorizon, uMid, t / MID)
            : mix(uMid, uZenith, (t - MID) / (1.0 - MID));

          // Horizon haze: a gentle skyline softening. Kept low so the band stays
          // UNDER the bloom threshold — at higher mixes it tips over and blooms
          // into a white wash across the top of the frame.
          float haze = exp(-abs(wdir.y) * 6.0);
          col = mix(col, uHaze, haze * 0.2);

          // False sun: tight warm lobe in the sun's azimuth, hugging the horizon.
          // Subtle — just a warm hint, not a second light source.
          float azi = max(dot(normalize(vWorld.xz), uSunAzimuth), 0.0);
          float glow = pow(azi, 8.0) * exp(-abs(wdir.y) * 4.0);
          col += uSunColor * glow * 0.14;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
}

/**
 * Build the sky dome, add it to the scene, and (on medium/high) generate a PMREM
 * environment from it for image-based lighting. Returns whether IBL was applied,
 * so the caller can trim the analytic ambient/hemisphere lights to compensate.
 */
export function createSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer): boolean {
  const dome = buildDome();
  const ibl = QUALITY[initialPreset()].ibl;

  if (ibl) {
    // Render the dome alone into a PMREM. Do it before the dome joins the real
    // scene so nothing else leaks into the reflection.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    envScene.add(dome);
    const rt = pmrem.fromScene(envScene, 0, 1, 1200);
    scene.environment = rt.texture;
    // Low: the IBL is only meant to give water + horns a faint pastel sheen. At
    // higher values it lays a shiny sky reflection over every surface (the rocks
    // especially) and washes the whole scene out.
    scene.environmentIntensity = 0.2;
    envScene.remove(dome);
    pmrem.dispose();
  }

  scene.add(dome);
  return ibl;
}
