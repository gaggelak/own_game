// ---------------------------------------------------------------------------
// The run. Two ways to play, one meadow:
//
//   PLAY — a gauntlet of levels. Each is a herd and a countdown: wipe them out
//          before 0:00 and the next level is bigger, faster and twitchier. You
//          can't die — only the clock can kill you.
//   ZEN  — endless. No clock, no fail, no win: the meadow just keeps restocking
//          itself from the rainbow side while you keep scoring. Brain off.
//
// This module owns the state, the clock and the wave orchestration. score.ts
// owns the numbers, hud.ts owns the pixels, main.ts owns the frame.
// ---------------------------------------------------------------------------

import type { Herd } from "./unicorn";
import type { Hud } from "./hud";
import type { Score } from "./score";
import type { AudioManager } from "./audio";
import type { Sfx } from "./sfx";

export type GameState = "menu" | "zen" | "levelIntro" | "playing" | "interstitial" | "runOver";

// ---- Level curve (TUNABLE) ------------------------------------------------
// The clock grows with the herd, so later levels aren't harder because there's
// more arithmetic — they're harder because the herd is faster and spookier, and
// a big cluster takes real herding to build.
const LEVEL_COUNT_BASE = 20;
const LEVEL_COUNT_STEP = 4;
const LEVEL_COUNT_MAX = 100;
const LEVEL_TIME_BASE = 15;
const LEVEL_TIME_PER_UNICORN = 1.3;
const LEVEL_TIME_MAX = 150;
const TIME_PER_KILL: number = 0; // optional "kills buy time" — off by default

const INTRO_TIME = 2.2;
const INTERSTITIAL_TIME = 3;
const TIME_BONUS_PER_SEC = 25;
const PHOTO_FINISH_PTS = 500;
const PHOTO_FINISH_WINDOW = 1; // cleared with under a second left
const COUNTDOWN_FROM = 5; // seconds of ticking before the buzzer

// Zen: keep the meadow stocked, trickling replacements in rather than popping a
// burst — a massacre should refill visibly, not blink back.
const ZEN_TARGET_POP = 60;
const ZEN_RESPAWN_MIN = 0.5;
const ZEN_RESPAWN_VAR = 0.5;

interface LevelCfg {
  count: number;
  time: number;
  speedMult: number;
  gallopFraction: number;
  scareRadiusMult: number;
}

function levelConfig(n: number): LevelCfg {
  const count = Math.min(LEVEL_COUNT_BASE + LEVEL_COUNT_STEP * (n - 1), LEVEL_COUNT_MAX);
  return {
    count,
    time: Math.min(LEVEL_TIME_BASE + LEVEL_TIME_PER_UNICORN * count, LEVEL_TIME_MAX),
    speedMult: Math.min(1 + 0.05 * (n - 1), 1.8),
    gallopFraction: Math.min(0.5 + 0.045 * (n - 1), 0.9),
    scareRadiusMult: Math.min(1 + 0.05 * (n - 1), 1.6),
  };
}

function clock(s: number): string {
  const v = Math.max(0, Math.ceil(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

export interface Game {
  state(): GameState;
  startRun(): void;
  startZen(): void;
  update(dt: number): void;
  /** Impacts only pay while a level is live — post-whistle carnage is garnish. */
  canScoreBlast(): boolean;
  /** A doomed unicorn's pop still pays into the interstitial it earned. */
  canScorePop(): boolean;
  /** Hook for the optional "kills buy time" rule. */
  addTimeForKills(kills: number): void;
}

export interface GameDeps {
  herd: Herd;
  hud: Hud;
  score: Score;
  audio: AudioManager;
  sfx: Sfx;
}

export function createGame(deps: GameDeps): Game {
  const { herd, hud, score, audio, sfx } = deps;

  let state: GameState = "menu";
  let level = 0;
  let levelsCleared = 0;
  let timeLeft = 0;
  let stateT = 0; // countdown for the timed non-playing states
  let lastTick = -1;
  let respawnCd = 0;
  let pending: LevelCfg | null = null;

  function beginIntro(n: number): void {
    level = n;
    pending = levelConfig(n);
    state = "levelIntro";
    stateT = INTRO_TIME;
    hud.setTimer(null);
    hud.announce(`LEVEL ${n}`, `${pending.count} UNICORNS — ${clock(pending.time)}`);
    audio.play("meadow", 0.8);
  }

  function beginPlaying(): void {
    const cfg = pending ?? levelConfig(level);
    herd.spawnWave(cfg.count, {
      speedMult: cfg.speedMult,
      gallopFraction: cfg.gallopFraction,
      scareRadiusMult: cfg.scareRadiusMult,
      entrances: true, // gallop in from the rainbow side
    });
    timeLeft = cfg.time;
    lastTick = -1;
    state = "playing";
    hud.setTimer(timeLeft);
  }

  function clearLevel(): void {
    const secs = Math.max(0, Math.ceil(timeLeft));
    const bonus = secs * TIME_BONUS_PER_SEC;
    // Won it with the buzzer in sight — the reason to keep throwing at 0:02.
    const photo = timeLeft > 0 && timeLeft < PHOTO_FINISH_WINDOW;
    score.addBonus(bonus + (photo ? PHOTO_FINISH_PTS : 0));
    levelsCleared = level;
    state = "interstitial";
    stateT = INTERSTITIAL_TIME;
    hud.setTimer(null);
    sfx.levelClear();
    hud.banner(`LEVEL ${level} CLEARED`, 4);
    hud.subBanner(
      photo
        ? `PHOTO FINISH!  +${(bonus + PHOTO_FINISH_PTS).toLocaleString("en-US")}`
        : `TIME BONUS  +${bonus.toLocaleString("en-US")}`,
    );
  }

  function endRun(): void {
    state = "runOver";
    hud.setTimer(null);
    sfx.timeUp();
    hud.showEndCard(score.commitRun(levelsCleared), score.lifetime());
    // The parade plays over your stats instead of over a wiped meadow.
    audio.play("victory", 1.5);
  }

  return {
    state: () => state,

    startRun(): void {
      herd.reset(); // clear the menu backdrop herd
      score.resetRun();
      levelsCleared = 0;
      hud.showRunUi(true);
      beginIntro(1);
    },

    startZen(): void {
      // Adopts the herd already grazing behind the menu.
      state = "zen";
      respawnCd = ZEN_RESPAWN_MIN;
      hud.showRunUi(true);
      hud.setTimer(null);
      audio.play("meadow");
    },

    update(dt: number): void {
      switch (state) {
        case "zen":
          respawnCd -= dt;
          if (respawnCd <= 0 && herd.aliveCount() < ZEN_TARGET_POP) {
            herd.spawnWave(1, { entrances: true });
            respawnCd = ZEN_RESPAWN_MIN + Math.random() * ZEN_RESPAWN_VAR;
          }
          break;

        case "levelIntro":
          stateT -= dt;
          if (stateT <= 0) beginPlaying();
          break;

        case "playing": {
          // Cleared is checked BEFORE the clock: a kill landing on the same
          // frame as 0:00 still wins the level.
          if (herd.roamingCount() === 0) {
            clearLevel();
            break;
          }
          timeLeft -= dt;
          const whole = Math.ceil(timeLeft);
          if (whole !== lastTick && whole > 0 && whole <= COUNTDOWN_FROM) {
            lastTick = whole;
            sfx.countdownTick();
          }
          hud.setTimer(timeLeft);
          if (timeLeft <= 0) endRun();
          break;
        }

        case "interstitial":
          stateT -= dt;
          if (stateT <= 0) beginIntro(level + 1);
          break;
      }
    },

    canScoreBlast: () => state === "playing" || state === "zen",
    canScorePop: () => state !== "menu" && state !== "runOver",

    addTimeForKills(kills: number): void {
      if (!TIME_PER_KILL || state !== "playing") return;
      timeLeft = Math.min(timeLeft + TIME_PER_KILL * kills, LEVEL_TIME_MAX);
    },
  };
}
