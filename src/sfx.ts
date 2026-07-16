// ---------------------------------------------------------------------------
// One-shot impact SFX via the Web Audio API: overlapping playback, pitch/volume
// scaled by blast size (bigger craters hit deeper + louder).
//
//   GENERAL  → a random boom; plays on every impact (never the same twice running)
//   BLOOD    → wet splat/squish one-shots (CC0, opengameart.org). When a meteor
//              kills a unicorn, a splat is layered UNDER a general boom so the
//              kill reads as BOOM + SQUISH at once.
//   LORDSONNY → a cinematic clip that already bakes in its own explosion + gore.
//              Layering a boom under it would double-boom, so it plays solo as an
//              occasional kill variant instead of joining the boom + splat layer.
//
// Kept separate from the looping background music (audio.ts, HTMLAudio): Web
// Audio is the right tool for short overlapping one-shots with variation.
// ---------------------------------------------------------------------------

const GENERAL_URLS = [
  "/sfx/impact-1.mp3",
  "/sfx/impact-2.mp3",
  "/sfx/impact-4.mp3",
  "/sfx/impact-5.mp3",
  "/sfx/impact-6.mp3",
  "/sfx/impact-7.mp3",
];
const BLOOD_URLS = [
  "/sfx/blood-1.flac",
  "/sfx/blood-2.flac",
  "/sfx/blood-3.flac",
  "/sfx/blood-4.flac",
  "/sfx/blood-5.flac",
  "/sfx/blood-6.flac",
  "/sfx/blood-7.flac",
  "/sfx/blood-8.flac",
];
// lordsonny — a self-contained explosion + gore clip. Played solo (never layered
// under a boom, or it double-booms) as an occasional kill variant; see explosion().
const LORDSONNY_URL = "/sfx/impact-3.mp3";
const LORDSONNY_CHANCE = 0.22;

// Water-ball impact layers — real CC0 samples (opengameart.org), so the hit lands
// with a real splash + electric zap like the meteor's boom, not a synth tone. The
// synthesized crackle/splash below remain as fallbacks if these fail to load.
const ELECTRIC_URLS = ["/sfx/electric-spark.wav"]; // zap on impact
const WATER_URLS = ["/sfx/water-1.wav", "/sfx/water-2.wav"]; // splash on impact
// Looping spark, played softly while a unicorn stands electrified (CC0).
const CONTINUOUS_ELECTRIC_URL = "/sfx/electric-continuous.wav";
// Panicked horse neighs played when the water ball electrocutes a unicorn.
// Real recordings from Wikimedia Commons: Wiehern.ogg (public domain) + two
// stallion calls from PLOS ONE doi:10.1371/journal.pone.0118468 (CC BY).
const SCREAM_URLS = [
  "/sfx/horse-scream-1.ogg",
  "/sfx/horse-scream-2.ogg",
  "/sfx/horse-scream-3.ogg",
];

// Major pentatonic (semitones): every note lands consonant, so an arpeggio of
// any length reads as "triumph" without arranging one per kill tier.
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export interface Sfx {
  /** Resume the AudioContext + kick off decoding. Call from a user gesture. */
  unlock(): void;
  /** Play an impact, scaled by blast radius (~8 small … ~22 huge). Pass
   *  gore=true when a unicorn was killed to draw from the blood pool. */
  explosion(radius: number, gore?: boolean): void;
  /** Electric water-ball impact: real electric + water samples when loaded,
   *  falling back to a synthesized zap. kill=true adds a brighter sizzle. */
  electro(radius: number, kill?: boolean): void;
  /** Panicked horse scream(s) when a unicorn is electrocuted (count = how many
   *  were hit; capped so a big blast doesn't stack a wall of screams). */
  scream(count: number): void;
  /** Drive the soft looping spark heard while unicorns stand electrified. Call
   *  every frame with how many are currently electrified (0 stops the loop). */
  electrifyLoop(count: number): void;
  /** Rising arpeggio for a multi-kill; tier 1..7 adds notes + pitch. */
  killFanfare(tier: number): void;
  /** "Ka-ching" when a combo chain banks; pitch rises mildly with the mult. */
  chainBank(mult: number): void;
  /** Major fanfare when a level is wiped out. */
  levelClear(): void;
  /** One blip per second over the last few seconds of a level. */
  countdownTick(): void;
  /** Descending sting when the clock runs out. */
  timeUp(): void;
  setMuted(muted: boolean): void;
}

export function createSfx(): Sfx {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  const general: (AudioBuffer | null)[] = GENERAL_URLS.map(() => null);
  const blood: (AudioBuffer | null)[] = BLOOD_URLS.map(() => null);
  const electric: (AudioBuffer | null)[] = ELECTRIC_URLS.map(() => null);
  const water: (AudioBuffer | null)[] = WATER_URLS.map(() => null);
  const scream: (AudioBuffer | null)[] = SCREAM_URLS.map(() => null);
  let lordsonny: AudioBuffer | null = null;
  let muted = false;
  let lastGeneral = -1;
  let lastBlood = -1;
  let lastElectric = -1;
  let lastWater = -1;
  let lastScream = -1;
  let noiseBuf: AudioBuffer | null = null; // 1s of white noise for synthesized zaps
  let continuousElectric: AudioBuffer | null = null; // looped while unicorns are electrified
  let loopSrc: AudioBufferSourceNode | null = null;
  let loopGain: GainNode | null = null;

  function load(url: string, set: (b: AudioBuffer) => void): void {
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx!.decodeAudioData(b))
      .then(set)
      .catch(() => { /* leave null — playback just skips it */ });
  }

  function ensureCtx(): AudioContext {
    if (ctx) return ctx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    master.connect(ctx.destination);
    // White-noise buffer for the synthesized electric crackle (no asset needed).
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    GENERAL_URLS.forEach((url, i) => load(url, (b) => { general[i] = b; }));
    BLOOD_URLS.forEach((url, i) => load(url, (b) => { blood[i] = b; }));
    ELECTRIC_URLS.forEach((url, i) => load(url, (b) => { electric[i] = b; }));
    WATER_URLS.forEach((url, i) => load(url, (b) => { water[i] = b; }));
    SCREAM_URLS.forEach((url, i) => load(url, (b) => { scream[i] = b; }));
    load(CONTINUOUS_ELECTRIC_URL, (b) => { continuousElectric = b; });
    load(LORDSONNY_URL, (b) => { lordsonny = b; });
    return ctx;
  }

  function play(buffer: AudioBuffer, radius: number): void {
    const c = ctx!;
    const t = Math.min(Math.max((radius - 8) / 14, 0), 1); // 0 small … 1 huge
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = (1.12 - t * 0.28) * (0.95 + Math.random() * 0.1);
    const g = c.createGain();
    g.gain.value = 0.45 + t * 0.5;
    src.connect(g);
    g.connect(master!);
    src.start();
  }

  // Play a random ready clip from `pool`, avoiding an immediate repeat. Returns
  // the chosen index (or `last` unchanged if nothing has decoded yet).
  function playFrom(pool: (AudioBuffer | null)[], last: number, radius: number): number {
    const ready: number[] = [];
    for (let i = 0; i < pool.length; i++) if (pool[i]) ready.push(i);
    if (ready.length === 0) return last;
    let idx = ready[Math.floor(Math.random() * ready.length)];
    if (ready.length > 1 && idx === last) idx = ready[(ready.indexOf(idx) + 1) % ready.length];
    play(pool[idx]!, radius);
    return idx;
  }

  // Synthesized watery splash (white noise through a closing low-pass) — the
  // "water" half of the water ball, layered under the electric crackle.
  function synthSplash(radius: number): void {
    const c = ctx;
    if (!c || !master || !noiseBuf) return;
    const now = c.currentTime;
    const t = Math.min(Math.max((radius - 8) / 14, 0), 1);
    const vol = 0.3 + t * 0.3;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1800, now);
    lp.frequency.exponentialRampToValueAtTime(350, now + 0.22);
    lp.Q.value = 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    src.connect(lp); lp.connect(g); g.connect(master);
    src.start(now); src.stop(now + 0.32);
  }

  // The stingers below are pure synthesis (no assets): the score layer needs a
  // sound per kill tier, and authoring 7 fanfares as files would be silly when
  // an arpeggio is a for-loop. They all route through `master`, so M still mutes.
  // Returns the live context + master, or null before audio has been unlocked.
  function stingerCtx(): { c: AudioContext; m: GainNode } | null {
    const c = ensureCtx();
    if (c.state === "suspended") c.resume().catch(() => { /* ignore */ });
    return master ? { c, m: master } : null;
  }

  // One plucked note: a triangle body with a quiet square on top for bite.
  function pluck(c: AudioContext, m: GainNode, freq: number, at: number, vol: number, dur: number): void {
    for (const [type, mix] of [["triangle", 1], ["square", 0.25]] as const) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, at);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol * mix, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g);
      g.connect(m);
      o.start(at);
      o.stop(at + dur + 0.02);
    }
  }

  return {
    unlock() {
      const c = ensureCtx();
      if (c.state === "suspended") c.resume().catch(() => { /* ignore */ });
    },
    explosion(radius: number, gore = false) {
      const c = ensureCtx();
      if (c.state === "suspended") c.resume().catch(() => { /* ignore */ });
      if (gore) {
        // Occasionally let the self-contained explosion + gore clip play on its own.
        if (lordsonny && Math.random() < LORDSONNY_CHANCE) {
          play(lordsonny, radius);
          return;
        }
        // Otherwise a kill = BOOM + SQUISH: a general boom and a wet splat at once.
        // (playFrom no-ops on a pool that hasn't decoded yet, so either layer can
        // be missing without breaking the other.)
        lastGeneral = playFrom(general, lastGeneral, radius);
        lastBlood = playFrom(blood, lastBlood, radius);
        return;
      }
      lastGeneral = playFrom(general, lastGeneral, radius);
    },
    electro(radius: number, kill = false) {
      const c = ensureCtx();
      if (c.state === "suspended") c.resume().catch(() => { /* ignore */ });
      if (!master) return;

      // Prefer a real electric sample; fall back to the synthesized zap if none
      // have decoded yet (or none were provided).
      if (electric.some(Boolean)) {
        lastElectric = playFrom(electric, lastElectric, radius);
      } else {
        const now = c.currentTime;
        const t = Math.min(Math.max((radius - 8) / 14, 0), 1); // 0 small … 1 huge
        const vol = 0.4 + t * 0.4;
        // crackle: white noise through a bandpass that sweeps downward
        if (noiseBuf) {
          const src = c.createBufferSource();
          src.buffer = noiseBuf;
          const bp = c.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.setValueAtTime(2600, now);
          bp.frequency.exponentialRampToValueAtTime(700, now + 0.25);
          bp.Q.value = 6;
          const g = c.createGain();
          g.gain.setValueAtTime(0.0001, now);
          g.gain.exponentialRampToValueAtTime(vol, now + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
          src.connect(bp); bp.connect(g); g.connect(master);
          src.start(now); src.stop(now + 0.3);
        }
        // zap body: two detuned saws diving in pitch
        for (let i = 0; i < 2; i++) {
          const o = c.createOscillator();
          o.type = "sawtooth";
          o.frequency.setValueAtTime(760 + i * 90, now);
          o.frequency.exponentialRampToValueAtTime(110 - t * 30, now + 0.18);
          const g = c.createGain();
          g.gain.setValueAtTime(0.0001, now);
          g.gain.exponentialRampToValueAtTime(vol * 0.5, now + 0.008);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
          o.connect(g); g.connect(master);
          o.start(now); o.stop(now + 0.22);
        }
        // kill: an extra bright high sizzle on top
        if (kill && noiseBuf) {
          const src = c.createBufferSource();
          src.buffer = noiseBuf;
          const hp = c.createBiquadFilter();
          hp.type = "highpass"; hp.frequency.value = 3500;
          const g = c.createGain();
          g.gain.setValueAtTime(0.0001, now);
          g.gain.exponentialRampToValueAtTime(vol * 0.6, now + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
          src.connect(hp); hp.connect(g); g.connect(master);
          src.start(now); src.stop(now + 0.5);
        }
      }

      // Layer the "water" of the water ball: a real splash sample if one is
      // loaded, otherwise the synthesized splash.
      if (water.some(Boolean)) lastWater = playFrom(water, lastWater, radius);
      else synthSplash(radius);
    },
    scream(count: number) {
      const c = ensureCtx();
      if (c.state === "suspended") c.resume().catch(() => { /* ignore */ });
      if (!master || !scream.some(Boolean)) return;
      const n = Math.min(Math.max(count, 1), 2); // up to two overlapping screams
      for (let i = 0; i < n; i++) lastScream = playFrom(scream, lastScream, 13);
    },
    electrifyLoop(count: number) {
      if (!ctx || !master) return; // only runs during play, after audio is unlocked
      if (count > 0) {
        if (!continuousElectric) return; // not decoded yet
        if (!loopSrc) {
          loopSrc = ctx.createBufferSource();
          loopSrc.buffer = continuousElectric;
          loopSrc.loop = true;
          loopGain = ctx.createGain();
          loopGain.gain.value = 0;
          loopSrc.connect(loopGain);
          loopGain.connect(master);
          loopSrc.start();
        }
        // A touch louder with more unicorns crackling at once.
        if (loopGain) loopGain.gain.value = Math.min(0.14 + count * 0.05, 0.4);
      } else if (loopSrc) {
        try { loopSrc.stop(); } catch { /* already stopped */ }
        loopSrc.disconnect();
        loopGain?.disconnect();
        loopSrc = null;
        loopGain = null;
      }
    },
    killFanfare(tier: number) {
      const s = stingerCtx();
      if (!s) return;
      const { c, m } = s;
      const now = c.currentTime;
      const t = Math.min(Math.max(Math.round(tier), 1), 7);
      const notes = 2 + t; // DOUBLE KILL = 3 notes … EXTINCTION EVENT = 9
      const root = 523.25 * Math.pow(2, ((t - 1) * 2) / 12); // +2 semitones per tier
      const vol = 0.1 + t * 0.022;
      for (let i = 0; i < notes; i++) {
        const at = now + i * 0.055;
        pluck(c, m, root * Math.pow(2, PENTA[Math.min(i, PENTA.length - 1)] / 12), at, vol, 0.16);
      }
      // The big tiers get a rising noise swoosh under the run.
      if (t >= 4 && noiseBuf) {
        const src = c.createBufferSource();
        src.buffer = noiseBuf;
        const bp = c.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 1.6;
        bp.frequency.setValueAtTime(500, now);
        bp.frequency.exponentialRampToValueAtTime(6000, now + notes * 0.055);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.05 + t * 0.012, now + notes * 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, now + notes * 0.055 + 0.25);
        src.connect(bp);
        bp.connect(g);
        g.connect(m);
        src.start(now);
        src.stop(now + notes * 0.055 + 0.3);
      }
    },
    chainBank(mult: number) {
      const s = stingerCtx();
      if (!s) return;
      const { c, m } = s;
      const now = c.currentTime;
      const k = Math.min(Math.max((mult - 1) / 6, 0), 1);
      const base = 1318.5 * (1 + k * 0.25); // fatter chain → brighter register
      // "ka-" then "-ching": a short dyad, then a ringing one an octave up.
      pluck(c, m, base, now, 0.16, 0.09);
      pluck(c, m, base * 1.5, now, 0.16, 0.09);
      pluck(c, m, base * 2, now + 0.085, 0.2, 0.5);
      pluck(c, m, base * 3, now + 0.085, 0.14, 0.5);
      if (noiseBuf) {
        // The mechanical clack of the drawer.
        const src = c.createBufferSource();
        src.buffer = noiseBuf;
        const hp = c.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 5000;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.12, now + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
        src.connect(hp);
        hp.connect(g);
        g.connect(m);
        src.start(now);
        src.stop(now + 0.06);
      }
    },
    levelClear() {
      const s = stingerCtx();
      if (!s) return;
      const { c, m } = s;
      const now = c.currentTime;
      // Major arpeggio, last note held: unmistakably "you did it".
      const semis = [0, 4, 7, 12, 16];
      semis.forEach((semi, i) => {
        const at = now + i * 0.1;
        const last = i === semis.length - 1;
        pluck(c, m, 523.25 * Math.pow(2, semi / 12), at, 0.17, last ? 0.8 : 0.22);
      });
    },
    countdownTick() {
      const s = stingerCtx();
      if (!s) return;
      const { c, m } = s;
      const now = c.currentTime;
      const o = c.createOscillator();
      o.type = "square";
      o.frequency.setValueAtTime(1000, now);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.12, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      o.connect(g);
      g.connect(m);
      o.start(now);
      o.stop(now + 0.1);
    },
    timeUp() {
      const s = stingerCtx();
      if (!s) return;
      const { c, m } = s;
      const now = c.currentTime;
      // Two detuned saws diving two octaves — the sound of the fun ending.
      for (let i = 0; i < 2; i++) {
        const o = c.createOscillator();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(440 + i * 6, now);
        o.frequency.exponentialRampToValueAtTime(110, now + 0.6);
        const lp = c.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(2400, now);
        lp.frequency.exponentialRampToValueAtTime(500, now + 0.6);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
        o.connect(lp);
        lp.connect(g);
        g.connect(m);
        o.start(now);
        o.stop(now + 0.8);
      }
      if (noiseBuf) {
        const src = c.createBufferSource();
        src.buffer = noiseBuf;
        const lp = c.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 200;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
        src.connect(lp);
        lp.connect(g);
        g.connect(m);
        src.start(now);
        src.stop(now + 0.55);
      }
    },
    setMuted(m: boolean) {
      muted = m;
      if (master) master.gain.value = m ? 0 : 0.85;
    },
  };
}
