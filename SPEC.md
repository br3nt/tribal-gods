# Tribal Gods — a browser god game

A from-scratch, browser-based real-time god game about a small round world, a
leader who casts, and a tribe that grows. Every system is hand-built in
readable, heavily commented TypeScript so the codebase doubles as a course in
how real-time 3D games work.

> **Originality note:** Tribal Gods shares a genre with other god games and
> nothing else. All code, models, textures, animations, sounds, names, levels
> and interface are original creations (or CC0).

---

## 1. Vision & pillars

1. **The world is the toy.** Terrain is a living thing you reshape with god
   powers. Raising a causeway or detonating a volcano must feel chunky,
   physical, and a little gleeful.
2. **A planet, not a map.** The world wraps in every direction and the horizon
   visibly curves away. There is no edge.
3. **One leader who matters.** Your tribe's leader (the Grove-Speaker,
   God-King or Far-Seer, by civilisation) is a unit you steer directly — the
   most important figure on screen, and the conduit for every spell.
4. **Readable code over clever code.** Anyone should be able to open any file
   and follow it. Comments explain *why* and *how the technique works*, not
   just what the line does.
5. **Hand-painted feel.** Chunky, simple shapes, painted-style textures,
   snappy unit animations, an orbiting camera. (Superseded in part by §11.1:
   the look is stylised and modern.)

## 2. Stack

| Concern        | Choice                          | Why |
|----------------|---------------------------------|-----|
| Rendering      | Three.js                        | Thin layer over WebGL; we keep ownership of all the interesting math |
| Language       | TypeScript                      | Types document the domain (Tile, Spell, Follower are explicit shapes) |
| Build/dev      | Vite                            | Instant hot reload, zero config |
| Assets         | Procedural, built in code       | True to the low-poly look; every model is readable source |
| Audio          | Web Audio API + CC0 samples     | Kenney.nl / freesound CC0 where synthesis won't do |
| Testing        | Vitest for sim logic; manual + browser automation for feel | Game logic is deterministic and unit-testable |

No game engine. The engine *is* the lesson.

## 3. The world model (the core trick)

### 3.1 Heightmap on a torus

The planet is a **flat 2D heightmap**: a `WORLD_SIZE × WORLD_SIZE` grid
(start at 128×128) of height values, **wrapping at both edges**. Walk off the
east edge, arrive at the west edge. Topologically it's a donut; visually we
sell it as a sphere (see 3.2).

```ts
// All world-space lookups go through wrap() — this single function
// is what makes the planet "round".
const wrap = (i: number) => ((i % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
heightAt(x, z) => heights[wrap(z) * WORLD_SIZE + wrap(x)]
```

- Heights are floats; **sea level is 0**. Below 0 = water (impassable).
- The render mesh is a grid of vertices displaced by the heightmap. When
  heights change, we update vertex positions + normals in place (no mesh
  rebuild) and re-upload the buffer.
- Because the camera only ever sees a portion of the world, we render a
  **scrolling window** of terrain centered on the camera target, sampling the
  wrapped heightmap. This also avoids drawing the whole
  world.

### 3.2 The curvature illusion

The "round planet" is a vertex transform, not geometry: in the terrain (and
unit) vertex shader, every vertex is pulled **downward proportional to the
squared distance from the camera target**.

```glsl
// The entire planet illusion is this line:
pos.y -= CURVATURE * dot(toTarget.xz, toTarget.xz);
```

Land falls away at the horizon in every direction → reads as a small planet.
`CURVATURE` is a tunable constant; we'll expose it in a debug panel.

### 3.3 Terrain deformation

Every god power is an edit to the heights array over time:

| Operation  | Implementation |
|------------|----------------|
| Raise/Lower | Add a smooth radial falloff (cosine kernel) to heights in a radius |
| Flatten    | Lerp heights in radius toward their average over ~0.5s |
| Causeway   | Raise heights above sea level along a line between two points |
| Volcano    | Animate a cone bulging up over ~4s, crater at the top, ejecta |
| Earthquake | Apply ridged noise along a random fault line through target |
| Mire       | Mark tiles as swamp (terrain *type* edit, not height) |
| Erosion (passive) | Optional: steep land near water slowly slumps |

Deformations run as **timed jobs** in the sim (so a volcano *grows*), and any
follower/building standing on affected tiles reacts (buildings on non-flat
land collapse; units fall into water and drown).

### 3.4 Terrain appearance

Single texture atlas or vertex-color splat by **height and slope**: beach near
sea level, grass on flats, rock on steep slopes, snow optional. Water is a
flat translucent plane at y=0 with a scrolling normal/uv offset. Painted,
saturated palette — aim for a storybook look, not realism.

## 4. Characters & animation

### 4.1 Models — procedural low-poly

Every unit/building is assembled in code from primitives (boxes, cylinders,
cones) into a hierarchy of named parts — `assets/models/shaman.ts` reads like
a recipe:

```ts
// torso: squat box, slightly tapered. The silhouette IS the character.
// head: sphere at 8 segments — chunky on purpose.
// staff: thin cylinder + glowing orb (emissive material).
```

- Target budget: **< 150 triangles per unit**, < 400 per building. Constraints
  are the aesthetic.
- **Team color**: one designated material per model tinted by tribe
  (player blue; enemy red first, then yellow/green tribes).
- Buildings get 2–3 construction stages (stakes → frame → done).

### 4.2 Animation — procedural keyframes

Like classic vertex keyframes, but on part hierarchies: each clip is a
small pure function `(t: number, parts) => void` that poses the model's parts
(rotate arms, bob torso) from normalized time `t`. Clips: idle, walk, run,
attack, cast, celebrate, drown, die. Walk cycles sync to actual movement speed
so feet don't skate. A tiny crossfade blender transitions between clips.

This keeps animation 100% readable and tweakable — no opaque binary clips.

### 4.3 Crowds

Hundreds of followers must be cheap: shared geometry, per-instance transforms,
and animation LOD (far-away units animate at lower rate). Start simple
(one mesh per unit), optimize with InstancedMesh only when profiling says so.

## 5. Camera & controls

- **Orbit camera**: looks at a target point on the terrain; rotate around it
  (Q/E or middle-drag), zoom (wheel) between near (street level-ish) and far
  (planet view), pitch tied to zoom. Edge-of-screen + WASD panning. The target
  point is what the curvature shader bends the world around.
- **Mouse**: left-click select / cast at cursor; drag = band select; right-click
  = move/attack command. Hotkeys 1–8 for spells, space to center on the leader.
- A **minimap** (top-down render of the wrapped heightmap + unit dots) that
  understands wrapping — clicking it jumps the camera.

## 6. Simulation

Deterministic fixed-tick sim (10–20 Hz) decoupled from rendering
(interpolated). All gameplay state lives in plain data (`World`), mutated by
systems in a fixed order each tick. Renderer reads, never writes. This split
is non-negotiable — it's what makes the logic testable and the code legible.

### 6.1 Followers

The shipped roster, names and numbers live in `src/sim/catalog.ts` (§11).

| Type        | Role |
|-------------|------|
| Villager    | Default. Builds, chops wood, populates dwellings, weak in a fight |
| Warrior     | Melee bruiser. Trained at the War Lodge (costs a villager + wood) |
| Emberthrower | Ranged attacker that hurls burning pitch. Trained at the Ember Lodge |
| Chanter     | Unarmed; enemies who hear the chant stop fighting and in time change sides |
| Warden      | Slow, heavily shielded building-wrecker |
| **Leader**  | Player-steered hero; casts all spells; returns to the home circle after a delay if killed |

Behavior = small state machines (idle → tasked → moving → working/fighting).
Idle villagers auto-assign: build sites first, then dwelling occupancy, then wander.

### 6.2 Pathfinding

A* over the wrapped tile grid. Water and too-steep slopes are impassable;
mild slope adds cost. Paths smooth with string-pulling. **Terrain edits dirty
cached paths** — a causeway instantly opens routes; a blast can strand units.
This terrain↔pathfinding coupling is the heart of the game and gets its own
well-commented module.

### 6.3 Settlement & economy

- **Wood**: villagers chop trees (trees regrow slowly), carried to build sites.
- **Huts**: built on flat land (auto-flatten by builders within tolerance);
  house followers; housed population slowly **breeds new villagers** (capped) and
  is the **mana engine**.
- **Mana**: regenerates at a rate driven by housed + total population. One
  shared pool; each spell has a cost and an independent **charge count**
  (spells store limited charges, recharging from mana over time) — gives
  the game its rhythm of "save up the big one".
- **Guard towers**: garrison fighters (up to two), extend sight, shoot.

### 6.4 Spells (v1 set)

| Spell      | Cost | Effect |
|------------|------|--------|
| Blast      | low  | Knockback + damage + small crater at point |
| Kindle     | low  | Wanderers (unaligned) in the circle join the tribe |
| Lightning  | med  | Bolt strikes target; chains briefly; sets fires |
| Mire       | med  | Patch of tiles becomes swamp; units that enter sink & die; expires |
| Causeway   | med  | Raise a land strip between cast point and direction |
| Flatten    | med  | Level terrain in radius (also the building enabler) |
| Earthquake | high | Fault line rips through area; cracks, collapses buildings |
| Volcano    | high | The showstopper. Cone erupts over seconds, lava damage, permanent terrain |

The shipped spell book (v2: Stone Ward, Warsong, Cyclone, Emberfall,
Undertow, Bloom and the rest) is in `src/sim/catalog.ts`. Spells are
learned or lent at **standing stones** the leader communes with.

### 6.5 Combat

Simple and readable: HP, attack damage/range/cooldown, type counters (warriors
beat villagers, Emberthrowers kite melee, towers beat unsupported attacks). Deaths
spawn a tiny ghost/ascending-soul effect. No friendly fire from units; spells
hurt everyone (lava doesn't care whose tribe you are — important for comedy).

### 6.6 Enemy tribe AI (skirmish)

A utility-scored state machine, not a black box: **Grow** (build huts/army) →
**Harass** (raid with small squads) → **Assault** (army + leader pushes) →
**Defend** (regroup when hurt). The enemy leader casts from the same spell system
under per-difficulty cooldown multipliers. AI state is shown in a debug
overlay so you can watch it think.

### 6.7 Win/lose

Win: every enemy follower and their leader are dead (respawn stones destroyed).
Lose: mirror condition. Game-over fly-around of the planet either way.

## 7. UI

- **HUD**: mana bar, population count, wood, selected-unit panel.
- **Spell panel**: ring/row of icons with charge pips + recharge sweep.
- **Build panel**: hut, guard tower, War Lodge, Ember Lodge + footprint
  ghost (green = flat enough, red = no).
- **Minimap** with wrap-aware scrolling.
- Diegetic feedback first: sounds, animation, terrain motion over text popups.

## 8. Code architecture

```
src/
  main.ts                 // boot: create world, renderer, UI, start loops
  config.ts               // every tunable constant, commented
  core/                   // math, RNG (seeded), event bus, fixed-tick loop
  world/
    heightmap.ts          // the wrapped height grid + edit kernels  ← start here
    terrain-mesh.ts       // heightmap → Three.js geometry, live updates
    curvature.glsl.ts     // the planet-bending vertex shader chunk
    water.ts, trees.ts, pathfinding.ts
  sim/
    world-state.ts        // THE game state: all plain data
    followers/            // unit defs, state machines, combat
    buildings/, spells/   // one file per spell — each a mini-lesson
    economy.ts, ai/
  render/                 // scene, camera rig, model registry, animation player, effects
  assets/
    models/               // procedural model recipes (shaman.ts, hut.ts, …)
    sounds/
  ui/                     // HUD, panels, minimap, input mapping
  debug/                  // free-camera, AI inspector, curvature/terrain tuners
```

### Commenting standard (the whole point)

- Every module opens with a **prose header**: what this system does, the
  technique it uses, and why this approach (incl. the simpler alternative we passed over).
- Non-obvious math gets a derivation comment, sometimes ASCII diagrams.
- `config.ts` documents what each constant *feels like* when you change it.
- Code favors clarity over micro-optimization until profiling demands it.

## 9. Roadmap

Each phase ends **playable** with explicit acceptance criteria.

**Phase 0 — Scaffold.** Vite + TS + Three.js; spinning placeholder cube; fixed-tick
loop with FPS/tick debug readout. *✓ `npm run dev` shows a stable render loop.*

**Phase 1 — The planet.** Wrapped heightmap, live-updating terrain mesh,
curvature shader, water plane, height/slope coloring, orbit camera, scrolling
terrain window. Debug brush: raise/lower/flatten with the mouse.
*✓ You can sculpt a little world, spin around it, and the horizon curves away.
This is the "it feels like a planet" gate — we don't pass it until it does.*

**Phase 2 — Life.** Procedural villager + leader models, procedural walk/idle
clips, A* pathfinding, selection + move orders, wanderers roaming, trees.
*✓ March a crowd across a causeway you just raised.*

**Phase 3 — Settlement.** Wood, build orders, construction stages, dwellings breeding
villagers, mana from population, HUD. *✓ A village that grows on its own.*

**Phase 4 — God powers.** The v1 spell set with charges/recharge, terrain
deformation jobs, units & buildings reacting (drowning, collapse), spell
panel, sounds. *✓ Volcano under your own village = horrified delight.*

**Phase 5 — War.** Warriors, Emberthrowers, towers, combat, training buildings,
enemy tribe with AI leader, minimap, win/lose, one tuned skirmish map.
*✓ A full skirmish is winnable and losable in 20–40 minutes.*

**Phase 6+ (backlog).** Standing stones + spell unlocks, a campaign with
briefings, more unit kinds, ways across water, fog of war, save/load,
performance pass (instancing), juice pass (screenshake, particles).

## 10. Definition of "feels like Tribal Gods"

Checked at every phase: horizon curvature always visible at medium zoom ·
terrain edits animate over time, never snap · people are readable and have
personality, even up close · palette saturated and warm · spell impacts slightly over-the-top ·
camera spin around your village is *pleasant* for no reason at all.


---

## 11. The v2 overhaul (supersedes anything above that disagrees)

The first build proved the planet. It did not make a game people want to
play: figures and buildings were specks, the characters were stacked boxes,
the HUD was debug text, and spells were a row of emoji with a number. v2
fixes that. **`src/sim/catalog.ts` is the binding contract** for content and
for the surface between sim, renderer and UI — read it first.

### 11.1 Pillars, revised

- **Its own game.** Tribal Gods shares a genre with the late-90s god games —
  a small round world, a leader who casts, a tribe that grows — and nothing
  else. Roster, spell book, scenarios, art and interface are original. Never
  copy another game's levels, characters, names, icons or screen layout.
- **Made today.** Drop "true to 1998" and the "< 150 triangles" budget.
  Target: a stylised, hand-crafted look with modern rendering — soft
  shadows, physically based materials, tone mapping, atmosphere, depth,
  animated water with shoreline foam, wind in the trees, particles with
  weight. Stylised, not photoreal; rich, not flat-shaded boxes.
- **People you can see.** Drop "units are small against the world". A
  villager is ~2.3 world units tall (a tile is 2), a dwelling fills 3×3
  tiles, a hall 5×5. At the default zoom you can tell a Warrior from an
  Emberthrower from a Chanter by silhouette alone, and see what each
  villager is doing.
- **Characters with character.** Rounded, proportioned bodies with real
  silhouettes (head, neck, shoulders, hands, feet, hair, clothing layers,
  gear), blended animation clips with anticipation and follow-through, and
  a leader per civilisation who is unmistakably the most important figure
  on screen.
- **An interface designed as a whole.** One coherent, modern HUD: resources
  and population, objectives, a spell book grouped by tier with charge pips
  and recharge sweeps, a build menu with requirements, a selection panel
  with portraits/health/orders/training queue, a framed minimap, alerts,
  tooltips everywhere, hotkeys shown on the controls. No debug text in the
  player's view (debug lives behind a key).
- **Depth through limits.** Spells charge from mana and hold a limited
  number of casts (the charge model in catalog.ts). Buildings have
  prerequisites. Dwellings grow in tiers. Units are trained from villagers
  through queues. Scenarios restrict and grant: what you know, what you may
  build, what the stones teach or lend.
- **Scenarios, not just skirmish.** A campaign of original, hand-designed
  scenarios with briefings, varied objectives, fail conditions, up to three
  rival tribes, and unlocks that carry forward.

### 11.2 Ownership map (who edits what)

| Area | Files |
|---|---|
| Sim | `src/sim/**` (except catalog.ts structure), gameplay section of `src/config.ts`, `test/**` |
| Look | `src/main.ts` scene/renderer setup, `src/world/**`, `src/render/effects.ts`, `src/render/camera-rig.ts`, new `src/render/{sky,post,lighting,look}.ts` |
| Models | `src/assets/models/**`, `src/render/{unit,building,tree}-renderer.ts`, `src/render/figure-animator.ts` |
| UI | `src/ui/**`, `index.html`, UI wiring in `src/main.ts` |
| Campaign | `src/level/**`, `src/sim/objectives.ts`, campaign screens under `src/ui/campaign*.ts` |

Visual constants go in `src/render/look.ts`, not `config.ts`. Gameplay
numbers come from `catalog.ts`; the old per-kind tables in `config.ts`
(`COMBAT`, `UNIT_SPEED`, `BUILD_COSTS`, `TRAIN_COSTS`, …) are retired.

### 11.3 Working rules

- Branch from `develop`, small commits, rebase on `develop` often.
- Sim changes are test-first with Vitest (`npm test`); the sim stays
  headless (no three.js, no DOM).
- Visual and UI work is checked by eye: `tools/shot.mjs` takes headless
  screenshots (`?play=1&seed=N` skips the menu; `window.__tg` is the
  automation handle). Look at your own screenshots before calling it done.
- `npm run build` (type-check + bundle) must pass.
