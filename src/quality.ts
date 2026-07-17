// ---------------------------------------------------------------------------
// Quality presets: one place that decides how pretty vs how cheap the frame is.
//
// Three tiers. `low` is byte-for-byte today's pipeline (the regression anchor):
// no AA, no AO, no colour grade, 1024 shadows, 30k grass, pixelRatio 1.0. `high`
// is everything on. `medium` (the default) is the sweet spot — it deliberately
// skips ambient occlusion, because GTAO re-renders the whole scene into a normal
// buffer and that extra geometry pass is too expensive to guarantee 60fps with
// ~100 skinned unicorns on a mid GPU. AO is a high-only luxury.
//
// This module is a leaf: it imports nothing from the game, so flora/postfx/sky
// can all read the knob table without an import cycle. It owns preset
// persistence, the G-hotkey, the little toast, and the one-shot auto-detector.
// ---------------------------------------------------------------------------

export type QualityPreset = "low" | "medium" | "high";

export interface QualityKnobs {
  /** devicePixelRatio is capped at this — the single biggest fill-rate lever. */
  pixelRatioCap: number;
  /** Anti-aliasing: FXAA (cheap, post-tonemap) or SMAA (sharper, pre-bloom). */
  aa: "none" | "fxaa" | "smaa";
  /** GTAO ambient occlusion (high only — the normal G-buffer pass is costly). */
  ao: boolean;
  /** Directional-light shadow map resolution. */
  shadowMapSize: number;
  /** PCFSoftShadowMap instead of PCFShadowMap — boot-only (runtime change would
   *  recompile every material), so cycling presets live never flips this. */
  shadowSoft: boolean;
  /** Grass blade instances scattered at startup (boot-only). */
  grassCount: number;
  /** Grass chunk view distance (hot-swappable via setGrassViewDistance). */
  grassViewDist: number;
  /** Image-based lighting from the sky dome → scene.environment (boot-only). */
  ibl: boolean;
  /** Water gets fresnel + foam + depth tint (boot-only, baked into the shader). */
  waterExtra: boolean;
  /** Water also gets the extra normal octave + bloom sparkle glints. */
  waterSparkle: boolean;
  /** The colour-grade / vignette / chromatic-aberration final pass. */
  grade: boolean;
  /** Subtle tilt-shift focus band in the grade pass (high only). */
  tiltShift: boolean;
  /** Wind sway on flowers + bushes (boot-only, cloned materials). */
  windProps: boolean;
  /** Wind sway on tree canopies (boot-only, leaf materials only). */
  windLeaves: boolean;
  /** Pollen motes + a fuller butterfly count (boot-only). */
  ambienceRich: boolean;
}

export const QUALITY: Record<QualityPreset, QualityKnobs> = {
  low: {
    pixelRatioCap: 1.0,
    aa: "none",
    ao: false,
    shadowMapSize: 1024,
    shadowSoft: false,
    grassCount: 30000,
    grassViewDist: 130,
    ibl: false,
    waterExtra: false,
    waterSparkle: false,
    grade: false,
    tiltShift: false,
    windProps: false,
    windLeaves: false,
    ambienceRich: false,
  },
  medium: {
    pixelRatioCap: 1.5,
    aa: "fxaa",
    ao: false,
    shadowMapSize: 2048,
    shadowSoft: false,
    grassCount: 70000,
    grassViewDist: 170,
    ibl: true,
    waterExtra: true,
    waterSparkle: false,
    grade: true,
    tiltShift: false,
    windProps: true,
    windLeaves: false,
    ambienceRich: false,
  },
  high: {
    pixelRatioCap: 1.5,
    aa: "smaa",
    ao: true,
    shadowMapSize: 2048,
    shadowSoft: true,
    grassCount: 70000,
    grassViewDist: 170,
    ibl: true,
    waterExtra: true,
    waterSparkle: true,
    grade: true,
    tiltShift: true,
    windProps: true,
    windLeaves: true,
    ambienceRich: true,
  },
};

const ORDER: QualityPreset[] = ["low", "medium", "high"];
const STORAGE_KEY = "unicornMeadow.quality.v1";

interface StoredQuality {
  preset: QualityPreset;
  source: "auto" | "manual";
}

function readStored(): StoredQuality | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredQuality>;
    if (parsed.preset && ORDER.includes(parsed.preset)) {
      return { preset: parsed.preset, source: parsed.source === "manual" ? "manual" : "auto" };
    }
  } catch {
    // Corrupt/blocked storage → fall back to defaults, never throw at boot.
  }
  return null;
}

function writeStored(value: StoredQuality): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Private-mode / disabled storage: preset just won't persist. Not fatal.
  }
}

/**
 * The preset to build the scene with, read synchronously at import/startup time.
 * Boot-only knobs (grass count, IBL, water/wind/ambience detail, shadow filter)
 * are read from `QUALITY[initialPreset()]` at their construction sites.
 */
export function initialPreset(): QualityPreset {
  return readStored()?.preset ?? "medium";
}

export interface QualityManager {
  preset(): QualityPreset;
  knobs(): QualityKnobs;
  /** Apply a preset explicitly (persists with the given source). */
  set(preset: QualityPreset, source: "auto" | "manual"): void;
  /** Cycle low → medium → high → low (a manual user action). */
  cycle(): void;
  /** Feed one real-time frame delta (seconds) to the auto-detector. */
  sampleFrame(dtReal: number): void;
  dispose(): void;
}

// Auto-detect tuning. Sample only sane, visible frames; skip warm-up; decide
// once off the 75th-percentile frame time, then disarm so it never oscillates.
const WARMUP_FRAMES = 60;
const SAMPLE_TARGET = 120;
const MAX_SANE_DT = 0.09; // main clamps dt to 0.1; anything near it is a tab-return hitch
const STEP_DOWN_MS = 20; // p75 slower than this → drop a tier (missing 50fps)
const STEP_UP_MS = 10; // p75 faster than this → the GPU has headroom, add a tier

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor(p * (sortedMs.length - 1)));
  return sortedMs[idx];
}

/**
 * Build the quality manager. `apply(preset, boot)` does the actual work of
 * pushing the hot-swappable knobs (pixelRatio, passes, shadow map) into the
 * renderer; `boot` is true only for the first application (when the shadow
 * filter type may still be changed before shaders compile).
 */
export function createQualityManager(
  apply: (preset: QualityPreset, boot: boolean) => void,
): QualityManager {
  const stored = readStored();
  let current: QualityPreset = stored?.preset ?? "medium";
  let bootSoft = QUALITY[current].shadowSoft; // the shadow filter compiled at boot

  // Boot application — silent, no toast.
  apply(current, true);

  // Arm the auto-detector unless the player has made a manual choice before.
  let armed = stored?.source !== "manual";
  let warmupLeft = WARMUP_FRAMES;
  const samples: number[] = [];

  // --- Toast -------------------------------------------------------------
  let toast: HTMLDivElement | null = null;
  let toastTimer = 0;
  function showToast(text: string): void {
    if (!toast) {
      toast = document.createElement("div");
      toast.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:32px",
        "transform:translateX(-50%)",
        "padding:10px 18px",
        "border-radius:999px",
        "background:rgba(24,16,32,0.82)",
        "color:#ffe9f6",
        "font:600 14px/1.2 system-ui,sans-serif",
        "letter-spacing:0.02em",
        "box-shadow:0 4px 18px rgba(0,0,0,0.35)",
        "pointer-events:none",
        "z-index:9999",
        "opacity:0",
        "transition:opacity 0.25s ease",
      ].join(";");
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = "1";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      if (toast) toast.style.opacity = "0";
    }, 1500);
  }

  function label(preset: QualityPreset): string {
    const name = preset.charAt(0).toUpperCase() + preset.slice(1);
    // Warn when the live change can't fully take hold until a reload.
    const needsReload = QUALITY[preset].shadowSoft !== bootSoft;
    return needsReload ? `Graphics: ${name} (soft shadows after reload)` : `Graphics: ${name}`;
  }

  function set(preset: QualityPreset, source: "auto" | "manual"): void {
    current = preset;
    writeStored({ preset, source });
    if (source === "manual") armed = false;
    apply(preset, false);
    showToast(label(preset));
  }

  function cycle(): void {
    const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
    set(next, "manual");
  }

  // --- Hotkey ------------------------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "g" || e.key === "G") cycle();
  }
  window.addEventListener("keydown", onKey);

  // --- Auto-detect sampler ----------------------------------------------
  function sampleFrame(dtReal: number): void {
    if (!armed) return;
    if (document.visibilityState !== "visible" || dtReal >= MAX_SANE_DT) return;
    if (warmupLeft > 0) {
      warmupLeft--;
      return;
    }
    samples.push(dtReal * 1000);
    if (samples.length < SAMPLE_TARGET) return;

    armed = false; // decide exactly once
    const sorted = samples.slice().sort((a, b) => a - b);
    const p75 = percentile(sorted, 0.75);
    const i = ORDER.indexOf(current);
    if (p75 > STEP_DOWN_MS && i > 0) {
      set(ORDER[i - 1], "auto");
    } else if (p75 < STEP_UP_MS && i < ORDER.length - 1) {
      set(ORDER[i + 1], "auto");
    } else {
      // Stay put but persist as an auto choice so next boot re-samples cleanly.
      writeStored({ preset: current, source: "auto" });
    }
  }

  return {
    preset: () => current,
    knobs: () => QUALITY[current],
    set,
    cycle,
    sampleFrame,
    dispose() {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(toastTimer);
      if (toast) toast.remove();
    },
  };
}
