// ---------------------------------------------------------------------------
// The roguelite layer: XP, level-ups and run-scoped perks. Pure logic — no DOM,
// no THREE — so it unit-tests via dynamic import exactly like score.ts. It owns
// the perk pool, the XP curve and the active modifier snapshot; main.ts pushes
// that snapshot out to the systems (herd, meteors, score, game) via setters, so
// this module never imports them and stays a self-contained state machine.
//
// PLAY only: beginRun() arms it. Zen never calls that, so addKills() no-ops and
// no card ever shows. Everything zeroes at run start and run end.
// ---------------------------------------------------------------------------

export type PerkId =
  | "moreUnicorns"
  | "biggerUnicorns"
  | "slowerUnicorns"
  | "glowingHorn"
  | "biggerBlast"
  | "fasterCharge"
  | "longerStreak"
  | "domino";

// The aggregate modifier snapshot, recomputed from the chosen stacks and pushed
// to the systems by main.applyPerkMods(). The identity value = a fresh run.
export interface PerkMods {
  waveMult: number; // game.levelConfig: herd size per level
  sizeMult: number; // herd.setSizeMult
  speedMult: number; // herd.setSpeedMult
  hornGlow: number; // herd.setHornGlow (emissiveIntensity)
  radiusScale: number; // meteors.setRadiusScale
  chargeScale: number; // meteors.setChargeScale (charge TIME, so < 1 = faster)
  streakBonusSec: number; // score.setStreakWindowBonus
  domino: boolean; // main.handleImpact: meteor kills electrify the ring
}

export interface Perk {
  id: PerkId;
  title: string;
  desc: string;
  maxStacks: number;
}

// One card offered on a level-up (a subset of Perk the HUD renders).
export interface PerkCard {
  id: PerkId;
  title: string;
  desc: string;
}

export interface Perks {
  /** Arm the roguelite layer for a PLAY run: zero XP/level/stacks, activate. */
  beginRun(): void;
  /** Disarm + wipe (run end / replay). addKills() no-ops until beginRun again. */
  reset(): void;
  /** Feed kills in. No-op unless active. Queues a level-up per threshold crossed. */
  addKills(n: number): void;
  active(): boolean;
  level(): number; // 1-based display level
  xpInLevel(): number; // kills into the current level
  xpForNext(): number; // kills needed to finish the current level
  progress01(): number; // 0..1 bar fill
  pendingLevelUps(): number;
  /** Up to CARDS_PER_LEVEL distinct eligible (not-maxed) perk cards. */
  roll(): PerkCard[];
  /** Apply a chosen perk: bump its stack, recompute mods, drain one pending. */
  choose(id: PerkId): void;
  mods(): PerkMods;
  stacks(id: PerkId): number; // introspection for tests/dev
}

// ---- Tunables -------------------------------------------------------------
const XP_BASE = 8;
const XP_GROWTH = 1.35;
const HORN_GLOW_BASE = 0.75; // matches unicorn.ts hornMat.emissiveIntensity
const HORN_GLOW_ON = 1.7;
const CARDS_PER_LEVEL = 3;

// Kills to finish level `n` (0-based: the level 1 → 2 gap is n = 0).
// 8, 11, 15, 20, 27, 36, 49, … — a gentle exponential ramp.
export function xpForLevel(n: number): number {
  return Math.ceil(XP_BASE * Math.pow(XP_GROWTH, n));
}

// The pool. Numeric perks stack (multiplying/adding in recompute()) up to
// maxStacks; the two toggles cap at one. title → card h1, desc → card p.
const POOL: Perk[] = [
  { id: "moreUnicorns", title: "STAMPEDE", desc: "+30% herd every wave", maxStacks: 3 },
  { id: "biggerUnicorns", title: "PRIZE PONIES", desc: "Unicorns 1.3× bigger", maxStacks: 3 },
  { id: "slowerUnicorns", title: "MOLASSES MEADOW", desc: "Unicorns 20% slower", maxStacks: 3 },
  { id: "glowingHorn", title: "RADIANT HORNS", desc: "Horns blaze with light", maxStacks: 1 },
  { id: "biggerBlast", title: "WIDER RUIN", desc: "+15% blast radius", maxStacks: 4 },
  { id: "fasterCharge", title: "HAIR TRIGGER", desc: "−25% charge time", maxStacks: 3 },
  { id: "longerStreak", title: "KILLER INSTINCT", desc: "+2s streak window", maxStacks: 3 },
  { id: "domino", title: "CHAIN REACTION", desc: "Meteor kills electrify neighbours", maxStacks: 1 },
];

function identityMods(): PerkMods {
  return {
    waveMult: 1,
    sizeMult: 1,
    speedMult: 1,
    hornGlow: HORN_GLOW_BASE,
    radiusScale: 1,
    chargeScale: 1,
    streakBonusSec: 0,
    domino: false,
  };
}

export function createPerks(): Perks {
  let active = false;
  let xp = 0; // kills into the current level
  let levelsGained = 0; // 0-based; display level = levelsGained + 1
  let pending = 0; // level-ups awaiting a card pick
  const stacks: Record<PerkId, number> = {
    moreUnicorns: 0,
    biggerUnicorns: 0,
    slowerUnicorns: 0,
    glowingHorn: 0,
    biggerBlast: 0,
    fasterCharge: 0,
    longerStreak: 0,
    domino: 0,
  };
  let mods: PerkMods = identityMods();

  // Rebuild the cached snapshot from the current stacks. Numeric perks compound
  // (1.3ⁿ / 0.8ⁿ / …); the toggles flip on at one stack.
  function recompute(): void {
    const m = identityMods();
    m.waveMult = Math.pow(1.3, stacks.moreUnicorns);
    m.sizeMult = Math.pow(1.3, stacks.biggerUnicorns);
    m.speedMult = Math.pow(0.8, stacks.slowerUnicorns);
    m.hornGlow = stacks.glowingHorn > 0 ? HORN_GLOW_ON : HORN_GLOW_BASE;
    m.radiusScale = Math.pow(1.15, stacks.biggerBlast);
    m.chargeScale = Math.pow(0.75, stacks.fasterCharge);
    m.streakBonusSec = 2 * stacks.longerStreak;
    m.domino = stacks.domino > 0;
    mods = m;
  }

  function zero(): void {
    xp = 0;
    levelsGained = 0;
    pending = 0;
    for (const k of Object.keys(stacks) as PerkId[]) stacks[k] = 0;
    recompute();
  }

  return {
    beginRun(): void {
      zero();
      active = true;
    },
    reset(): void {
      zero();
      active = false;
    },
    addKills(n: number): void {
      if (!active || n <= 0) return;
      xp += n;
      // A big multi-kill can cross several thresholds in one go.
      while (xp >= xpForLevel(levelsGained)) {
        xp -= xpForLevel(levelsGained);
        levelsGained++;
        pending++;
      }
    },
    active: () => active,
    level: () => levelsGained + 1,
    xpInLevel: () => xp,
    xpForNext: () => xpForLevel(levelsGained),
    progress01: () => xp / xpForLevel(levelsGained),
    pendingLevelUps: () => pending,
    roll(): PerkCard[] {
      const eligible = POOL.filter((p) => stacks[p.id] < p.maxStacks);
      // Fisher-Yates on the copy, then take the first few — distinct by build.
      for (let i = eligible.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
      }
      return eligible.slice(0, CARDS_PER_LEVEL).map((p) => ({ id: p.id, title: p.title, desc: p.desc }));
    },
    choose(id: PerkId): void {
      const perk = POOL.find((p) => p.id === id);
      if (!perk || stacks[id] >= perk.maxStacks) return;
      stacks[id]++;
      recompute();
      if (pending > 0) pending--;
    },
    mods: () => mods,
    stacks: (id: PerkId) => stacks[id],
  };
}
