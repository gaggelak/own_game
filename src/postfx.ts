// ---------------------------------------------------------------------------
// Post-processing chain + quality wiring, all behind one small handle so main.ts
// only ever sees createPostFX / render / update / resize.
//
// Pass order (one composer; presets just flip .enabled):
//
//   RenderPass → [GTAO] → [SMAA] → UnrealBloom → OutputPass → [FXAA] → [Grade]
//     beauty      AO       AA        UNCHANGED    ACES+sRGB    AA       look
//     (linear HDR ..............................)(display sRGB ...............)
//
// The bloom + output pair is byte-identical to the original inline chain, so
// with every optional pass disabled (the `low` preset) the image is a pixel
// match for the pre-uplift build — that's the regression anchor. Every emissive
// in the game is tuned against UnrealBloom(0.6/0.5/0.85); those numbers never
// move here.
//
// GTAO is native three (GTAOPass). We deliberately did NOT take the n8ao package:
// its bundle hard-imports pmndrs `postprocessing` at module top level, which
// would drag that whole library in just to reach the vanilla pass. GTAO re-renders
// the scene into a normal buffer, so it's the pricey pass — it runs at half-res
// and only on `high`.
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import {
  createQualityManager,
  QUALITY,
  type QualityManager,
  type QualityPreset,
} from "./quality";
import { setGrassViewDistance } from "./flora";

// Half-resolution AO: the normal G-buffer + AO math run at a quarter of the
// pixels, then upsample onto the full-res beauty during the blend. Invisible on
// this stylised low-poly art, ~2-3× cheaper.
const AO_SCALE = 0.5;

// ---------------------------------------------------------------------------
// GradePass: the one custom fullscreen pass. Runs LAST, on the display-referred
// sRGB image (after OutputPass), so vignette/saturation behave perceptually and
// the chromatic-aberration fringe lands on the final frame. Every uniform
// defaults to a no-op, so an enabled-but-idle GradePass is a pass-through.
// ---------------------------------------------------------------------------
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCA: { value: 0.0 }, // radial chromatic aberration amount
    uVignette: { value: 0.0 }, // edge darkening 0..~0.4
    uSaturation: { value: 1.0 }, // 1 = neutral, <1 desaturates
    uTiltShift: { value: 0.0 }, // 0 = sharp everywhere (medium), 1 = on (high)
    uFocus: { value: 0.58 }, // tilt-shift focus band centre in uv.y
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uCA;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uTiltShift;
    uniform float uFocus;
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;
      vec2 dir = uv - 0.5;

      // Tilt-shift: rows outside the focus band pick up a small cross blur. The
      // blur taps collapse to the centre when uTiltShift is 0, so medium (and the
      // focus band itself) stays pixel-sharp.
      float ts = uTiltShift * clamp(abs(uv.y - uFocus) * 2.4 - 0.12, 0.0, 1.0);
      vec2 bpx = (ts * 2.5) / uResolution;

      // Chromatic aberration: split R/B along the radial direction, growing to
      // the edges. Zero uCA is an exact no-op.
      vec2 ca = dir * uCA;

      vec3 c0 = texture2D(tDiffuse, uv).rgb;
      float r  = texture2D(tDiffuse, uv + ca + vec2(bpx.x, 0.0)).r;
      float r2 = texture2D(tDiffuse, uv + ca - vec2(bpx.x, 0.0)).r;
      float g1 = texture2D(tDiffuse, uv + vec2(0.0, bpx.y)).g;
      float g2 = texture2D(tDiffuse, uv - vec2(0.0, bpx.y)).g;
      float b  = texture2D(tDiffuse, uv - ca + vec2(bpx.x, 0.0)).b;
      float b2 = texture2D(tDiffuse, uv - ca - vec2(bpx.x, 0.0)).b;
      vec3 col = vec3((r + r2) * 0.5, (g1 + g2 + c0.g) / 3.0, (b + b2) * 0.5);

      // Soft vignette (multiplicative). uVignette 0 → untouched.
      float vig = 1.0 - uVignette * smoothstep(0.35, 0.85, length(dir));
      col *= vig;

      // Saturation / vibrance around luma.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export interface PostFX {
  /** Draw the composed frame (replaces composer.render()). */
  render(): void;
  /** One warm render so newly-enabled pass programs link off the hot path. */
  warm(): void;
  /**
   * Per-frame grade/desat drive + auto-detect sampling.
   * @param dtReal   real (unscaled) frame delta in seconds
   * @param hitstop01 1 while the world is frozen mid-hitstop, else 0
   * @param comboMult current chain multiplier (1..20)
   */
  update(dtReal: number, hitstop01: number, comboMult: number): void;
  /** Kick a chromatic-aberration + vignette pulse (strength already 0.3..1). */
  pulse(strength: number): void;
  resize(width: number, height: number): void;
  readonly composer: EffectComposer;
  readonly quality: QualityManager;
  readonly passes: {
    render: RenderPass;
    ao: GTAOPass | null;
    smaa: SMAAPass;
    bloom: UnrealBloomPass;
    output: OutputPass;
    fxaa: FXAAPass;
    grade: ShaderPass;
  };
  /** Rolling frame-time readout for perf checks in the dev console. */
  stats(): { p50: number; p75: number; n: number };
}

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  sun: THREE.DirectionalLight,
): PostFX {
  let width = window.innerWidth;
  let height = window.innerHeight;

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(width, height);

  const renderPass = new RenderPass(scene, camera);
  const smaa = new SMAAPass();
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    0.6, // strength — LOCKED
    0.5, // radius — LOCKED
    0.85, // threshold — LOCKED
  );
  const output = new OutputPass();
  const fxaa = new FXAAPass();
  const grade = new ShaderPass(GradeShader);
  const gradeU = (grade.material as THREE.ShaderMaterial).uniforms;

  // Base chain (no AO yet — GTAO is inserted lazily at index 1 on first enable).
  composer.addPass(renderPass);
  composer.addPass(smaa);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.addPass(fxaa);
  composer.addPass(grade);

  // Everything optional starts disabled; the quality apply() below turns on
  // whatever the active preset wants.
  smaa.enabled = false;
  fxaa.enabled = false;
  grade.enabled = false;

  let gtao: GTAOPass | null = null;

  function effSize(): { w: number; h: number } {
    const pr = renderer.getPixelRatio();
    return { w: Math.max(1, Math.round(width * pr)), h: Math.max(1, Math.round(height * pr)) };
  }

  function sizeGtao(): void {
    if (!gtao) return;
    const { w, h } = effSize();
    gtao.setSize(Math.max(1, Math.round(w * AO_SCALE)), Math.max(1, Math.round(h * AO_SCALE)));
  }

  function ensureGtao(): GTAOPass {
    if (gtao) return gtao;
    const { w, h } = effSize();
    gtao = new GTAOPass(scene, camera, Math.round(w * AO_SCALE), Math.round(h * AO_SCALE));
    gtao.output = 0; // GTAOPass.OUTPUT.Default — blend AO onto the beauty
    gtao.blendIntensity = 1.0;
    gtao.updateGtaoMaterial({
      radius: 2.0, // world-space contact-shadow reach (unicorn / trunk scale)
      distanceExponent: 1.0,
      thickness: 1.0,
      scale: 1.0,
      samples: 16,
      screenSpaceRadius: false,
    });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 12, rings: 2, samples: 8 });
    composer.insertPass(gtao, 1); // right after RenderPass, before SMAA/bloom
    return gtao;
  }

  // --- Grade / cinematic drive state -------------------------------------
  const CA_TAU = 0.08;
  const VIG_TAU = 0.12;
  const VIG_BASE = 0.12;
  let caPulse = 0;
  let vigPulse = 0;
  let comboSmooth = 0;
  let sat = 1;

  function pulse(strength: number): void {
    const s = Math.min(1, Math.max(0, strength));
    caPulse = Math.max(caPulse, s);
    vigPulse = Math.max(vigPulse, s);
  }

  // --- Frame-time stats --------------------------------------------------
  const STAT_CAP = 120;
  const statRing = new Float32Array(STAT_CAP);
  let statHead = 0;
  let statCount = 0;

  // --- Quality apply -----------------------------------------------------
  function apply(preset: QualityPreset, boot: boolean): void {
    // Read straight off the preset table: the quality manager (which owns
    // `current`) calls this synchronously during its own construction, before
    // the `quality` const below is assigned, so we can't ask it for knobs here.
    const knobs = QUALITY[preset];

    // pixelRatio — the biggest lever. Re-assert size so the drawing buffer and
    // composer RTs match the new ratio.
    const pr = Math.min(window.devicePixelRatio, knobs.pixelRatioCap);
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height);
    composer.setPixelRatio(pr);
    composer.setSize(width, height);

    // Shadow map resolution — hot-swappable (dispose + realloc). main.ts's
    // updateShadow() recomputes its texel snap from mapSize each frame, so this
    // needs no coupling.
    if (sun.shadow.mapSize.x !== knobs.shadowMapSize) {
      sun.shadow.mapSize.set(knobs.shadowMapSize, knobs.shadowMapSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    // Shadow FILTER type only at boot — changing it later recompiles every
    // material (a big hitch). The toast warns when a live switch needs a reload.
    if (boot) {
      renderer.shadowMap.type = knobs.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    }

    // AA (never both).
    smaa.enabled = knobs.aa === "smaa";
    fxaa.enabled = knobs.aa === "fxaa";

    // AO (high only) — lazily built the first time it's wanted.
    if (knobs.ao) {
      ensureGtao().enabled = true;
    } else if (gtao) {
      gtao.enabled = false;
    }

    // Grade + tilt-shift.
    grade.enabled = knobs.grade;
    gradeU.uTiltShift.value = knobs.tiltShift ? 1 : 0;

    // Grass draw distance (hot). Count/IBL/water/wind are boot-only and read at
    // their own construction sites from initialPreset().
    setGrassViewDistance(knobs.grassViewDist);

    sizeGtao();
    updateGradeResolution();

    // A runtime switch that turned a pass on needs its program linked before the
    // next visible frame, or it hitches. Boot is warmed separately in main.ts.
    if (!boot) warm();
  }

  function updateGradeResolution(): void {
    const { w, h } = effSize();
    gradeU.uResolution.value.set(w, h);
    fxaa.setSize(w, h); // FXAAPass keys its edge search off this resolution
  }

  // Build the manager last so `apply` can reference it; it calls apply(boot=true)
  // synchronously during construction.
  const quality: QualityManager = createQualityManager(apply);

  function render(): void {
    composer.render();
  }

  function warm(): void {
    composer.render();
  }

  function update(dtReal: number, hitstop01: number, comboMult: number): void {
    // Feed the auto-detector (it self-gates on visibility + sane dt).
    quality.sampleFrame(dtReal);

    // Rolling frame-time stats (ms).
    statRing[statHead] = dtReal * 1000;
    statHead = (statHead + 1) % STAT_CAP;
    if (statCount < STAT_CAP) statCount++;

    if (!grade.enabled) return; // nothing to drive when the grade pass is off

    const dt = Math.min(dtReal, 0.1);
    // Combo → smoothed 0..1.
    const comboT = Math.min(1, Math.max(0, (comboMult - 1) / 19));
    comboSmooth += (comboT - comboSmooth) * Math.min(1, dt * 2);
    // Pulses decay exponentially.
    caPulse *= Math.exp(-dt / CA_TAU);
    vigPulse *= Math.exp(-dt / VIG_TAU);
    // Saturation: hitstop instantly drains colour; combo adds vibrance; ease
    // back over ~0.15s when the freeze releases.
    const satTarget = hitstop01 > 0.5 ? 0.55 : 1 + 0.12 * comboSmooth;
    const satRate = hitstop01 > 0.5 ? 1 : Math.min(1, dt / 0.15);
    sat += (satTarget - sat) * satRate;

    gradeU.uCA.value = caPulse * 0.006 + comboSmooth * 0.0015;
    gradeU.uVignette.value = VIG_BASE + vigPulse * 0.16;
    gradeU.uSaturation.value = sat;
  }

  function resize(w: number, h: number): void {
    width = w;
    height = h;
    renderer.setSize(w, h);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    sizeGtao();
    updateGradeResolution();
  }

  function stats(): { p50: number; p75: number; n: number } {
    if (statCount === 0) return { p50: 0, p75: 0, n: 0 };
    const arr = Array.from(statRing.subarray(0, statCount)).sort((a, b) => a - b);
    const at = (p: number) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))];
    return { p50: at(0.5), p75: at(0.75), n: statCount };
  }

  return {
    render,
    warm,
    update,
    pulse,
    resize,
    composer,
    quality,
    passes: {
      render: renderPass,
      get ao() {
        return gtao;
      },
      smaa,
      bloom,
      output,
      fxaa,
      grade,
    },
    stats,
  };
}
