// ---------------------------------------------------------------------------
// Sky dome + "from above" sun glow + image-based lighting.
//
// The dome is a big BackSide sphere with a gradient shader: a 3-stop gradient
// (horizon → mid → zenith) plus a horizon haze band. Colours are THREE.Color
// uniforms (sRGB→linear decoded by three's colour management), so their linear
// luminance is what matters against the locked bloom threshold of 0.85 — the
// horizon stop sits just under it, and only the very skyline is meant to bloom.
//
// The false sun. The camera is pinned to a 50–60° polar band, so the top of the
// frame only reaches ~2.5° BELOW the true horizon: every visible sky pixel is at
// or under the horizon, and the real sun (~54° up) is always off the top of the
// frame. That's the whole problem — nothing drawn on the dome can appear ABOVE
// the horizon, so a bright spot there always reads as a sun sitting on the ground
// (the exact note the player gave the old horizon-hugging lobe). So the sun is
// built in two parts:
//   1. A gentle warm hue on the dome's sky sliver, keyed to the true 3-D sun
//      direction so it leans to the sun's side (and warms the IBL a touch). On
//      the near-white, ACES-flattened sliver this is only a whisper — see the
//      glow block in buildDome().
//   2. buildSunShafts() — a fullscreen overlay that paints a soft warm glow
//      spilling DOWN into the frame from the sun's off-screen position above the
//      top edge. This is the part that actually reads as light from above, and
//      it's the only place it CAN come from given the framing.
//
// This module also builds the IBL: a PMREM environment generated once from the
// dome alone (never the shaft overlay), so water, the gold horns and every
// Standard material pick up a pastel-consistent sky reflection. IBL is
// medium/high only.
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { initialPreset, QUALITY } from "./quality";

// The single horizon pink. Fog + scene.background are unified to this so the far
// terrain edge dissolves seamlessly into the skyline (previously three slightly
// different pinks: dome bottom, fog, background).
export const HORIZON_COLOR = 0xffe3ee;

// Mirror of the DirectionalLight in main.ts (position 70,120,50). Kept here as a
// constant so the false-sun glow lines up with the shadow direction without
// coupling the two files.
const SUN_POSITION = new THREE.Vector3(70, 120, 50);

// Scratch vectors for the per-frame sun projection in the shaft overlay.
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function buildDome(): THREE.Mesh {
  // The FULL 3-D sun direction (not just its azimuth). The real sun sits ~54°
  // up — above the 50–60° polar band's ~2.5° ceiling, so it's never in frame —
  // but keying the glow to this direction makes its peak land off-screen ABOVE
  // the top edge, so the visible sky brightens toward the top on the sun side.
  const sunDir = SUN_POSITION.clone().normalize();
  const sunAz = new THREE.Vector2(SUN_POSITION.x, SUN_POSITION.z).normalize();
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
        uSunColor: { value: new THREE.Color(0xffdca0) },
        uSunDir: { value: sunDir },
        uSunAz: { value: sunAz },
        // False-sun tuning (see the glow block below). Deliberately gentle: on the
        // near-white, ACES-flattened sky sliver this only reads as a faint warm
        // hue on the sun side + a touch of directional warmth in the IBL. The
        // legible "from above" cue is the shaft overlay (buildSunShafts), not this.
        uGlowAmt: { value: 0.28 }, // warm-tint strength (mix toward uSunColor)
        uHaloLo: { value: 0.40 }, // sd where the sun's off-screen glow-halo starts
        uHaloHi: { value: 0.70 }, //   …and where it saturates (peak is above frame)
        uAziPow: { value: 3.0 }, // how tightly the lobe hugs the sun's azimuth
        uLift: { value: 0.06 }, // tiny additive brightness at the lobe core
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
        uniform vec3 uSunDir;
        uniform vec2 uSunAz;
        uniform float uGlowAmt;
        uniform float uHaloLo;
        uniform float uHaloHi;
        uniform float uAziPow;
        uniform float uLift;
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

          // False sun — a warm glow that comes from ABOVE. The real sun sits ~54°
          // up, but the 50–60° polar band lets the view climb only to ~horizon,
          // so all we ever see of the sky is a thin sliver at the top of the frame
          // and the sun itself is always above it. So we don't draw a disc — we
          // draw the BOTTOM FRINGE of the sun's glow-halo spilling in over the top
          // edge, on the sun's azimuth. It's built from two directions:
          //
          //   halo — how close the view dir is to the true 3-D sun dir. Its peak
          //          is off-screen above the frame, so the fringe RISES toward the
          //          top edge and is clearly cut off there: light from above.
          //   lobe — how aligned the view is with the sun's compass azimuth, so
          //          the glow is a localised lobe on the sun side, not a warm band
          //          smeared along the whole horizon (which read as a ground sun).
          //
          // Applied as a hue MIX toward warm, not an additive brightening: the sky
          // sliver is already near-white and ACES desaturates highlights, so adding
          // light just washes it whiter — mixing shifts the hue to gold instead, so
          // the warmth actually survives. It also stays a broad, sub-threshold
          // region, so UnrealBloom never smears it into a boxy blob. A whisper of
          // additive lift (glow², so only the lobe core) gives a soft focal point.
          float sd = dot(wdir, uSunDir);
          float halo = smoothstep(uHaloLo, uHaloHi, sd);
          float azi = max(dot(normalize(wdir.xz), uSunAz), 0.0);
          float glow = halo * pow(azi, uAziPow);
          col = mix(col, uSunColor, glow * uGlowAmt);
          col += uSunColor * (glow * glow) * uLift;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
}

// ---------------------------------------------------------------------------
// Sun shafts — the "from above" cue.
//
// Why an overlay and not more sky: the camera's 50–60° polar band means the top
// of the frame only reaches ~2.5° BELOW the true horizon, so every visible sky
// pixel sits at or under the horizon. Nothing drawn on the dome can appear above
// it — a bright spot there is, by construction, a sun on the ground (exactly the
// note the player gave). The real sun is ~54° up, off the top of the frame.
//
// So the light has to enter from OUTSIDE the frame. This is a fullscreen overlay
// (drawn last, additive) that paints a soft warm glow radiating from the sun's
// projected screen position — which, on the sun's azimuth, sits just above the
// top edge. The glow's lower falloff spills DOWN into the frame from the top, so
// it reads as sunlight coming from up-and-to-the-sun-side, lined up with the
// shadows. onBeforeRender reprojects the sun each frame and fades the whole thing
// out as you turn away from it, so it never glows when the sun is behind you.
//
// Restraint: it's a broad, low-amplitude add kept well under the 0.85 bloom
// threshold (a bright broad region is what smears into a boxy bloom blob), the
// gaussian keeps it in the top of the frame so it doesn't wash the matte fore-
// ground, and a faint down-fanning streak gives a hint of god-ray without the
// blown-out look.
// ---------------------------------------------------------------------------
function buildSunShafts(sunDir: THREE.Vector3): THREE.Mesh {
  // Sun compass azimuth (unit, on the ground plane) — the glow tracks THIS as the
  // camera yaws, since the sun is effectively straight up and the only thing that
  // changes on screen is which way its azimuth lies.
  const sunAzX = sunDir.x,
    sunAzZ = sunDir.z;
  const sunAzLen = Math.hypot(sunAzX, sunAzZ) || 1;
  const azX = sunAzX / sunAzLen;
  const azZ = sunAzZ / sunAzLen;

  const uniforms = {
    uSunNdc: { value: new THREE.Vector2(0, 1.4) }, // glow centre, just above the top edge
    uAspect: { value: 1.777 },
    uVisible: { value: 0.0 }, // 0 when facing away from the sun's azimuth
    uColor: { value: new THREE.Color(0xffdca0) },
    uStrength: { value: 0.07 }, // peak additive brightness (linear, sub-threshold)
    uSpread: { value: 1.25 }, // gaussian radius in NDC — how far the glow reaches down
    uStreak: { value: 0.1 }, // faint radial god-ray modulation (0 = pure soft glow)
    uSunLift: { value: 1.4 }, // how far above the top edge the glow centre sits
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec2 vNdc;
      void main() {
        // PlaneGeometry(2,2) spans [-1,1]; emit it straight as clip coords so the
        // quad always fills the screen regardless of the camera.
        vNdc = position.xy;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uSunNdc;
      uniform float uAspect;
      uniform float uVisible;
      uniform vec3 uColor;
      uniform float uStrength;
      uniform float uSpread;
      uniform float uStreak;
      uniform float uSunLift;
      varying vec2 vNdc;

      void main() {
        // Vector from this pixel to the sun's screen point, aspect-corrected so
        // the falloff is round in pixels, not stretched by the wide viewport.
        vec2 dv = vNdc - uSunNdc;
        dv.x *= uAspect;
        float dist = length(dv);

        // Soft gaussian glow centred on the (usually off-screen, above) sun.
        float glow = exp(-(dist * dist) / (2.0 * uSpread * uSpread));

        // Faint god-ray streaks fanning out from the sun. atan gives the angle
        // around the sun point; a few soft lobes read as light shafts. Kept subtle
        // (uStreak small) so it's a hint, not a starburst.
        float ang = atan(dv.y, dv.x);
        float rays = 1.0 + uStreak * (sin(ang * 5.0) * 0.5 + 0.5);

        float inten = glow * rays * uStrength * uVisible;
        // Additive (SrcAlpha·src + dst): rgb = colour, alpha = intensity.
        gl_FragColor = vec4(uColor, inten);
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 999; // draw last, over the whole scene
  mesh.onBeforeRender = (_r, _s, camera) => {
    const cam = camera as THREE.PerspectiveCamera;
    uniforms.uAspect.value = cam.aspect;

    // The sun is effectively straight up, so what matters on screen is the yaw
    // error between where we're looking and the sun's compass azimuth. Build the
    // camera's horizontal forward + right, then read the azimuth off them.
    cam.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.crossVectors(_fwd, _UP).normalize();
    const dotF = _fwd.x * azX + _fwd.z * azZ; // cos(yawErr)
    const dotR = _right.x * azX + _right.z * azZ; // sin(yawErr), signed left/right
    const yawErr = Math.atan2(dotR, dotF);

    // Horizontal glow position: how far the sun's azimuth lies off-centre, in NDC.
    // tan(yawErr)/tan(halfFovH) is the screen-x of a point at that bearing.
    const halfFovV = THREE.MathUtils.degToRad(cam.fov * 0.5);
    const tanH = cam.aspect * Math.tan(halfFovV);
    const ndcX = Math.tan(yawErr) / tanH;
    uniforms.uSunNdc.value.set(
      THREE.MathUtils.clamp(ndcX, -3, 3),
      uniforms.uSunLift.value,
    );

    // Fade out as we turn off the sun's azimuth: full within ~25°, gone by ~60°
    // (dotF < 0 means the sun is behind us, where 1 - smoothstep already reads 0).
    uniforms.uVisible.value = 1 - smoothstep(
      THREE.MathUtils.degToRad(25),
      THREE.MathUtils.degToRad(60),
      Math.abs(yawErr),
    );
  };
  return mesh;
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

  // The "from above" sun glow. Added to the real scene only (never the envScene
  // above), so it paints the view without leaking into the IBL reflection.
  const shafts = buildSunShafts(SUN_POSITION.clone().normalize());
  scene.add(shafts);

  return ibl;
}
