---
layout: default
title: The spec
---

# Landstalker 3D — Project Specification

**A three.js renderer driven by the original Sega Mega Drive ROM running in an emulator.**

Model: *Diablo II: Resurrected*. The original game remains the authoritative simulation. We replace only the presentation layer. No game logic is reimplemented.

---

## 1. Goal and non-goals

### Goal

Play the complete, unmodified Landstalker from start to finish, rendered as real 3D geometry in three.js at arbitrary resolution and framerate, viewed through the original fixed isometric camera.

### Explicit non-goals

Do not attempt any of these. Each one converts a bounded project into an unbounded one.

- **Do not reimplement game logic.** No combat, no AI, no dialogue, no item handling, no puzzle state, no cutscene scripting, no room transition logic. All of this stays in the ROM.
- **Do not fix the jumping or movement.** Physics lives in the 68000 code. It stays there. Movement will feel exactly like the original. This is accepted.
- **Do not build a free-rotating camera** in v1. The camera is locked to the original projection. (Rotation may be explored later; see §10.)
- **Do not build distribution, onboarding, save management, or settings UI.** This is a personal build served over LAN.
- **Do not modify or redistribute the ROM.** It is read-only input, supplied by the user.

### Definition of done for v1

The user can start a new game, play through the intro, walk around Massan, enter a dungeon, fight an enemy, open a chest, and read dialogue — all rendered in three.js with no emulator framebuffer visible.

---

## 2. Architecture

```
┌──────────────────────────┐
│  Genesis Plus GX (core)  │   authoritative simulation
│  running unmodified ROM  │   68000 + VDP + Z80, 60fps lockstep
└───────────┬──────────────┘
            │ read work RAM each frame (no writes)
            ▼
┌──────────────────────────┐
│   State Bridge           │   room ID, camera, entity table,
│   (RAM → GameState)      │   player pos/anim, fade/shake state
└───────────┬──────────────┘
            │ GameState (plain JS object)
            ▼
┌──────────────────────────┐      ┌─────────────────────────┐
│   three.js Renderer      │◄─────│  Asset Bundle (offline) │
│   geometry + billboards  │      │  rooms, blocksets,      │
└──────────────────────────┘      │  sprites, palettes      │
                                  └─────────────────────────┘
                                        ▲
                                        │ built once, ahead of time
                                  ┌─────┴───────────────────┐
                                  │  Extractor (ROM → IR)   │
                                  └─────────────────────────┘
```

Two independent pipelines meet at runtime:

1. **Offline extraction** — ROM parsed once into an intermediate representation (JSON + PNG atlases). Never runs on device.
2. **Runtime** — emulator produces state, renderer consumes state plus the prebuilt assets.

The emulator's video output is **discarded entirely**. It is a physics and logic server. Audio, however, is passed straight through — no reason to touch it.

---

## 3. Prerequisites

### ROM

The user supplies the ROM. A legally obtainable US ROM ships inside the Steam release of Landstalker as an uncompressed file in the game's `ROMs/` directory (`LandStalker_USA.SGD`).

**Pin one revision.** There are six publicly known dumps and they differ in layout. Target the **US** version, because it is the best-documented and what the reference projects target. Record the SHA-1 of the ROM in `config/rom.json` and hard-fail on mismatch. Do not attempt multi-revision support.

### Reference projects — read these before writing any parsing code

These have already reverse-engineered the formats. Treat them as the specification. Do not rediscover offsets from raw bytes.

| Project | Use for |
|---|---|
| `github.com/lordmir/landstalker_disasm` | Full 68000 disassembly that reassembles byte-identical. **Primary source of truth.** Structure layouts, routine behaviour, data table locations. |
| `github.com/lordmir/landstalker_editor` | C++ parsers for rooms, blocksets, tilesets, palettes, entities, warps. Read its source as a format spec. Also run its GUI to visually verify your own extraction. |
| `github.com/lordmir/landstalker_tools` | Standalone LZ77 compress/decompress CLI. Validate your decompressor against it. |
| `github.com/Dinopony/randstalker` | C++ object model of the game (rooms, entities, items). Cleaner data model than the editor. |
| `github.com/Dinopony/randstalker-archipelago` | **Reads live game state from a running emulator.** Directly relevant to §5 — likely already contains RAM addresses you need. |
| `datacrystal.tcrf.net` — Landstalker ROM map | Community offset documentation. Cross-check. |

> **Note on offsets:** this document deliberately contains no specific ROM addresses or RAM addresses. Any I could supply from memory would be unreliable. Derive every address from the sources above or from live investigation (§5.2), and write each one into `docs/offsets.md` with a note on how it was confirmed.

### Tooling

- Node 20+, Vite, three.js
- Genesis Plus GX — native build with debugging preferred for development; WASM build for the phone target
- Python 3 for the extractor (or C++ if reusing editor code directly — Python is recommended for iteration speed)
- An emulator with a memory viewer and watchpoints for investigation: BlastEm, Exodus, or Gens KMod

---

## 4. Phase 1 — Offline extraction (ROM → IR)

Build `tools/extract.py`. Output goes to `assets/`. This runs once and its output is committed to the working tree (but **not** to any public repo).

### 4.1 Decompression

Landstalker uses a custom **LZ77 variant** for graphics and map data, and **Huffman coding** for text strings. Implement the LZ77 decompressor first and validate it byte-for-byte against `landstalker_tools` output on at least 20 known compressed blocks. This is the foundation — if it is subtly wrong, everything downstream fails in confusing ways.

Text is not needed for v1 rendering (dialogue boxes can initially pass through from the emulator, see §6.4), so Huffman is deferrable.

### 4.2 Palettes

Genesis VDP format: two bytes per colour, layout `0000BBB0GGG0RRR`, three bits per channel. Expand to RGB8 for the atlas. Note that the VDP's shadow/highlight mode affects final on-screen colour in some rooms — flag this and handle it in the shader rather than baking it.

### 4.3 Blocksets and tilesets

The world is built from a reusable library of isometric blocks. Each block is composed of tiles. Extract:

- Tilesets → PNG atlas, indexed, with palette index preserved
- Blocksets → block definitions referencing tile indices, with attributes (priority bit, tile flip flags)

Deduplicate aggressively. The block library is shared across all rooms, so this is a small amount of data.

### 4.4 Room data

For each room, extract:

- **Heightmap / collision grid** — this is the critical structure. It gives the true 3D shape of the room: per-cell floor height, ceiling height, and collision flags. This is what makes the project feasible; the world is genuinely 3D, not painted to look 3D.
- **Two tile layers** (foreground / background) referencing block IDs
- **Room dimensions and origin offset**
- **Palette assignment**
- **Warp/exit table** — where each transition leads
- **Entity table** — the static spawn list: NPCs, enemies, chests, platforms, with x/y/z positions, sprite IDs, and behaviour flags

Emit one JSON file per room plus a manifest. Keep the schema flat and boring.

### 4.5 Sprites

Extract every sprite set: frames, per-frame dimensions, hotspot/anchor offsets, and the animation tables mapping animation ID + frame index → sprite frame. Pack into a texture atlas.

**Anchor offsets matter more than you expect.** A sprite's position in world space is defined relative to a specific pixel in its frame, and getting this wrong makes characters float or sink. Extract the anchors from data; do not eyeball them.

### 4.6 IR schema

```
assets/
  manifest.json          # room index, checksums, extraction version
  rooms/<id>.json        # heightmap, layers, entities, warps, palette ref
  blocks.json            # block ID → tile refs + attributes
  palettes.json
  atlas_tiles.png
  atlas_sprites.png
  sprites.json           # frame rects, anchors, animation tables
```

Version the schema. When the extractor changes, bump it and fail loudly on stale assets.

---

## 5. Phase 2 — RAM interface

This is the phase with genuine unknowns. Budget accordingly.

### 5.1 Emulator integration

Use Genesis Plus GX. Expose a minimal API:

```
init(romBuffer)
runFrame()          -> advances exactly one frame
readRAM(addr, len)  -> Uint8Array
```

Native first (easier debugging, faster iteration), then WASM for the phone. Do **not** write to RAM. Ever. The moment you start poking state you have forked the game and inherited its bugs.

### 5.2 Finding the addresses

Required per frame:

- Current room ID
- Camera / scroll position
- Player: x, y, z, facing, animation ID, animation frame, visibility
- Entity table: fixed-size array of structs — for each slot, x/y/z, sprite ID, animation state, active flag
- Global fade level, screen shake offset, palette overrides
- Game mode (in-game / menu / cutscene / title)

**Method, in order of preference:**

1. **Read `randstalker-archipelago`.** It already reads live state from a running Landstalker for multiworld purposes. Anything it knows, you get for free.
2. **Read the disassembly.** Find the routines that update entity positions and follow their address operands. This is the most reliable method and an agent is very good at it.
3. **Live investigation.** Set a watchpoint, move Nigel one step, diff RAM. Use for anything the first two miss.

Write everything found into `docs/offsets.md` with symbol name, address, size, type, and how it was confirmed. This file is the most valuable artifact of the phase — protect it.

### 5.3 GameState

Normalise into a plain object with sane units. Convert the game's fixed-point coordinates into floats in a consistent world space at the boundary, so nothing downstream ever deals with raw ROM units.

Snapshot it each frame. Keep the previous frame for interpolation (§6.5).

---

## 6. Phase 3 — Renderer

### 6.1 Camera

Orthographic, locked to the original dimetric projection. Derive the exact projection matrix empirically: take one room, solve `screen = f(worldX, worldY, worldZ)` against an emulator screenshot, and verify the fit reproduces the original pixel-exactly before proceeding. Do not assume a textbook 2:1 ratio; confirm it.

Scroll position comes from RAM, so the camera follows exactly as the original does.

### 6.2 Geometry

Build room geometry from the heightmap: one box per cell, greedy-meshed to merge coplanar faces. Texture faces with the block textures at the original resolution.

Because the camera never rotates, only the three visible faces of any block ever matter (top and two sides). Cull the rest at build time.

### 6.3 Sprites

Billboards, camera-facing, positioned by GameState. Use `alphaTest` rather than alpha blending so sprites write depth and sort correctly against geometry with no manual sorting.

Sprite facing is chosen by the game and exposed in the animation ID — read it, do not compute it.

### 6.4 Sort order and UI

The original relies on a specific painter's algorithm plus priority bits. Pure depth-buffer sorting **will** produce seams and incorrect occlusion in places where the art assumes the original order. Use the priority bit from block attributes as a depth bias. Expect to iterate here.

For v1, **render the original HUD, dialogue boxes, and menus by compositing the emulator's framebuffer on top** — masked to just the UI regions. Reimplementing text rendering is a large detour for no gameplay benefit. Do it later if ever.

### 6.5 Frame pacing

The emulator advances in discrete 60Hz steps. To render above 60fps, interpolate entity positions between the previous and current GameState. Do not interpolate discrete values (animation frame, room ID, facing) — snap those.

Run the emulator on a fixed 60Hz accumulator, decoupled from `requestAnimationFrame`.

---

## 7. Test harness — build this early

This is what lets the agent work unsupervised. Build it in Phase 1, not at the end.

**Extraction test:** for each room, render it orthographically at native resolution with no entities, and pixel-diff against a reference screenshot captured from the emulator in the same room. Report per-room match percentage. A correct extractor converges toward near-identical; a broken decompressor shows up instantly as garbage.

Capture reference screenshots by scripting the emulator through a save state per room.

**State test:** record a scripted input sequence, run it through the emulator, and assert GameState fields change as expected (player moves on input, room ID changes on warp, entity count matches the room's spawn table).

**Regression:** both suites run on every change. Room match percentages go in a committed report so drift is visible.

---

## 8. Build order

Do these strictly in sequence. Each has a demonstrable end state.

1. **LZ77 decompressor**, validated byte-exact against `landstalker_tools`.
2. **Palette + tileset + blockset extraction**, verified visually against `landstalker_editor`'s viewer.
3. **One room extracted** — heightmap and layers — and rendered as flat 2D iso in a canvas, pixel-matching a screenshot. *This is the first real milestone. Do not proceed until it matches.*
4. **All rooms extracted**, harness reporting match percentages, outliers investigated.
5. **Emulator running the ROM**, framebuffer displayed, audio working, controls mapped. Vanilla emulator, nothing custom.
6. **RAM interface** — room ID and player position read correctly, printed as an overlay on the emulator's own output. Verify by walking around.
7. **Three.js renderer** — one room as 3D geometry, static, correct projection.
8. **Bridge** — player billboard driven by live RAM, moving through 3D geometry. **This is the moment the project becomes real.**
9. **Full entity table** — NPCs, enemies, chests all rendering.
10. **Room transitions** — swap geometry on room ID change.
11. **UI compositing**, fades, screen shake.
12. **WASM build**, phone via LAN, Add to Home Screen.

---

## 9. Known pitfalls

- **A subtly wrong decompressor** produces plausible-looking garbage. Validate against known-good output before building on it, not after.
- **Sprite anchor offsets** — extract from data, never eyeball.
- **Fixed-point coordinates** — convert once at the RAM boundary, never downstream.
- **Priority bits and sort order** will fight you. Budget real time; it is the main source of visual wrongness.
- **Not all visual state is in tidy work RAM.** Palette fades, shake, and some effects live in VDP registers or sprite attribute tables. Each is a small self-contained hunt.
- **Moving platforms and elevators** change the collision surface at runtime. Their state is in the entity table — read it, do not attempt to model their movement.
- **Cutscenes and the intro** may move entities in ways that break assumptions about the entity table. Test the intro specifically.
- **The Gola fights and endgame rooms** are unusual. Test them before declaring completeness.

---

## 10. Deliberately deferred

Do not build these in v1. Listed so they are not accidentally designed out.

- **Free camera rotation.** Possible in principle, but the tile art has isometric perspective and directional lighting baked in, and sprites have limited facings. Would require unprojecting block textures (an affine inverse-shear per face, accumulated across rooms to fill occlusion gaps) and either 3D character models or many more sprite angles. Large art problem, not a code problem.
- **Improved jumping and movement.** Requires abandoning the emulator as physics authority — a fundamentally different architecture (static extraction plus a reimplemented controller). Incompatible with this design.
- **Higher-resolution or re-authored art.** The IR makes it possible later; the renderer should not assume native texture resolution anywhere.
- **More diverse NPC sprite sheets.** Outside the ROM there are no VRAM or palette limits, so this becomes purely an art-authoring question.
- **Reimplemented UI and text rendering.**

---

## 11. Repo layout

```
/tools/extract.py         # ROM → IR, offline
/tools/capture_refs.py    # emulator → reference screenshots
/emu/                     # Genesis Plus GX + bindings (native + wasm)
/src/bridge/              # RAM reader → GameState
/src/render/              # three.js scene, geometry builder, billboards
/src/ui/                  # framebuffer compositing
/assets/                  # extracted IR — gitignored
/test/                    # harness + reference screenshots
/docs/offsets.md          # every RAM/ROM address, with provenance
/config/rom.json          # expected SHA-1
```

`.gitignore` must exclude the ROM, all extracted assets, and save states. Ship code, never content.

---

## 12. First instruction to the agent

> Read `landstalker_disasm` and `landstalker_editor` before writing any parsing code. Implement the LZ77 decompressor and validate it byte-exact against `landstalker_tools` on at least 20 compressed blocks. Then build the reference-screenshot harness. Then extract a single room and render it flat, in 2D, until it pixel-matches. Report the match percentage before proceeding to anything 3D.
