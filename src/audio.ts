// ---------------------------------------------------------------------------
// Background music: four looping tracks crossfaded by game state.
//   menu    → "Glass Mane"            (intro / menu)
//   meadow  → "Glitter Meadow Drift"  (peaceful in-game ambience)
//   frenzy  → "Shattered Hoof Frenzy" (kicks in the moment you attack)
//   victory → "Glitter Horn Parade"   (every unicorn slain)
//
// Plain HTMLAudioElements (non-positional) are perfect here: simple, robust,
// and gapless when looped. Switching tracks crossfades volumes over a few
// hundred ms so transitions never pop. Browsers block audio until a user
// gesture, so play() only records intent until unlock() is called from one.
// ---------------------------------------------------------------------------

import { asset } from "./base";

export type Track = "menu" | "meadow" | "frenzy" | "victory";

interface TrackDef {
  url: string;
  volume: number; // target (full) volume, 0..1
}

const TRACKS: Record<Track, TrackDef> = {
  menu: { url: "/music/glass-mane.m4a", volume: 0.7 },
  meadow: { url: "/music/glitter-meadow-drift.m4a", volume: 0.55 },
  frenzy: { url: "/music/shattered-hoof-frenzy.m4a", volume: 0.8 },
  victory: { url: "/music/glitter-horn-parade.m4a", volume: 0.85 },
};

const ALL = Object.keys(TRACKS) as Track[];

interface Fade {
  from: number;
  to: number;
  start: number; // seconds
  dur: number; // seconds
}

export interface AudioManager {
  /** Crossfade to `track`. Safe to call before unlock(): records intent and
   *  starts once a user gesture unlocks playback. No-op if already current. */
  play(track: Track, fade?: number): void;
  /** Call from a user gesture (click/keydown) to satisfy autoplay policy. */
  unlock(): void;
  /** Mute/unmute every track. Returns the new muted state. */
  toggleMute(): boolean;
  current(): Track | null;
}

export function createAudio(): AudioManager {
  const els = {} as Record<Track, HTMLAudioElement>;
  const fades = new Map<Track, Fade>();
  let intended: Track | null = null;
  let unlocked = false;
  let muted = false;
  let raf = 0;

  for (const t of ALL) {
    const el = new Audio(asset(TRACKS[t].url));
    el.loop = true;
    el.preload = "auto";
    el.volume = 0;
    els[t] = el;
  }

  const now = (): number => performance.now() / 1000;

  function tick(): void {
    raf = 0;
    const t = now();
    let active = false;
    for (const [track, f] of fades) {
      const k = f.dur <= 0 ? 1 : Math.min((t - f.start) / f.dur, 1);
      const v = f.from + (f.to - f.from) * k;
      const el = els[track];
      el.volume = Math.max(0, Math.min(1, v));
      if (k >= 1) {
        fades.delete(track);
        if (f.to === 0) el.pause(); // free the decoder once silent
      } else {
        active = true;
      }
    }
    if (active) raf = requestAnimationFrame(tick);
  }

  function fadeTo(track: Track, to: number, dur: number): void {
    const el = els[track];
    if (to > 0 && el.paused) {
      el.currentTime = 0; // (re)start from the top — frenzy restarts each attack
      el.play().catch(() => { /* still locked; unlock() will retry */ });
    }
    fades.set(track, { from: el.volume, to, start: now(), dur });
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function applyIntent(fade: number): void {
    for (const t of ALL) fadeTo(t, t === intended ? TRACKS[t].volume : 0, fade);
  }

  return {
    play(track, fade = 1.2) {
      if (track === intended) return;
      intended = track;
      if (unlocked) applyIntent(fade);
    },
    unlock() {
      // Idempotent + retrying. The first (eager, on-load) call starts playback
      // where autoplay is allowed — the native WebView2 app. If that was blocked
      // (plain browser), a later call from a user gesture re-applies intent and
      // starts the still-paused track.
      unlocked = true;
      if (intended) applyIntent(1.0);
    },
    toggleMute() {
      muted = !muted;
      for (const t of ALL) els[t].muted = muted;
      return muted;
    },
    current: () => intended,
  };
}
