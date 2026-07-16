import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { buildTerrain, terrainHeight, carveCrater, waterTime } from "./terrain";
import { populateFlora } from "./flora";
import { createHerd } from "./unicorn";
import { initPhysics } from "./physics";
import { createMeteorSystem, type WeaponKind } from "./meteor";
import { createVfx } from "./vfx";
import { createDebris } from "./debris";
import { createGibs } from "./gibs";
import { createElectro } from "./electro";
import { createAudio } from "./audio";
import { createSfx } from "./sfx";
import { CameraShake } from "./shake";
import { createAmbience } from "./ambience";

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
const app = document.getElementById("app")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
app.appendChild(renderer.domElement);

// ---------------------------------------------------------------------------
// Audio + game state: four looping tracks crossfaded by what's happening —
// menu (Glass Mane) → meadow (Glitter Meadow Drift) on Start → frenzy
// (Shattered Hoof Frenzy) the instant you attack → victory (Glitter Horn
// Parade) once the whole herd is slain. See audio.ts.
// ---------------------------------------------------------------------------
const audio = createAudio();
const sfx = createSfx();
audio.play("menu");
// Start the menu theme on open. The native app enables WebView2 autoplay (see
// additionalBrowserArgs in tauri.conf.json), so this eager unlock plays the music
// immediately. In a plain browser autoplay is blocked until a gesture, so we also
// retry on the first pointer/key interaction.
const unlockAudio = (): void => {
  audio.unlock();
  sfx.unlock();
};
unlockAudio();
window.addEventListener("pointerdown", unlockAudio, { capture: true, once: true });
window.addEventListener("keydown", unlockAudio, { capture: true, once: true });

const menuEl = document.getElementById("menu")!;
const victoryEl = document.getElementById("victory")!;
const countEl = document.getElementById("count")!;
let started = false;
let won = false;
let inCombat = false;
let lastAttack = -999;
const COMBAT_TAIL = 12; // seconds of calm after the last attack before the meadow theme returns

document.getElementById("start-btn")!.addEventListener("click", () => {
  if (started) return;
  started = true;
  menuEl.classList.add("hidden");
  controls.autoRotate = false; // hand the camera over to the player (WASD + orbit)
  audio.play("meadow");
});
document.getElementById("replay-btn")!.addEventListener("click", () => location.reload());
window.addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") sfx.setMuted(audio.toggleMute());
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xfbe0ef);
// Thin exponential haze tinted to the sky's horizon: the meadow + midground
// stay crisp and the destruction reads clearly; only the far terrain edge
// dissolves softly into the sky colour.
scene.fog = new THREE.FogExp2(0xf3dcec, 0.0016);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.5,
  2000,
);
camera.position.set(30, 17, 44);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false; // instant 1:1 response — no coast/glide after release
controls.target.set(0, 3, 0);
controls.minDistance = 14;
controls.maxDistance = 130;
controls.maxPolarAngle = Math.PI * 0.495;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.3;
// Left button is meteor-only: disable left-orbit entirely so a quick tap — or a
// press the meteor system ignores (e.g. while the orb pool is momentarily
// exhausted) — can never fall through to OrbitControls and rotate the camera.
// Orbit lives on the right-drag; scroll-wheel zoom is unaffected.
controls.mouseButtons.LEFT = null;
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;

// ---------------------------------------------------------------------------
// WASD / QE free camera: pan the whole orbit rig (camera + target together)
// across the meadow, relative to where you're looking. Right-drag orbit and
// scroll zoom still work on top of it. Hold Shift to sprint.
// ---------------------------------------------------------------------------
const heldKeys = new Set<string>();
const MOVE_KEYS = new Set(["w", "a", "s", "d", "q", "e", "shift"]);
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.has(k)) heldKeys.add(k);
});
window.addEventListener("keyup", (e) => heldKeys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => heldKeys.clear());

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _camFwd = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camMove = new THREE.Vector3();
const MOVE_SPEED = 26; // units/sec
const MOVE_BOOST = 2.4; // Shift multiplier
const CAMERA_GROUND_MARGIN = 3; // keep the camera at least this far above the terrain

function updateCameraMovement(dt: number): void {
  if (!started || heldKeys.size === 0) return;
  let f = 0;
  let r = 0;
  let up = 0;
  if (heldKeys.has("w")) f += 1;
  if (heldKeys.has("s")) f -= 1;
  if (heldKeys.has("d")) r += 1;
  if (heldKeys.has("a")) r -= 1;
  if (heldKeys.has("e")) up += 1;
  if (heldKeys.has("q")) up -= 1;
  if (f === 0 && r === 0 && up === 0) return;

  camera.getWorldDirection(_camFwd);
  _camFwd.y = 0;
  if (_camFwd.lengthSq() < 1e-6) _camFwd.set(0, 0, -1);
  _camFwd.normalize();
  _camRight.crossVectors(_camFwd, WORLD_UP).normalize();

  _camMove.set(0, 0, 0).addScaledVector(_camFwd, f).addScaledVector(_camRight, r);
  if (_camMove.lengthSq() > 1e-6) _camMove.normalize(); // keep diagonal speed even
  _camMove.y = up;
  _camMove.multiplyScalar(MOVE_SPEED * (heldKeys.has("shift") ? MOVE_BOOST : 1) * dt);

  camera.position.add(_camMove);
  controls.target.add(_camMove);
  clampCameraAboveGround();
}

// Keep the camera above the terrain it flies over. WASD, orbit, and dolly can all
// push it under the ground; this is the single authority that lifts it back. The
// orbit target rises by the same amount so OrbitControls keeps its angle + zoom
// (the camera-to-target offset is unchanged) instead of fighting the correction.
function clampCameraAboveGround(): void {
  const minY = terrainHeight(camera.position.x, camera.position.z) + CAMERA_GROUND_MARGIN;
  if (camera.position.y < minY) {
    const lift = minY - camera.position.y;
    camera.position.y += lift;
    controls.target.y += lift;
  }
}

// ---------------------------------------------------------------------------
// Sky dome (pastel gradient)
// ---------------------------------------------------------------------------
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(800, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x7ec4ff) },
      bottom: { value: new THREE.Color(0xffd9ec) },
      offset: { value: 120 },
      exponent: { value: 0.7 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 bottom;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld + vec3(0.0, offset, 0.0)).y;
        float t = pow(max(h, 0.0), exponent);
        gl_FragColor = vec4(mix(bottom, top, t), 1.0);
      }
    `,
  }),
);
scene.add(sky);

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x6f9248, 0.9));
scene.add(new THREE.AmbientLight(0xffffff, 0.22));

const sun = new THREE.DirectionalLight(0xfff1d0, 2.4);
sun.position.set(70, 120, 50);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 360;
const shadowExtent = 110;
sun.shadow.camera.left = -shadowExtent;
sun.shadow.camera.right = shadowExtent;
sun.shadow.camera.top = shadowExtent;
sun.shadow.camera.bottom = -shadowExtent;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

// The shadow frustum is a fixed ±shadowExtent box; the camera can fly the whole
// ±120 world, so keep that box centred under the orbit target instead of pinned
// to the origin (props/unicorns at the map edge kept losing their shadows). The
// sun keeps its direction + distance; only the centre slides. Snapping the
// centre to the shadow-map texel grid stops the shadows crawling as you pan.
const sunDir = sun.position.clone().normalize();
const sunDist = sun.position.length();
const WORLD_PER_TEXEL = (2 * shadowExtent) / sun.shadow.mapSize.x;
function updateShadow(): void {
  const sx = Math.round(controls.target.x / WORLD_PER_TEXEL) * WORLD_PER_TEXEL;
  const sz = Math.round(controls.target.z / WORLD_PER_TEXEL) * WORLD_PER_TEXEL;
  sun.target.position.set(sx, 0, sz);
  sun.position.set(sx + sunDir.x * sunDist, sunDir.y * sunDist, sz + sunDir.z * sunDist);
}

// ---------------------------------------------------------------------------
// Terrain + water
// ---------------------------------------------------------------------------
const { mesh: terrain, water, geo: terrainGeo } = buildTerrain();
scene.add(terrain, water);

// ---------------------------------------------------------------------------
// Physics (Rapier): owns the world + static terrain trimesh collider, plus the
// VFX, debris and gib systems (all created before compileAsync so their
// materials + the shared impact light are prewarmed).
// ---------------------------------------------------------------------------
const physics = await initPhysics(scene);
// One shared camera-shake rig: meteor blasts + electric bursts both feed trauma
// into it, and the frame loop applies the single resulting offset.
const cameraShake = new CameraShake();
const vfx = createVfx(scene, cameraShake);
const debris = createDebris(scene, physics);
const gibs = createGibs(scene, physics, vfx);
// Electric water-ball impact VFX (flash, shock ring, splash, crackling bolts).
const electro = createElectro(scene, cameraShake);

// ---------------------------------------------------------------------------
// Meteor: god-hand conjure + fling. handleImpact orchestrates the whole impact:
// crater + scorch, explosion VFX, grass flatten, debris, toppled props, one
// radial impulse, then gibs for any unicorns caught in the blast.
// ---------------------------------------------------------------------------
let simTime = 0;
const _yAxis = new THREE.Vector3(0, 1, 0);
const _toppleQ = new THREE.Quaternion();
const _zapTo = new THREE.Vector3(); // raised target for electrocution bolts
const ELECTRO_POP_RADIUS = 9; // blast size when an electrified unicorn finally bursts

// Knock nearby trees/rocks/bushes loose: hide the instanced copy and replace it
// with a dynamic rigid body (cuboid collider, COM mid-height so it tips) built
// from the same geometry. The radial impulse then sends them tumbling.
function toppleNearbyProps(point: THREE.Vector3, radius: number): void {
  // Scale the topple count with blast size so a big crater doesn't leave props
  // standing in the bowl (the prop cap in physics.ts still bounds live bodies).
  for (const hit of flora.queryProps(point, radius * 0.9, Math.max(6, Math.ceil(radius)))) {
    flora.hideInstance(hit);
    const g = new THREE.Group();
    for (const im of hit.meshes) {
      const m = new THREE.Mesh(im.geometry, im.material);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
    g.scale.set(hit.scale, hit.scale * hit.scaleY, hit.scale);
    g.position.copy(hit.position);
    g.rotation.y = hit.yaw;
    scene.add(g);

    _toppleQ.setFromAxisAngle(_yAxis, hit.yaw);
    const hx = Math.max(hit.size.x * 0.5, 0.2);
    const hy = Math.max(hit.size.y * 0.5, 0.2);
    const hz = Math.max(hit.size.z * 0.5, 0.2);
    const body = physics.world.createRigidBody(
      physics.RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(hit.position.x, hit.position.y, hit.position.z)
        .setRotation({ x: _toppleQ.x, y: _toppleQ.y, z: _toppleQ.z, w: _toppleQ.w })
        .setLinearDamping(0.2)
        .setAngularDamping(0.4),
    );
    physics.world.createCollider(
      physics.RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(0, hy, 0)
        .setDensity(hit.group.kind === "rock" ? 2.5 : 0.5)
        .setFriction(0.9)
        .setRestitution(0.05),
      body,
    );
    physics.add({
      body,
      object: g,
      kind: "prop",
      bornAt: simTime,
      maxLife: 16,
      fade: 2.5,
      onExpire: () => scene.remove(g),
    });
  }
}

// Update the herd tally + fire the victory state once nothing is left (counts
// both the roaming herd and unicorns still mid-electrocution). Called after a
// meteor kill and after each electric explosion resolves.
function refreshHerd(): void {
  const remaining = herd.aliveCount();
  countEl.textContent = `🦄 × ${remaining}`;
  if (started && !won && remaining === 0) {
    won = true;
    inCombat = false;
    audio.play("victory", 1.4);
    victoryEl.classList.remove("hidden");
  }
}

function handleImpact(point: THREE.Vector3, _velocity: THREE.Vector3, radius: number, kind: WeaponKind): void {
  if (kind === "waterball") {
    // Electric water ball: a splashy electric burst. Unicorns in range don't die
    // instantly — they're left STANDING + electrified (herd.electrocuteAt),
    // convulsing for a couple of seconds before they blow apart (resolved in the
    // frame loop). No crater; just a wet, electrified ground mark + gentle shock.
    electro.spawnBurst(point, radius);
    flora.setImpact(point, radius * 1.1, 1, simTime); // shock flattens grass (not scorched away)
    vfx.spawnDecal(point, radius * 1.7, vfx.scorchTexture, 0x123a4a, 0.45);
    physics.applyRadialImpulse(point, radius, radius * 0.7);
    const hits = herd.electrocuteAt(point, radius);
    for (const p of hits) electro.zap(point, _zapTo.set(p.x, p.y + 1.5, p.z));
    sfx.electro(radius, hits.length > 0);
    if (hits.length) sfx.scream(hits.length); // panicked horse screams as they're fried
  } else {
    // Meteor: molten impact — crater + scorch, fireball, debris, toppled props,
    // a strong blast impulse, and a gory shatter for anything caught in it.
    carveCrater(terrainGeo, point.x, point.z, radius * 0.55, radius * 0.3);
    // Re-drape any existing scorch/blood onto the fresh bowl before the new
    // scorch is projected below (crater bowl radius × the carve reach factor).
    vfx.conformDecals(point.x, point.z, radius * 0.55 * 1.3);
    vfx.spawnExplosion(point, radius); // scorch projects onto the carved crater
    flora.setImpact(point, radius * 1.15, 1, simTime);
    // Strip the grass + ground cover out of the scorched bowl so the crater reads
    // as bare, blasted ground (instances inside the wider ring still flatten +
    // spring back; flowers/mushrooms have no spring-back, so they're removed).
    flora.clearGrassAt(point, radius * 0.95);
    flora.clearDecoAt(point, radius * 0.95);
    debris.spawn(point, radius, simTime);
    toppleNearbyProps(point, radius);
    // One radial impulse kicks the debris + freshly toppled props outward.
    physics.applyRadialImpulse(point, radius, radius * 1.3);
    // Gib any unicorns caught in the blast (spawned after the impulse so their
    // chunks keep their own contained burst velocity).
    const killed = herd.killAt(point, radius);
    if (killed.length) {
      const parts = herd.getHorsePartsForGibs();
      for (const k of killed) gibs.spawn(k, parts, point, radius, simTime);
    }
    // Impact sound: a unicorn kill uses the reserved blood clip; bare ground uses
    // a generic boom. Fired here (after the kill check) so we know which to play.
    sfx.explosion(radius, killed.length > 0);
  }

  // Meteor kills drop the tally now; the water ball's doomed unicorns stay
  // counted until they actually explode (handled in the frame loop).
  refreshHerd();

  // Any impact that didn't just win the game ignites "Shattered Hoof Frenzy".
  if (started && !won) {
    lastAttack = simTime;
    inCombat = true;
    audio.play("frenzy", 0.6); // quick punch-in so it hits with the blast
  }
}

const meteors = await createMeteorSystem({
  scene,
  camera,
  controls,
  physics,
  domElement: renderer.domElement,
  onImpact: handleImpact,
});

// ---------------------------------------------------------------------------
// Weapon switcher: top-center buttons (and number keys 1/2) pick which
// projectile the god-hand hurls — the molten meteor or the electric water ball.
// ---------------------------------------------------------------------------
const weaponMeteorBtn = document.getElementById("weapon-meteor")!;
const weaponWaterBtn = document.getElementById("weapon-water")!;
function setWeapon(kind: WeaponKind): void {
  meteors.setWeapon(kind);
  weaponMeteorBtn.classList.toggle("active", kind === "meteor");
  weaponWaterBtn.classList.toggle("active", kind === "waterball");
}
weaponMeteorBtn.addEventListener("click", () => setWeapon("meteor"));
weaponWaterBtn.addEventListener("click", () => setWeapon("waterball"));
window.addEventListener("keydown", (e) => {
  if (e.key === "1") setWeapon("meteor");
  else if (e.key === "2") setWeapon("waterball");
});

// ---------------------------------------------------------------------------
// Flora: imported Kenney models (trees, bushes, rocks, grass, flowers, etc.)
// ---------------------------------------------------------------------------
const flora = await populateFlora(scene);

// ---------------------------------------------------------------------------
// Ambience: rainbow arc, drifting clouds, sparkle motes, fluttering butterflies.
// ---------------------------------------------------------------------------
const ambience = createAmbience(scene);

// ---------------------------------------------------------------------------
// Unicorns (imported animated horse + gold horn)
// ---------------------------------------------------------------------------
const herd = await createHerd(scene, 14);
countEl.textContent = `🦄 × ${herd.aliveCount()}`;

// ---------------------------------------------------------------------------
// Post-processing: bloom so the explosion, embers, horn and rainbow glow.
// RenderPass writes linear HDR into the composer target (the renderer skips
// per-material tone mapping when drawing to a render target); OutputPass applies
// ACESFilmic + exposure + sRGB last, so brightness matches the pre-bloom look.
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.6, // strength
  0.5, // radius
  0.85, // threshold
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
// Pre-compile every material up front so panning the camera doesn't hitch
// when new objects first enter the view frustum and their shaders compile.
await renderer.compileAsync(scene, camera);
// Compile the post-processing shaders too, so the first interactive frame
// doesn't hitch when the bloom/output programs link.
composer.render();

const clock = new THREE.Clock();
const shakeOffset = new THREE.Vector3();

function frame(): void {
  // Advance game time by the CLAMPED delta, not clock.elapsedTime: when the tab
  // is backgrounded, rAF pauses but wall-clock keeps running, so elapsedTime
  // would leap forward on return and instantly expire every airborne meteor,
  // debris chunk and gib (and drop combat music). Game time can't outrun 0.1s
  // per frame, so returning to the tab resumes cleanly.
  const dt = Math.min(clock.getDelta(), 0.1);
  simTime += dt;
  const t = simTime;

  // Combat cools off: after a calm stretch with no new attacks, drift the
  // frenzy theme back down to the peaceful meadow ambience.
  if (inCombat && !won && t - lastAttack > COMBAT_TAIL) {
    inCombat = false;
    audio.play("meadow", 2.5);
  }

  // Water ripples (displaced on the GPU; just advance the shared time uniform).
  waterTime.value = t;

  // Grass + flowers sway in the wind; camera position drives grass distance cull.
  flora.update(t, camera.position);

  // Rainbow, clouds, sparkles + butterflies.
  ambience.update(dt, t);

  // Roam the herd + advance electrocutions; any unicorn that finished convulsing
  // bursts now into a final electric blast + charred gibs.
  const exploded = herd.update(dt, t);
  if (exploded.length) {
    const parts = herd.getHorsePartsForGibs();
    for (const k of exploded) {
      electro.spawnBurst(k.position, ELECTRO_POP_RADIUS);
      gibs.spawn(k, parts, k.position, ELECTRO_POP_RADIUS, t, "electro");
    }
    sfx.electro(ELECTRO_POP_RADIUS, true);
    refreshHerd();
  }
  // Crackle arcs over every unicorn still standing electrified + drive the soft
  // looping spark sound for as long as any are convulsing.
  let electrified = 0;
  herd.forEachElectrified((x, y, z, h) => { electro.crackle(x, y, z, h); electrified++; });
  sfx.electrifyLoop(electrified);

  physics.step(dt, t);
  meteors.update(dt, t);
  vfx.update(dt, t);
  electro.update(dt, t);
  gibs.update(dt);

  updateCameraMovement(dt);
  controls.update();
  // Hard floor every frame: orbit + scroll-zoom can drive the camera below the
  // terrain even when WASD isn't touching it, so clamp after controls.update().
  clampCameraAboveGround();
  // Slide the shadow frustum to follow wherever we're looking.
  updateShadow();
  // Apply camera shake as a transient offset around the render only (meteor
  // blasts + electric bursts feed one shared trauma pool).
  cameraShake.update(dt, t);
  cameraShake.getOffset(shakeOffset);
  camera.position.add(shakeOffset);
  composer.render();
  camera.position.sub(shakeOffset);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
