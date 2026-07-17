// ---------------------------------------------------------------------------
// Score, combo chain and lifetime stats. Pure logic: no DOM, no THREE at
// runtime (world positions are passed straight through to the HUD as anchors).
//
// The shape of the fun:
//   * Every kill scores immediately — a whiff costs nothing, so mindless spam
//     always pays. That's the low floor.
//   * Kills in the SAME blast pay exponentially (100·n·2^(n−1)), so clustering
//     the herd before you throw is worth far more than picking them off. That's
//     the ceiling.
//   * A chain multiplier climbs while you keep destroying things (kills OR
//     toppled props) and "banks" with a flourish when the window runs out.
//     Banking is pure celebration — the points were already yours.
//   * A kill streak counts kills ACROSS throws and drives the escalating
//     ladder banners (DOUBLE KILL → EXTINCTION EVENT). It's a pure celebration
//     layer on top of the scoring above — it changes no points, only the show.
// ---------------------------------------------------------------------------

import type * as THREE from "three";

// ---- Tunables -------------------------------------------------------------
const KILL_BASE = 100; // points for one unicorn, before the same-blast bonus
const PROP_POINTS = 10; // per toppled tree/rock/bush
const CHAIN_WINDOW = 5; // seconds of calm before the chain banks
const CHAIN_STEP = 0.5; // multiplier gained per kill
const CHAIN_MAX = 20; // sanity ceiling on the multiplier
const LONG_SHOT_DIST = 60; // horizontal launch→impact distance that counts as a long shot
const LONG_SHOT_PTS = 300;
const OVERKILL_PTS = 250; // full charge spent on a single unicorn — comedy tax refund
const OVERKILL_CHARGE = 0.95;
const DOMINO_PTS = 75; // × chain depth, per contagion pop
const STREAK_WINDOW = 5; // seconds after a kill before the streak banks (at tier 0)
const STREAK_DECAY = 0.85; // window shrinks by this per ladder rung climbed

// Cross-throw kill-streak ladder. tier drives HUD styling + the fanfare's
// pitch; min is now the streak count (kills across throws), not same-blast n.
interface Rung {
  min: number;
  label: string;
  tier: number;
}
const LADDER: Rung[] = [
  { min: 10, label: "EXTINCTION EVENT", tier: 7 },
  { min: 8, label: "CORNAGEDDON", tier: 6 },
  { min: 6, label: "UNICORNICIDE", tier: 5 },
  { min: 5, label: "FULL STABLE", tier: 4 },
  { min: 4, label: "QUADRICORN", tier: 3 },
  { min: 3, label: "TRIPLE KILL", tier: 2 },
  { min: 2, label: "DOUBLE KILL", tier: 1 },
];

// Lifetime body-count titles — the number that never goes down.
const MILESTONES: { at: number; title: string }[] = [
  { at: 50, title: "FOAL MOWER" },
  { at: 100, title: "STABLE SWEEPER" },
  { at: 250, title: "RAINBOW RUSTLER" },
  { at: 500, title: "HORN HARVESTER" },
  { at: 1000, title: "GLUE FACTORY FOREMAN" },
  { at: 2500, title: "MYTHICAL MENACE" },
  { at: 5000, title: "EXTINCTION ARCHITECT" },
];

// End-of-run rank thresholds (TUNABLE — first-pass guesses, tune by feel).
// NOTE (fase 2, 5× unicorns): with denser herds the same-blast ladder
// (100·n·2^(n−1), registerBlast below) explodes — a single 10-kill blast pays
// 512k raw, already past the S line. Retune these after the fase-2 playtest.
const RANKS: { at: number; rank: Rank }[] = [
  { at: 150000, rank: "S" },
  { at: 60000, rank: "A" },
  { at: 20000, rank: "B" },
  { at: 0, rank: "C" },
];

const STORE_KEY = "unicornMeadow.stats.v1";

// ---- Types ----------------------------------------------------------------
export type Rank = "S" | "A" | "B" | "C";

export interface ScoreEvent {
  kind: "points" | "banner" | "sub" | "bank" | "milestone" | "streak";
  /** Signed amount actually awarded (already multiplied by the chain). */
  points?: number;
  /** Anchor for a floating pop number (points events). */
  worldPos?: THREE.Vector3;
  /** "TRIPLE KILL", "LONG SHOT", "DOMINO ×3", "1 MORE → TRIPLE KILL"… */
  label?: string;
  /** 1..7 → HUD styling + fanfare tier. */
  tier?: number;
  /** Payload for events that carry a number the HUD needs (bank: the mult;
   *  streak: the current streak count). */
  value?: number;
}

export interface BlastInfo {
  point: THREE.Vector3;
  /** Meteor: unicorns killed. Water ball: unicorns electrified. */
  kills: number;
  props: number;
  charge: number;
  launchPos: THREE.Vector3;
}

export interface RunSummary {
  score: number;
  kills: number;
  bestChain: number;
  biggestBlast: number;
  levelsCleared: number;
  rank: Rank;
}

export interface LifetimeStats {
  kills: number;
  bestScore: number;
  deepestLevel: number;
  bestChain: number;
  title: string | null;
}

export interface ChainState {
  mult: number;
  remaining01: number;
}

export interface StreakState {
  /** Kills in the live streak (0 = no streak running). */
  count: number;
  /** Tier of the ladder rung the count currently sits on (0 = below DOUBLE). */
  tier: number;
  /** Fraction of the current (shrinking) window still left, for the countdown. */
  remaining01: number;
}

export interface Score {
  /** Meteor impact: the same-blast ladder, props, LONG SHOT, OVERKILL. */
  registerBlast(info: BlastInfo): ScoreEvent[];
  /** Water-ball impact: hits don't kill yet (the pops do) — LONG SHOT only. */
  registerWaterball(info: BlastInfo): ScoreEvent[];
  /** One electrified unicorn finally bursting (chainDepth ≥ 1 = DOMINO). */
  registerPop(pos: THREE.Vector3, chainDepth: number): ScoreEvent[];
  /** Flat award — level time bonus, PHOTO FINISH. Untaxed by the chain, and
   *  silent: the caller owns how it's announced. */
  addBonus(points: number): void;
  /** Advance the chain + streak windows on the sim clock; emits bank events. */
  update(now: number): ScoreEvent[];
  chainState(): ChainState;
  streakState(): StreakState;
  current(): { score: number; kills: number; bestChain: number; biggestBlast: number };
  resetRun(): void;
  /** End of run: persist lifetime bests, return the summary for the end card. */
  commitRun(levelsCleared: number): RunSummary;
  lifetime(): LifetimeStats;
}

interface Persisted {
  kills: number;
  bestScore: number;
  deepestLevel: number;
  bestChain: number;
}

function loadStats(): Persisted {
  const empty: Persisted = { kills: 0, bestScore: 0, deepestLevel: 0, bestChain: 0 };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      kills: Number(p.kills) || 0,
      bestScore: Number(p.bestScore) || 0,
      deepestLevel: Number(p.deepestLevel) || 0,
      bestChain: Number(p.bestChain) || 0,
    };
  } catch {
    return empty; // private mode / corrupt payload — play on without persistence
  }
}

function titleFor(kills: number): string | null {
  let title: string | null = null;
  for (const m of MILESTONES) if (kills >= m.at) title = m.title;
  return title;
}

// The rung a streak of `n` sits on (LADDER is sorted high→low by min), or null
// below DOUBLE KILL.
function rungFor(n: number): Rung | null {
  return LADDER.find((r) => n >= r.min) ?? null;
}

// The next rung up from `n` — what "1 MORE →" is pointing at. Null past the top.
function nextRungFor(n: number): Rung | null {
  for (let i = LADDER.length - 1; i >= 0; i--) if (LADDER[i].min > n) return LADDER[i];
  return null;
}

// The streak window shrinks a notch per rung climbed, so higher streaks demand
// faster follow-ups — the escalating pressure the playtester asked for.
function streakWindow(n: number): number {
  return STREAK_WINDOW * Math.pow(STREAK_DECAY, rungFor(n)?.tier ?? 0);
}

export function createScore(): Score {
  const stats = loadStats();

  // Run state
  let score = 0;
  let kills = 0;
  let bestChain = 1;
  let biggestBlast = 0;

  // Chain state
  let mult = 1;
  let chainEnd = -1; // sim time the window expires (< 0 = no live chain)
  let chainWindowStart = 0;

  // Streak state — the cross-throw ladder, purely for celebration.
  let streak = 0;
  let streakEnd = -1; // sim time the streak banks (< 0 = no live streak)
  let streakStart = 0;
  let streakBestTier = 0; // highest rung reached this streak (drives the bank tier)
  // The sim clock, refreshed every frame by update(). Impacts resolve between
  // frames, so they read the last known time rather than each taking a `now`.
  let lastNow = 0;

  function save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(stats));
    } catch {
      /* storage unavailable — the run still plays, it just won't persist */
    }
  }

  // Any destruction keeps the chain alive.
  function touchChain(): void {
    chainEnd = lastNow + CHAIN_WINDOW;
    chainWindowStart = lastNow;
  }

  function bumpChain(n: number): void {
    mult = Math.min(mult + CHAIN_STEP * n, CHAIN_MAX);
    if (mult > bestChain) bestChain = mult;
  }

  // Feed `n` kills into the cross-throw streak: climb the ladder (a multi-kill
  // jumps several rungs at once, but only the highest fires a banner), reset the
  // shrinking window, and emit the live "1 MORE → …" prompt. Returns whether a
  // rung was crossed, so a colliding DOMINO banner can step aside.
  function addStreak(n: number, out: ScoreEvent[]): boolean {
    const prev = rungFor(streak);
    streak += n;
    const cur = rungFor(streak);
    const crossed = cur !== null && cur !== prev;
    if (crossed) {
      out.push({ kind: "banner", label: cur!.label, tier: cur!.tier });
      if (cur!.tier > streakBestTier) streakBestTier = cur!.tier;
    }
    streakStart = lastNow;
    streakEnd = lastNow + streakWindow(streak);
    const next = nextRungFor(streak);
    out.push({
      kind: "streak",
      label: next ? `${next.min - streak} MORE → ${next.label}` : `${cur!.label} ×${streak}`,
      tier: Math.max(cur?.tier ?? 0, 1),
      value: streak,
    });
    return crossed;
  }

  // Award `raw` points at the CURRENT multiplier (the chain you've already
  // earned pays for this hit; this hit's own kills raise it for the next one).
  function award(raw: number, out: ScoreEvent[], pos?: THREE.Vector3): number {
    const points = Math.round(raw * mult);
    score += points;
    out.push({ kind: "points", points, worldPos: pos });
    return points;
  }

  // Lifetime body count + the milestone banner when a threshold is crossed.
  function countKills(n: number, out: ScoreEvent[]): void {
    const before = stats.kills;
    stats.kills += n;
    save();
    for (const m of MILESTONES) {
      if (before < m.at && stats.kills >= m.at) {
        out.push({ kind: "milestone", label: m.title, tier: 6 });
        break;
      }
    }
  }

  function longShot(info: BlastInfo, out: ScoreEvent[]): void {
    const dx = info.point.x - info.launchPos.x;
    const dz = info.point.z - info.launchPos.z;
    if (Math.hypot(dx, dz) < LONG_SHOT_DIST) return;
    award(LONG_SHOT_PTS, out, info.point);
    out.push({ kind: "sub", label: "LONG SHOT" });
  }

  return {
    registerBlast(info: BlastInfo): ScoreEvent[] {
      const out: ScoreEvent[] = [];
      const n = info.kills;

      if (n > 0) {
        // 100 · n · 2^(n−1): two kills pay 4×, five kills pay 80×.
        award(KILL_BASE * n * Math.pow(2, n - 1), out, info.point);
        // The ladder banner now rides the cross-throw streak, not same-blast n.
        addStreak(n, out);
        kills += n;
        if (n > biggestBlast) biggestBlast = n;
        countKills(n, out);
        if (info.charge >= OVERKILL_CHARGE && n === 1) {
          award(OVERKILL_PTS, out, info.point);
          out.push({ kind: "sub", label: "OVERKILL" });
        }
        longShot(info, out);
      }
      if (info.props > 0) award(info.props * PROP_POINTS, out, info.point);

      // Kills and props both keep the chain breathing; only kills raise it.
      if (n > 0 || info.props > 0) touchChain();
      if (n > 0) bumpChain(n);
      return out;
    },

    registerWaterball(info: BlastInfo): ScoreEvent[] {
      const out: ScoreEvent[] = [];
      if (info.kills <= 0) return out; // a wet whiff: no points, no chain, no penalty
      // The kills land later (each pop scores itself) — this is just the setup.
      longShot(info, out);
      if (info.kills >= 3) out.push({ kind: "sub", label: `ELECTRIFIED ×${info.kills}` });
      touchChain();
      return out;
    },

    registerPop(pos: THREE.Vector3, chainDepth: number): ScoreEvent[] {
      const out: ScoreEvent[] = [];
      award(KILL_BASE, out, pos);
      kills += 1;
      countKills(1, out);
      const crossed = addStreak(1, out);
      if (chainDepth >= 1) {
        award(DOMINO_PTS * chainDepth, out, pos);
        const label = `DOMINO ×${chainDepth + 1}`;
        // One banner per moment — if this pop climbed a rung, the ladder wins
        // the banner and DOMINO drops to the sub-line.
        if (crossed) out.push({ kind: "sub", label });
        else out.push({ kind: "banner", label, tier: Math.min(chainDepth + 1, 7) });
      }
      touchChain();
      bumpChain(1);
      return out;
    },

    addBonus(points: number): void {
      score += points; // already earned — the chain doesn't get a cut
    },

    update(now: number): ScoreEvent[] {
      lastNow = now;
      const out: ScoreEvent[] = [];
      // Streak banks first: its window (≤ 4.25s once celebrated) always expires
      // before the chain's fixed 5s, so the two never bank on the same frame.
      if (streakEnd >= 0 && now >= streakEnd) {
        if (streak >= 2) {
          out.push({ kind: "bank", label: `STREAK ×${streak}`, tier: streakBestTier, value: streak });
        }
        streak = 0;
        streakEnd = -1;
        streakBestTier = 0;
      }
      if (chainEnd >= 0 && now >= chainEnd) {
        if (mult > 1) {
          out.push({ kind: "bank", label: `CHAIN ×${mult.toFixed(1)}`, tier: 2, value: mult });
        }
        chainEnd = -1;
        mult = 1;
      }
      return out;
    },

    chainState(): ChainState {
      if (chainEnd < 0) return { mult, remaining01: 0 };
      const span = chainEnd - chainWindowStart || CHAIN_WINDOW;
      return { mult, remaining01: Math.min(Math.max((chainEnd - lastNow) / span, 0), 1) };
    },

    streakState(): StreakState {
      if (streakEnd < 0) return { count: 0, tier: 0, remaining01: 0 };
      const span = streakEnd - streakStart || STREAK_WINDOW;
      return {
        count: streak,
        tier: rungFor(streak)?.tier ?? 0,
        remaining01: Math.min(Math.max((streakEnd - lastNow) / span, 0), 1),
      };
    },

    current() {
      return { score, kills, bestChain, biggestBlast };
    },

    resetRun(): void {
      score = 0;
      kills = 0;
      bestChain = 1;
      biggestBlast = 0;
      mult = 1;
      chainEnd = -1;
      streak = 0;
      streakEnd = -1;
      streakBestTier = 0;
    },

    commitRun(levelsCleared: number): RunSummary {
      if (score > stats.bestScore) stats.bestScore = score;
      if (levelsCleared > stats.deepestLevel) stats.deepestLevel = levelsCleared;
      if (bestChain > stats.bestChain) stats.bestChain = bestChain;
      save();
      const rank = (RANKS.find((r) => score >= r.at) ?? RANKS[RANKS.length - 1]).rank;
      return { score, kills, bestChain, biggestBlast, levelsCleared, rank };
    },

    lifetime(): LifetimeStats {
      return {
        kills: stats.kills,
        bestScore: stats.bestScore,
        deepestLevel: stats.deepestLevel,
        bestChain: stats.bestChain,
        title: titleFor(stats.kills),
      };
    },
  };
}
