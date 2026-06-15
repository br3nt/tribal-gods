# Tribal Gods

A Populous: The Beginning–style god game, built from scratch in TypeScript +
Three.js. No game engine — terrain, animation, camera, and simulation are all
hand-built and heavily commented. The full design and roadmap live in
[SPEC.md](SPEC.md).

![A small curved planet with coastlines — the signature Populous "little world" look](docs/hero.png)

> **▶ [Play it in your browser](https://br3nt.github.io/tribal-gods/)**

This whole project — design, code, art, sound, and the in-browser play-testing —
was built collaboratively with **Claude Fable 5** over a series of conversations.
It's an experiment in how far a model can carry a real-time 3D game from a blank
folder to a finished, shareable thing. Write-up:
[br3nt's blog](https://br3nt.github.io/).

*Mechanics and aesthetic are an homage to Bullfrog's 1998 classic; every asset
here (models, textures, sounds) is original or procedurally generated. "Populous"
is a trademark of Electronic Arts — this fan project is not affiliated with EA.*

## Run it

```sh
npm install
npm run dev     # then open the printed localhost URL
```

## Controls (Phase 5: war)

| Input | Action |
|---|---|
| 1 | Select tool — click a follower or drag a box |
| Right-click | Move the selected — or attack, if you clicked an enemy |
| 2 | Hut (costs wood) |
| T / Y / U | Warrior hut / Firewarrior hut / Guard tower |
| 3–9, 0 | Spells: Blast, Convert, Lightning, Swamp, Landbridge, Flatten, Quake, **Volcano** |
| Left-click (spell armed) | The Shaman walks into range and casts it there |
| Minimap click | Jump the camera anywhere on the planet |
| - / = | Debug sculpt brush (raise / lower) · [ ] size |
| W A S D · Q / E · wheel | Pan · rotate · zoom |
| Esc | Back to select tool |
| R | Generate a new planet |

**Skirmish setup:** on load (or key M), pick a civilization — Forest Tribe,
River Dynasty, or Northmen. Civs are themes (leader regalia +
architecture); the simulation is identical for all. Then pick a
difficulty, which tunes only the enemy AI's decision tempo and head start.

**The knowledge race:** you start knowing only Blast and Convert. The
other six spells live inside ancient stone-head monuments (gold diamonds
on the minimap, glowing eyes in the world). Right-click one with your
leader selected and they'll walk over and worship for a few seconds —
first tribe to commune keeps the spell forever. The apocalyptic spells
(Quake, Volcano) are placed far from both homes, on neutral ground. The
red god races you for them.

There is a red tribe on the other side of the planet, and it wants yours
gone. It runs the same economy you do (no cheats — same buildings, same
wood, same mana, same monuments, same shaman rules), steered by a
four-state AI: grow, harass, assault, defend. Watch its current mood in
the debug panel.

Training huts draft idle braves automatically (warriors melee, firewarriors
shoot, towers are firewarriors wearing architecture). Win by erasing the
red tribe — every follower and every building; their shaman stops coming
back when nothing of theirs remains. They will be trying to do the same
to you, and they are patient.

All sound is synthesized live with the Web Audio API — see
`src/core/audio.ts` for the explosion/zap/rumble recipes.

## Levels, the editor, and sharing

The title screen has three doors: **Skirmish** (a random planet), **Levels**
(the library), and **Editor**.

**The library** holds three official levels — *First Light* (a gentle
introduction), *The Strait* (two tribes split by an ocean; Landbridge is on
your shore), and *The Crucible* (one continent, one central volcano, no plan
B) — plus every level you save or import. Search, filter by your star
rating, and sort. Stars are yours and persist locally.

**The editor** (key M → Editor, or *edit* any level) is the game world with
the simulation frozen: sculpt terrain with the same brushes, place both
tribes' homes, drop monuments (click the monument tool again to cycle which
spell the stone holds), scatter trees and wildmen. *Test* play-tests
instantly and *↩ back to editor* returns with the terrain pristine. *Save*
files it to your library.

**Sharing** is by code, like Factorio blueprints: *code* copies a `TG1.…`
string to your clipboard (the whole planet, compressed — terrain is
delta-encoded then deflated then base64'd, a few KB of pasteable text).
*Import code* in the library turns a friend's string back into a playable
level. The storage layer (`src/level/store.ts`) is deliberately shaped so a
real online level-sharing server could replace localStorage without the UI
noticing — that's the seam where a community hub would attach.

Try the signature move: select your tribe, raise a landbridge across a
strait with the raise tool, then right-click the far shore — pathfinding
runs on the same grid as the terrain, so the route exists the moment the
land does.

Pan in one direction long enough and you'll arrive back where you started —
the world wraps. The horizon curvature is a rendering trick; start reading at
`src/world/heightmap.ts` and `src/world/curvature.ts` to see how the whole
planet illusion works.

## Where the code lessons are

Every module opens with a prose header explaining the technique it implements
and how the 1998 original did it. Suggested reading order is in
`src/main.ts`. All tunable constants (curvature strength, palette, brush
feel) are documented in `src/config.ts` — change them and watch.
