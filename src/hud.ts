// ---------------------------------------------------------------------------
// The HUD: every pixel of run feedback. Pure presentation — it owns the DOM
// overlay declared in index.html and knows nothing about how points are earned.
//
// Score pops are world-anchored: each one remembers the spot it was earned at
// and is projected to screen space every frame, so a "+3,200" hangs over the
// crater it came from while the camera keeps flying. They run on REAL time, so
// they keep animating through a hitstop freeze.
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { ScoreEvent, RunSummary, LifetimeStats, StreakState } from "./score";
import type { Sfx } from "./sfx";

const POP_POOL = 24;
const POP_LIFE = 1.1; // seconds
const POP_RISE = 2.5; // world units/sec — the pop drifts up off the corpse
const BANNER_MIN_GAP = 0.45; // seconds a banner holds before a same-tier one may replace it
const ROLL_TIME = 1.2; // seconds the all-time body count takes to roll up

interface Pop {
  el: HTMLDivElement;
  anchor: THREE.Vector3;
  age: number;
  live: boolean;
  jx: number; // screen-space jitter so simultaneous pops don't stack exactly
  jy: number;
}

export interface Hud {
  setScore(v: number): void;
  setChain(mult: number, remaining01: number): void;
  /** Drive the streak countdown bar; hides itself when no streak is live. */
  setStreak(s: StreakState): void;
  setCount(n: number): void;
  /** null hides the clock entirely (menu / Zen). */
  setTimer(seconds: number | null): void;
  /** Big centre kill-name. Higher tiers preempt; equal ones queue briefly. */
  banner(label: string, tier: number): void;
  /** The smaller line under it: skill shots, chain banks. */
  subBanner(label: string): void;
  pop(worldPos: THREE.Vector3, text: string, big?: number): void;
  /** Level intro / interstitial headline. */
  announce(title: string, subtitle: string): void;
  showRunUi(show: boolean): void;
  /** Run over: the summary, plus the all-time count rolling up over it. */
  showEndCard(run: RunSummary, life: LifetimeStats): void;
  /** Lifetime stats line on the main menu. */
  setMenuStats(life: LifetimeStats): void;
  /** The single funnel: score events → pops, banners, fanfares. */
  applyEvents(events: ScoreEvent[], sfx: Sfx): void;
  update(dtReal: number, camera: THREE.PerspectiveCamera): void;
}

const _v = new THREE.Vector3();

export function createHud(): Hud {
  const scorePanel = document.getElementById("score-panel")!;
  const scoreEl = document.getElementById("score")!;
  const chainRow = document.getElementById("chain-row")!;
  const chainFill = document.getElementById("chain-fill")!;
  const chainMultEl = document.getElementById("chain-mult")!;
  const countEl = document.getElementById("count")!;
  const timerEl = document.getElementById("timer")!;
  const bannerMain = document.getElementById("banner-main")!;
  const bannerSub = document.getElementById("banner-sub")!;
  const streakEl = document.getElementById("streak")!;
  const streakLabel = document.getElementById("streak-label")!;
  const streakFill = document.getElementById("streak-fill")!;
  const popsEl = document.getElementById("pops")!;
  const menuStatsEl = document.getElementById("menu-stats")!;
  const endcardEl = document.getElementById("endcard")!;
  const endRankEl = document.getElementById("endcard-rank")!;
  const endSubEl = document.getElementById("endcard-sub")!;
  const endStatsEl = document.getElementById("endcard-stats")!;
  const endLifeEl = document.getElementById("endcard-life")!;
  const endTitleEl = document.getElementById("endcard-title")!;

  const pops: Pop[] = [];
  for (let i = 0; i < POP_POOL; i++) {
    const el = document.createElement("div");
    el.className = "pop";
    popsEl.appendChild(el);
    pops.push({ el, anchor: new THREE.Vector3(), age: 0, live: false, jx: 0, jy: 0 });
  }
  let popHead = 0;

  // Cached so the frame loop can call the setters unconditionally without
  // touching the DOM 60×/sec.
  let lastScore = -1;
  let lastCount = -1;
  let lastTimerText = "";
  let lastMultText = "";

  let bannerHold = 0; // seconds left before a same-or-lower tier may replace
  let bannerTier = 0;
  let queued: { label: string; tier: number } | null = null;

  // Last streak tier seen (from a "streak" event) — also the pitch fed to popTick.
  let streakTier = 0;

  // All-time body count roll-up on the end card (< 0 = idle).
  let rollT = -1;
  let rollFrom = 0;
  let rollTo = 0;

  function showBanner(label: string, tier: number): void {
    const t = Math.min(Math.max(Math.round(tier), 1), 7);
    bannerMain.className = ""; // drop .show so the keyframe can retrigger
    void bannerMain.offsetWidth; // force reflow
    bannerMain.textContent = label;
    bannerMain.className = `t${t} show`;
    bannerHold = BANNER_MIN_GAP;
    bannerTier = t;
  }

  function banner(label: string, tier: number): void {
    // A bigger moment always interrupts; an equal/smaller one waits its turn.
    if (bannerHold <= 0 || tier > bannerTier) {
      showBanner(label, tier);
      return;
    }
    if (!queued || tier > queued.tier) queued = { label, tier };
  }

  function subBanner(label: string): void {
    bannerSub.className = "";
    void bannerSub.offsetWidth;
    bannerSub.textContent = label;
    bannerSub.className = "show";
  }

  function pop(worldPos: THREE.Vector3, text: string, big = 0): void {
    const p = pops[popHead];
    popHead = (popHead + 1) % POP_POOL;
    p.anchor.copy(worldPos);
    p.age = 0;
    p.live = true;
    p.jx = (Math.random() - 0.5) * 44;
    p.jy = (Math.random() - 0.5) * 26;
    p.el.textContent = text;
    p.el.className = "pop" + (big >= 2 ? " huge" : big >= 1 ? " big" : "");
    p.el.style.opacity = "1";
  }

  return {
    setScore(v: number): void {
      if (v === lastScore) return;
      lastScore = v;
      scoreEl.textContent = v.toLocaleString("en-US");
    },

    setChain(mult: number, remaining01: number): void {
      const live = remaining01 > 0 && mult > 1;
      chainRow.classList.toggle("idle", !live);
      if (!live) return;
      chainFill.style.width = `${(remaining01 * 100).toFixed(1)}%`;
      const text = `×${mult.toFixed(1)}`;
      if (text !== lastMultText) {
        lastMultText = text;
        chainMultEl.textContent = text;
      }
    },

    setStreak(s: StreakState): void {
      const live = s.count > 0 && s.remaining01 > 0;
      streakEl.classList.toggle("idle", !live);
      if (!live) {
        streakEl.classList.remove("urgent");
        streakTier = 0;
        return;
      }
      streakFill.style.width = `${(s.remaining01 * 100).toFixed(1)}%`;
      streakEl.classList.toggle("urgent", s.remaining01 < 0.25);
    },

    setCount(n: number): void {
      if (n === lastCount) return;
      lastCount = n;
      countEl.textContent = `🦄 × ${n}`;
    },

    setTimer(seconds: number | null): void {
      if (seconds === null) {
        timerEl.classList.add("hidden");
        return;
      }
      timerEl.classList.remove("hidden");
      const s = Math.max(0, seconds);
      const text = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
      if (text !== lastTimerText) {
        lastTimerText = text;
        timerEl.textContent = text;
      }
      timerEl.classList.toggle("urgent", s <= 5);
    },

    banner,
    subBanner,
    pop,

    announce(title: string, subtitle: string): void {
      showBanner(title, 4); // intros always win the banner — nothing else is happening
      subBanner(subtitle);
    },

    showRunUi(show: boolean): void {
      scorePanel.classList.toggle("hidden", !show);
      if (!show) timerEl.classList.add("hidden");
    },

    setMenuStats(life: LifetimeStats): void {
      if (life.kills === 0) {
        menuStatsEl.textContent = "The herd has never known fear.";
        return;
      }
      const bits = [`${life.kills.toLocaleString("en-US")} unicorns slain, all time`];
      if (life.bestScore > 0) bits.push(`best run ${life.bestScore.toLocaleString("en-US")}`);
      if (life.deepestLevel > 0) bits.push(`deepest level ${life.deepestLevel}`);
      menuStatsEl.innerHTML =
        bits.join("<br>") + (life.title ? `<br><span class="title">${life.title}</span>` : "");
    },

    showEndCard(run: RunSummary, life: LifetimeStats): void {
      endRankEl.textContent = `RANK ${run.rank}`;
      endSubEl.textContent =
        run.levelsCleared === 0
          ? "The herd outlasted you."
          : `You cleared ${run.levelsCleared} level${run.levelsCleared === 1 ? "" : "s"}.`;
      const rows: [string, string][] = [
        ["SCORE", run.score.toLocaleString("en-US")],
        ["UNICORNS", run.kills.toLocaleString("en-US")],
        ["BEST CHAIN", `×${run.bestChain.toFixed(1)}`],
        ["BIGGEST BLAST", run.biggestBlast > 0 ? `${run.biggestBlast} in one` : "—"],
      ];
      endStatsEl.innerHTML = rows
        .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
        .join("");
      endTitleEl.textContent = life.title ?? "";
      // Roll the all-time count up from where it stood before this run, so even
      // a rank-C run visibly moves the number that never resets.
      rollFrom = Math.max(0, life.kills - run.kills);
      rollTo = life.kills;
      rollT = 0;
      endLifeEl.textContent = rollFrom.toLocaleString("en-US");
      endcardEl.classList.remove("hidden");
    },

    applyEvents(events: ScoreEvent[], sfx: Sfx): void {
      for (const e of events) {
        switch (e.kind) {
          case "points": {
            if (!e.points || !e.worldPos) break;
            // Size the pop by how big the number is — a 3,200 should shout.
            const big = e.points >= 5000 ? 2 : e.points >= 1000 ? 1 : 0;
            pop(e.worldPos, `+${e.points.toLocaleString("en-US")}`, big);
            sfx.popTick(streakTier); // a coin blip on every number, pitched by streak
            break;
          }
          case "banner":
            if (!e.label) break;
            banner(e.label, e.tier ?? 1);
            sfx.killFanfare(e.tier ?? 1);
            break;
          case "sub":
            if (e.label) subBanner(e.label);
            break;
          case "bank":
            if (e.label) subBanner(e.label);
            sfx.chainBank(e.value ?? 1);
            break;
          case "milestone":
            if (!e.label) break;
            banner(e.label, 6);
            sfx.killFanfare(6);
            break;
          case "streak": {
            if (!e.label) break;
            // Retrigger the bump the same way the banner retriggers its pop.
            streakTier = Math.min(Math.max(e.tier ?? 1, 1), 7);
            streakLabel.className = "";
            void streakLabel.offsetWidth; // force reflow
            streakLabel.textContent = e.label;
            streakLabel.className = `t${streakTier} bump`;
            break;
          }
        }
      }
    },

    update(dtReal: number, camera: THREE.PerspectiveCamera): void {
      // All-time body count climbing on the end card.
      if (rollT >= 0) {
        rollT += dtReal;
        const k = Math.min(rollT / ROLL_TIME, 1);
        const eased = 1 - Math.pow(1 - k, 3);
        endLifeEl.textContent = Math.round(rollFrom + (rollTo - rollFrom) * eased).toLocaleString(
          "en-US",
        );
        if (k >= 1) rollT = -1;
      }

      // Banner queue: release the held slot, then let anything waiting through.
      if (bannerHold > 0) {
        bannerHold -= dtReal;
        if (bannerHold <= 0) {
          bannerTier = 0;
          if (queued) {
            showBanner(queued.label, queued.tier);
            queued = null;
          }
        }
      }

      for (const p of pops) {
        if (!p.live) continue;
        p.age += dtReal;
        if (p.age >= POP_LIFE) {
          p.live = false;
          p.el.style.opacity = "0";
          continue;
        }
        _v.copy(p.anchor);
        _v.y += p.age * POP_RISE;
        _v.project(camera);
        if (_v.z > 1) {
          p.el.style.opacity = "0"; // behind the camera
          continue;
        }
        const x = (_v.x * 0.5 + 0.5) * window.innerWidth + p.jx;
        const y = (-_v.y * 0.5 + 0.5) * window.innerHeight + p.jy;
        const k = p.age / POP_LIFE;
        p.el.style.transform =
          `translate(-50%,-50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) ` +
          `scale(${(1 + (1 - k) * 0.25).toFixed(3)})`;
        p.el.style.opacity = String(1 - k * k); // hangs bright, then drops away
      }
    },
  };
}
