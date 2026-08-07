---
layout: default
---

# The ROM is still the game

<p class="subtitle">Rendering a 1992 Mega Drive game in three.js, with the original ROM still running as the simulation.</p>

## What this is

Landstalker came out on the Mega Drive in 1992. Isometric action RPG, Zelda-ish, and famous among the people who played it for having the worst jumping in the genre. The camera is a fixed three-quarter projection, no shadows, no parallax, so mid-jump over a pit you have no idea where you are or where you will land. I played it as a kid, replayed it on emulators over the years, and never stopped resenting that one thing.

Over four days at the start of August I built a remaster of it.

<figure class="wide">
<img src="media/gumi-hd.png" alt="Gumi village. Geometry, lighting and shadows are the renderer; the world, the physics and everything you can interact with are the 1992 ROM." loading="lazy">
<figcaption>Gumi village. Geometry, lighting and shadows are the renderer; the world, the physics and everything you can interact with are the 1992 ROM.</figcaption>
</figure>

<figure class="wide">
<video controls muted loop playsinline preload="metadata" src="media/demo-hd-walkthrough.mp4"></video>
<figcaption>Walking around, running at 60Hz off the emulator's RAM.</figcaption>
</figure>

Nothing in it is reimplemented. The original ROM runs unmodified in Genesis Plus GX at 60Hz. Combat, dialogue, physics, item handling, puzzle state and room transitions still happen in the 68000 code. I replaced the presentation layer. A bridge reads the emulator's work RAM every frame and streams the game state over a websocket. A three.js renderer draws that state as real geometry, using tile and sprite art extracted from the ROM. The emulator's own video output gets thrown away; it is in there as a physics and logic server. Audio passes straight through, because there was no reason to touch it.

One rule kept the whole thing tractable: never write to emulator RAM. Input goes in through the pad, the same three buttons and d-pad the hardware has, and state only comes out. Poke memory once and you have forked the game, its bugs are now your bugs, and every "just this once" after that is more unbounded work. So even the click-to-move pathfinding plays by pad: it plans a route over the extracted collision grid and then presses direction buttons cell by cell, like a very patient person with a controller.

Once the world is actual geometry instead of a painted picture, a lot of things that were impossible on the hardware come nearly for free: point lights from the torches that cast real shadows, ambient occlusion, arbitrary zoom, a browser as the display with a phone as the controller. And a soft shadow under the player that shrinks as he rises. The jumping I did not fix (the physics lives in the ROM and stays there), but you can now see where you will land, which after thirty-four years is the thing I was after in the first place.

"Ship code, never content" is the line in the project spec, and the ROM handling follows from it: not in the repo, not distributed, read-only input supplied by whoever runs this, pinned by SHA-1, hard fail on any mismatch.

One more thing before the technical part, so nobody has to wonder: this was built with coding agents. I typed 62 messages total across the four days. There is a section about that at the end, with numbers, including the parts where it went badly. It sits at the end because the point I want to make about agents comes out of comparing the two halves of this project, the reverse engineering against the AI art, and that comparison needs the rest of the article first.

## The emulator as a physics server

The bridge is a Python process holding the Genesis Plus GX libretro core through ctypes. It runs a frame, reads memory, sends messages, then sleeps until the next 60Hz tick. The whole protocol fits in a docstring:

```
server -> client: {"t": "hello", "audio_rate": 44100}   once on connect
server -> client: {"t": "state", ...gamestate}          every frame
server -> client: {"t": "video", "png": ..., "hud_mask": ...}  every 4th frame
client -> server: {"t": "input", "buttons": ["up", "c"]}
Binary frames are reserved for audio.
```

The state message is what matters. Every tick it does one bulk read of the entity table at `0xFF5400`, sixteen slots of `0x80` bytes each, slot 0 being the player. The table walk has two sentinels the game itself uses: a first byte of `0x7F` marks an empty slot, and anything `>= 0x80` ends the table. Per entity it pulls position, height, facing, hflip, palette line, graphics id, animation and frame, type and hp. Alongside that go the camera words at `0xFF1200` and `0xFF1202`, the room id, the live colour RAM, and the VDP window-plane registers together with their RAM shadows. That is the entire interface to the game.

The video message arrives at 15fps and exists only so the browser can composite the HUD, dialogue boxes and menus, which are drawn by the VDP's window plane and would be tedious to reproduce. Everything you play is rendered from the state message.

Audio was almost free. The core had been generating the full soundtrack the entire time and the driver was just dropping it on the floor. Implementing the libretro audio callbacks got the PCM out, and it now goes over the same websocket as binary frames, batched every two emulated frames into roughly 23ms chunks, into an AudioWorklet ring buffer in the browser.

Two parts of the bridge cost me real time.

The first is that Genesis Plus GX stores 68000 work RAM byte-swapped within 16-bit words on little-endian hosts. Every read has to be `[addr ^ 1]`. VDP registers are not swapped. Colour RAM is swapped and also packed differently from what the hardware documentation describes, as 9-bit `BBBGGGRRR` rather than VDP colour words. None of this is written down anywhere obvious, and all of it presents as "my numbers are nonsense" rather than as an error.

The second was a hang. Mid-afternoon on the fourth day the bridge stopped sending states, while still accepting new connections and answering the handshake. The cause turned out to be a websocket send with no timeout: Vite's dev-server proxy holds a connection open after its page navigates away, that socket never drains, its buffer fills, and one `await ws.send()` blocks the entire 60Hz loop forever. The fix is one line and the comment above it is longer than the code:

```python
# A half-open socket (e.g. the vite proxy after its page navigated
# away) never drains: an unbounded send blocks the 60Hz loop forever
# (observed 2026-08-06, bridge hung within minutes). Time out fast
# and drop the client.
await asyncio.wait_for(ws.send(m), timeout=1.0)
```

The read-only rule has a test. `test_ram_is_never_written` snapshots the entity table, calls the state reader twice, and asserts nothing moved. It is a slightly silly test and I would write it again, because the rule is the only thing standing between this project and a slow reimplementation of Landstalker.

## Getting the world out of the ROM

The state reader only helps if the room around those entities can also be reconstructed. Landstalker stores its rooms as a heightmap. Every cell carries a floor height, a set of collision flags, and a floor type. The game needs this because it is doing real 3D collision internally, on a 68000, in 1992. The geometry is already in the cartridge, leaving the decoder to get it out.

Getting to it goes through four formats stacked on each other.

At the bottom is an LZ77 variant that is not deflate and not the Nintendo one. No header, no size field. A command byte carries eight flags, MSB first; a set flag means "copy one literal byte", a clear flag means a two-byte back-reference where the first byte holds the offset's high nibble in its top half and an inverse length code in its bottom half, so `length = 18 - (b1 & 0x0F)`. An offset of zero terminates the stream and the length nibble on that final pair is meaningless. Copies can overlap, deliberately, so the copy loop has to run one byte at a time.

On top of that sit blocksets. A block is 2x2 VDP tiles, and the compressed form interleaves three separate concerns. First three run-length-coded bitmasks over every tile, one each for priority, vertical flip and horizontal flip. Then the tile indices, through a 16-entry move-to-front queue where one bit chooses between a 4-bit queue index and an 11-bit literal that gets pushed. Then, because tiles usually come in mirrored pairs, tiles are decoded two at a time: after the first, a single bit says "the second is the first plus or minus one", and which of plus or minus depends on the horizontal flip attribute that was decoded back in the first mask pass. That is a cross-pass dependency inside a bitstream, and getting the sign backwards produces output that still looks like a tilemap.

Room maps are two independent bitstreams in one blob. The layer section builds itself from a 14-entry offset dictionary whose first six entries are computed from the room's width rather than read, uses a three-bit command that takes two further bits to reach values six through thirteen, and has a vertical propagation mode that alternates straight-down and diagonal runs. The heightmap section is separate, run-length coded over 16-bit cell patterns, with 8-bit counts that chain when they hit `0xFF`.

Sprites are a four-level pointer chase (a base pointer, an animation table of 403 entries, a frame pointer table of 1268 entries resolving to 834 unique blobs) with no count fields anywhere, so animation ranges have to be recovered by differencing consecutive pointers. Inside a frame, the tile data has LZ77 nested within its own command-word stream, tiles within a subsprite are stored column-major, and two of the lookup tables are not reachable through any pointer table at all. They are addressed by 68000 `lea d16(pc)` instructions, so the extractor decodes two instructions out of the code segment and takes the sign-extended displacements.

I did not work any of that out from raw bytes. Landstalker has been reverse engineered for years by people who were very good at it. There is a full disassembly that reassembles byte-identical, a C++ format library, an editor, and two randomizers. One randomizer reads live RAM from a running US ROM, so it corroborates memory addresses rather than cartridge ones. All five got vendored into a `refs/` directory and treated as the specification.

The project spec I started from deliberately contained zero addresses. It had a note attached: any offsets it supplied from memory would be unreliable, so derive every one from those sources or from live investigation, and write each into `docs/offsets.md` with a note on how it was confirmed. That file has a provenance column. Entries never confirmed against a live emulator are still marked unverified. One of the format docs says outright that two flag bits are disputed between two reference implementations and that I do not know which is right.

## How you know it's right

A subtly wrong decompressor does not crash. It produces plausible-looking garbage, and then you build a renderer on top of it and spend a week wondering why one room in twenty has a corrupt corner.

Before building the renderer, I built three oracles.

For LZ77 there is a command-line tool in one of the reference repos, so the test shells out to it for every compressed sample in the disassembly and asserts byte equality. That is 64 blocks: fonts, tilesets, title screen, HUD, inventory, the lithograph, the ending.

For room maps and blocksets, the reference C++ library is the oracle, but not through its shipped CLI. That CLI round-trips through CSV and never tells you how many compressed bytes it consumed, and the consumed size is the single most bug-prone return value in a bitstream decoder, because every off-by-one in your bit accounting shows up there first and nowhere else. So there is a 65-line C++ program in `test/oracle/` that links the library directly and dumps values line by line: header fields, then one line per cell. The Python decoder has to match every field, every foreground cell, every background cell, every heightmap cell, and the compressed size, across 643 room maps and 115 blocksets.

For the ROM tables, where no library helps, the disassembly's own packed binary assets are ground truth. Some tests are direct byte-slice equality, which proves an offset constant is right. Others hash the decoded structure and require it to be a member of the set of hashes from the disassembly's files, which proves the pointer-table walk finds the right blobs even though rooms share maps. That path caught a real trap: the sprite frame files carry a trailing pad byte when a frame has odd length, because frames must start on even 68000 addresses, and without an explicit allowance for it you get two hundred spurious mismatches.

Altogether 856 tests, 4.7 seconds. The suite also boots the actual emulator, drives it to gameplay from a cached savestate, and asserts that the frame counter advances by exactly ten when you run ten frames.

A different harness compares the emulator's own framebuffer against a pure-Python render of the same room from extracted assets, and reports a percentage. Getting that number to mean anything took more care than the comparison itself. It waits for the palette fade to finish and the camera words to stop moving before capturing. It renders colours through the emulator's exact RGB565 expansion rather than a naive ramp, then masks out sprite pixels by walking the VDP sprite attribute table's link list, since entities are not part of a static room render. The number is 98.1% average background match across the reachable rooms, worst room 97.0%. The residual is animated tile phase and a couple of places where the game edits its own tilemap at runtime. There is a rope bridge in the prologue that physically collapses, so the live tilemap differs from the cartridge there.

My favourite thing the harness caught was a bug in the harness. The match percentage sat stubbornly low, and the extractor turned out to be fine. The game only draws the scrolling map in screen rows 21 through 184. Above that is the HUD, below is blank, and the comparison had been counting both as mismatch. The extracted geometry had been correct the whole time. I only found out because a number existed and was worse than it should have been.

<figure>
<img src="media/extraction-vs-emulator.png" alt="The pixel harness. Top is the emulator's own framebuffer, bottom is the room rendered from extracted assets. The magenta band is the region under test." loading="lazy">
<figcaption>The pixel harness. Top is the emulator's own framebuffer, bottom is the room rendered from extracted assets. The magenta band is the region under test.</figcaption>
</figure>

The animated tileset table shows the limit. It has a length field, and I read it as bytes. It is VDP words, so every animation frame was half the size it should be. No oracle covered that table, so nothing failed. It took reading the game's own DMA routine and watching live VRAM to notice. This is what the work looks like wherever ground truth runs out.

## Drawing it

With the room data checked, the projection comes straight out of the disassembly, from a routine that converts world coordinates to screen coordinates every frame:

```
dx = CentreX - Z - camX
dy = CentreY - Z - camY
screen_x = dx - dy + 0x120
screen_y = ((dx + dy + parity) >> 1) + 0xE8
```

Two consequences fall out. Z cancels from the horizontal axis entirely, contributing only to screen_y, which is why the game is unreadable in the air. And the camera words are not a camera position at all, they are the player's own flattened coordinates, tracked incrementally as he moves. So the player is always drawn at screen (160, 104), and everything else moves around him.

Written continuously, the map is `screen_x = 16(x - y)` and `screen_y = 8(x + y) - 16z`. The view axis, the direction that projects to a single point, is exactly (1, 1, 1). Depth is therefore just `x + y + z`.

The renderer uses that identity directly. Geometry is built in screen space, with `x + y + z` written into the z coordinate, and viewed through a plain orthographic camera. There are no rotation matrices and no camera rig. It is exact by construction, and later features reuse the same identity.

Textures are palette indices, not colours. Each room rasterises into a two-channel texture holding a 0-15 palette index and an emissive flag per pixel. The fragment shader resolves the index against a 16-entry palette texture that gets re-uploaded from live colour RAM every frame. Fades, menu dimming, damage flashes and room transitions stay frame-accurate because they are palette animations in the original, and they remain palette animations here.

Matching the emulator's colours exactly needed one more piece. Genesis Plus GX in its normal mode doubles each 3-bit channel and then packs to RGB565, and the maximum channel value that comes out the other side is 238, not 255. Every colour in the game is slightly darker than a naive expansion gives you. Get it wrong and every pixel in the room mismatches by a little, so the harness reports a bad number and cannot tell you whether your decoders are broken or just your palette.

The renderer runs in linear light with a float palette, and the only pixels allowed to exceed 1.0 are emissive ones, so a bloom pass thresholded at exactly 1 picks up torch flames and nothing else.

The original draws 320x224 because that is what the hardware had. The 3D view has no VRAM limit, so the viewport fits the original playfield and shows more of the room around it when the browser window is bigger. Sprite compositing came next, and the spec had already marked it as the risky part.

## The sprite problem

The spec warned me about this before a line of it existed: priority bits and sort order will fight you, budget real time, it is the main source of visual wrongness. It was right, and it still took three attempts.

Sprites are billboards, flat quads standing in the world. First version put each quad at its entity's depth, and walls behind the character clipped his head off, because a wall face one cell further back has greater depth than the character's feet. So I leaned the top edge of each quad toward the camera by the sprite's own height, which fixed the general case. Then characters pressed flush against a wall still lost a few pixels, so the quad got a half-cell depth bias, on the reasoning that a sprite represents the front half of a person. Better, but still wrong near the huts in the first village, and still wrong mid-jump.

The mistake was the entire premise. The VDP does not depth-test sprites against background graphics. There is no depth buffer on a Mega Drive. Sprites and planes are separate layers composited by fixed rules, and the only mechanism by which background art can cover a sprite is a single priority bit. Landstalker computes that bit itself, every frame, per entity: a routine checks whether terrain in front of the entity is taller than it is, and if so clears the bit so the entity draws behind the foreground art. It caches the result in a per-entity structure, and the bridge reads it out and ships it as a boolean.

So the renderer stopped trying to be clever and reproduced the hardware. Room geometry draws into a full depth buffer. Then the depth buffer is cleared. Then a second scene draws the sprites plus one extra pass of the room geometry containing only its priority-bit pixels, sequenced by render order: demoted sprites first (writing depth), then the priority art on top of them (ignoring depth), then normal sprites (depth-testing, so they only lose to a closer demoted sprite, which is the one case where the hardware keeps the plane art in front).

That removed the clipping. Room geometry can no longer shave a sprite under any circumstances, because on the console it never could. The artists drew those rooms knowing that and placed roofs and ledges and eaves to take advantage of it. My earlier attempts were fighting their art direction with a depth buffer.

The priority bit reads 0 in the trench room's ditches and 1 on open floor, which is how I confirmed I was reading the right byte.

<figure class="wide">
<img src="media/sprite-priority-massan.png" alt="Massan, the room where the clipping was worst. Roof and step faces used to shave pixels off the character; now only the game's own priority bit can put art in front of him." loading="lazy">
<figcaption>Massan, the room where the clipping was worst. Roof and step faces used to shave pixels off the character; now only the game's own priority bit can put art in front of him.</figcaption>
</figure>

Every visual change in this project has to keep an exact-mode render pixel-identical to the Python renderer, and that rework did.

## What you get for free once the world is 3D

Torch lights were the first thing that felt like cheating. Hand-placing them across 816 rooms was obviously not happening. Flames in this game are animated tiles, and a warm-coloured animated tile is in practice always fire, since the other animated tiles are water. The renderer scans a room's block layers, picks out animated tiles whose average colour is strongly red-dominant, clusters adjacent cells, and emits one point light per cluster. No hand authoring, and it covers every room.

My favourite three lines handle flames painted on walls. A flame is at the wall's position, but a light source there sits inside the geometry. Because the view axis is (1, 1, 1), every point along that axis projects to the same screen pixel. The light slides along the view axis until it finds passable floor. It ends up hovering just in front of the wall while its projection stays exactly on the painted flame.

<figure>
<img src="media/torches-early.png" alt="First attempt at torch lights." loading="lazy">
<figcaption>First attempt at torch lights.</figcaption>
</figure>

<figure>
<img src="media/torches-final.png" alt="After clustering, flicker and emissive bloom. Nothing here is hand-placed; the room was scanned for warm animated tiles." loading="lazy">
<figcaption>After clustering, flicker and emissive bloom. Nothing here is hand-placed; the room was scanned for warm animated tiles.</figcaption>
</figure>

Cast shadows work off the heightmap. At room load, every visible face gets sample points marched toward the sun over the heightmap grid, and a blocked ray means that sample is in shadow. Results rasterise into a half-resolution screen-space mask, resolving overlaps with the same `x + y + z` depth rule, get one box blur for a soft edge, and are sampled in the fragment shader. It takes 15 to 17 milliseconds per room and is cached, so it happens inside the game's own fade-to-black on room entry and nobody sees it.

<figure class="wide">
<img src="media/sun-shadows-massan.png" alt="Directional sun with baked shadows off the heightmap." loading="lazy">
<figcaption>Directional sun with baked shadows off the heightmap.</figcaption>
</figure>

And the blob shadows, which are the reason I started. Ground height comes from the extracted heightmap, and the shadow is a world-space circle laid on the floor, which the projection turns into a correctly proportioned ellipse without any work. It shrinks and fades as the character rises. That is all it is. It does not touch the physics, the jump arcs are identical to 1992, and the game is playable in a way it never was.

<figure class="wide">
<video controls muted loop playsinline preload="metadata" src="media/demo-pathfinding-zoom.mp4"></video>
<figcaption>Click-to-move pathfinding and free zoom. Every move is still pad input into the emulator.</figcaption>
</figure>

Every one of these features defaults to off. With the neutral settings the shader arithmetic reduces to multiplying by one and adding zero. Exact mode forces the features off entirely, so the pixel harness cannot drift while I am making things pretty. That is the only reason I still trust the 98.1% after four days of visual changes. It protects the extracted renderer. It says nothing about whether a generated backdrop still depicts the same room.

## The other half: the art, and the gate that could not see

The generated art had no equivalent oracle.

The pipeline rasterises a room canvas from the extracted assets, pads it with black to the nearest aspect ratio the image API supports, and sends it image-to-image to Gemini at 4K with a prompt insisting the layout is authoritative. It resizes the result back to exactly 4x, crops the padding, and forces the void area black again. Room variants share art, so deduplicating by rendered identity turns 816 rooms into 647 unique canvases. The renderer then swaps the palette-index albedo for the generated image and keeps every other feature: lighting, shadows, ambient occlusion, the priority overlay, and the colour-RAM fade tracking, so HD rooms still fade correctly through doors.

It works, and the result looks, to my eye, better than I expected. I went through six style candidates before settling on a Vanillaware-ish painted register.

<figure class="wide">
<img src="media/styles-contact-sheet.jpg" alt="Six candidate styles, same room, same geometry. Vanillaware (bottom left) won." loading="lazy">
<figcaption>Six candidate styles, same room, same geometry. Vanillaware (bottom left) won.</figcaption>
</figure>

<figure class="wide">
<img src="media/hd-toggle-pair.png" alt="The L key, mid-session. Same frame, same geometry, different albedo." loading="lazy">
<figcaption>The L key, mid-session. Same frame, same geometry, different albedo.</figcaption>
</figure>

<figure class="wide">
<img src="media/raytraced-style-test.jpg" alt="raytraced style test" loading="lazy">
<figcaption>The register I did not take. Photoreal renders of the same rooms look genuinely good and belong to a different game.</figcaption>
</figure>

<figure class="wide">
<video controls muted loop playsinline preload="metadata" src="media/demo-realistic-style.mp4"></video>
<figcaption>The same thing in motion, which is where it stops working.</figcaption>
</figure>

Quality control started with alignment. Take the generation, downscale it back to source resolution, run a Sobel filter on both, take the top decile of gradient magnitude as "strong edges", and measure the median distance from each source strong edge to the nearest generated strong edge. Require it under four pixels. Also FFT phase-correlate the two gradient fields and require a global shift of exactly zero. Three attempts, then mark the canvas rejected and fall back to pixel art.

The gate catches the model reframing or rescaling the image, which it does surprisingly often. Two canvases have never passed it in any style because the model insists on shifting them.

<figure class="wide">
<img src="media/route434-before-after.png" alt="route canvas before and after" loading="lazy">
<figcaption>What a good one looks like. Source render on top, generation below, same silhouette and the same walkable path.</figcaption>
</figure>

Then I walked into the church interior, which had passed the gate cleanly and was badly wrong. The model had read a small indoor room as an outdoor plaza: the walls had become floor, the statue and altar were gone. The gate did not care, because edges staying put is what a content inversion with intact layout looks like.

Four more turned up the same way. A route canvas where the vertical cliff face became a top-down forest floor, so the walkable path ran across what now read as treetops, the waterfall collapsed into a puddle, and a ladder had been invented against a doorway that had none. Another where the model painted a river along the walkable dirt path, narrowing it and replacing half of it with water the player walks straight through. That one scored a median edge distance of 1.0 pixels and zero shift, a perfect alignment report for a canvas with a river through the middle of the road.

<figure class="wide"><div class="triptych"><img src="media/gate-426-source.png" alt="source" loading="lazy"><img src="media/gate-426-broken.png" alt="broken generation" loading="lazy"><img src="media/gate-426-fixed.png" alt="corrected generation" loading="lazy"></div><figcaption>Left: the source render. Middle: a generation that passed the alignment gate. The vertical cliff has become a top-down forest floor, the waterfall has collapsed into a puddle, and a ladder has been invented against the doorway. Right: the same canvas after the prompt and the gate were fixed.</figcaption></figure>

That made five semantically broken canvases, and the automated gate caught none of them. All five were caught by a human looking at pictures, two of them by me noticing something looked wrong while playing and the rest in a manual pass over the batch.

I built a second gate that tries to see meaning. For every cell in the game's own heightmap, project its top face into the canvas using the same projection the renderer uses, and sample a patch in both the source render and the generation. Blur each patch into an opponent-colour vector (luminance, red minus green, blue minus yellow) so brushwork averages out and only the material-level colour survives. Cells whose source colour matches each other, anywhere in the room, are the same material, so their generated colours should also match each other. The statistic is each cell's deviation from the median of its own reference group. It distinguishes small, scattered deviations from the large, spatially connected, directionally coherent blobs left by semantic inversion.

Reject if more than a quarter of sampled cells are anomalous. Plus a second, embarrassingly specific rule for invented water: eight or more connected anomalous cells, drifting in a consistent direction, blue-shifted, not darkened (which separates a painted river from a painted shadow), and smoother than their reference cells (water is flat, foliage is busy).

All three broken canvases I had kept as backups reject. Forty-five of the forty-six previously accepted canvases pass, and the one that flags was independently known to be degraded.

It still cannot see, though. Room 181 scored an anomaly fraction of 0.0, no coherent component at all, a median edge distance of 1.0 pixels. A flawless report on every axis I measure. The statue in that room had been repainted as a living person.

A pit in a floor got painted as a pool of water. The gate rejected two attempts and accepted the third, because the pool was dark and my "not darkened" condition let it through. Conifer trees appeared inside a cave, and the water detector was structurally incapable of firing because the colour drift went the wrong way on every one of its axes. The two canvases that never pass sample one cell and twenty cells respectively. Both are below the thirty-cell minimum where the structural gate declares itself inconclusive and passes by default, so on the rooms most likely to fail it never runs at all.

The prompt is an archaeological record of the same process. It started at six clauses and grew one per disaster. Merging trees produced a clause about keeping their exact count and species. The church produced another that spells out which part of an isometric interior is wall and which is floor. Water must stay saturated blue. Clause eight reads in part "A flat wall decoration in the source stays a flat wall decoration; never reinterpret one as a ladder or any other three-dimensional object", after a test generation turned a wall banner into a ladder.

Character sprites presented the same problem. All of a character's frames go into one grid and get regenerated in a single call, because that is what holds identity constant across poses. Alpha authority never leaves the original: the source silhouette, dilated two pixels, caps what can be opaque, so a generated sprite physically cannot leak outside an honest outline. I measured identity drift between adjacent walk frames and got a worst-case channel shift of 6 out of 255, which is excellent.

In motion they shimmer. Hair tufts change shape, the scabbard drifts a few degrees, the dog's harness wobbles, and at 60Hz it reads as a faint boil. The metric measured colour consistency, which held up. It said nothing about shape consistency, which failed.

<figure class="wide">
<img src="media/nigel-sheet-hd.png" alt="One character, every frame, one generation. Sending them as a single sheet is what keeps the character the same person across poses." loading="lazy">
<figcaption>One character, every frame, one generation. Sending them as a single sheet is what keeps the character the same person across poses.</figcaption>
</figure>

<figure class="wide"><div class="triptych"><img src="media/nigel-walk-hd.gif" alt="Nigel walk cycle" loading="lazy"><img src="media/dog-walk-hd.gif" alt="dog walk cycle" loading="lazy"><img src="media/chicken-walk-hd.gif" alt="chicken walk cycle" loading="lazy"></div><figcaption>Sliced back into animations. The boil is easier to see than to describe.</figcaption></figure>

My honest conclusion is that the gate will never be sound, because the question is semantic and the measurement is not. The eyeball pass is the real gate, so the right move is making it cheap: one contact sheet, source beside generation, all forty-eight canvases in the current pack, one scroll. I should have built that first. Building metrics was more fun.

## How this actually got built

The build took four days, three substantive sessions, roughly twenty background subagents, and 62 messages typed by me. The first one was 172 characters:

> read ~/Downloads/landstalker-3d-spec.md - find the ROM in the same folder, do more research as you see fit, then let's start implementing this. if you need to amcq, do that

Twenty-six minutes later the agent had pinned a ROM revision by SHA-1 and asked whether I wanted a different dump. My answer, in full: "commit as you wish, and US is fine if you say it is. continue". That is the register for the rest of the project.

Categorising all 62 messages: about a third are taste and art direction, about a quarter are bug reports from playing the thing, a sixth are some variant of "go ahead", a sixth are managing the work queue (which subagent does what, in what order, what to parallelise), and roughly one is architectural.

The flattering reading is that I set the constraints and then stepped back. The transcripts do not support it.

The constraints came from the spec, which I had written in a separate conversation before opening an editor. It is the load-bearing document: it names the model (the original stays authoritative, replace only presentation), and it lists non-goals in imperative form, each with a one-line reason. Do not reimplement game logic. Do not fix the jumping. Do not build a free camera. Do not modify or redistribute the ROM. Above them a sentence I never had to repeat: "Each one converts a bounded project into an unbounded one."

In 62 messages, I never once defended those non-goals during the build. Several decisions came close. Click-to-move pathfinding and the step-up jump assist both sit right on the boundary between presentation and gameplay. The agent held the line itself, in the spec's own vocabulary, and wrote the reasoning into the commit messages. Two of my three session-opening prompts were handover documents the previous session's agent had written for me, which I pasted without editing. The single most technically detailed "human" message in the entire corpus is one of those, and I did not write a word of it. On day four I described my own project back to the agent to check I had it right, and got three corrections and two omissions in return.

What I contributed came almost entirely from having the game open in front of me:

> btw the sprites seem to be upside down, the stats and Nigel are, in our version

> one more thing, there is some odd clipping [...] seems to happen when nigel is against a non-room wall?

> hmm, the original vanillaware looked better, more detailed. this one looks like a flash game, sort of. any ideas why, and how we can get it more like the initial version I fell in love with?

> ok cool. btw. I noticed a small bug in the interior, the church looks broken, at least with the previous HD backdrop, something to check maybe

That last one, typed in passing, is the church from earlier, and the reason the structural gate exists.

<figure class="wide">
<img src="media/sprites-upside-down.png" alt="sprites rendered upside down" loading="lazy">
<figcaption>The first of those reports. Billboards were rendering vertically flipped, character and torch flame both. The inset bottom right is the emulator's own output, which is what it should have looked like. The camera is y-down, so the sprite texture needed its vertical flip disabled.</figcaption>
</figure>

The mobile controls are the sharpest single illustration. A subagent built a touch layer and verified it exhaustively, with real Chrome touch events dispatched through the debugging protocol, proving tap and drag and flick and pinch all produced the right pad output, with 850 tests green and screenshots attached. Every gesture worked. I put it on my phone, played for twenty minutes, and reported: "right now I don't even know how to swing the sword". It had shipped a gesture-only scheme with no visible buttons. The verification was complete and correct and the thing was unusable, because nothing it could check would have told it that.

<figure class="wide">
<img src="media/phone-touch-layer.png" alt="The replacement: a floating stick under the left thumb and actual visible buttons under the right." loading="lazy">
<figcaption>The replacement: a floating stick under the left thumb and actual visible buttons under the right.</figcaption>
</figure>

The two halves of this project were built in the same week with the same tools. The emulator, extractor and renderer half had cheap sound oracles at every step: a reference implementation to diff against, a byte-exact assertion, a pixel percentage, 856 tests in under five seconds. It converged in days, ran largely unsupervised through background agents, and I could not tell you what most of the commits contain.

The two halves of this project were built in the same week with the same tools. The emulator, extractor and renderer half had cheap sound oracles at every step: a reference implementation to diff against, a byte-exact assertion, a pixel percentage, 856 tests in under five seconds. That half converged in days, ran largely unsupervised through background agents, and I could not tell you what most of the commits contain. The art half has no oracle, because "is this canvas semantically faithful" is not a question you can assert. That half needed me for every judgment, produced five semantic failures that no automated check caught, and after three generations of art packs is still not settled. The model was the same in both halves, so the difference was the feedback loop.

The cheap feedback also changed which work was worth doing. Working alone, I would never have written a C++ oracle harness for a hobby project. Nobody does. You spot-check three rooms, decide it looks fine, and pay compound interest on that decision for the rest of the project, usually around week three when one room in twenty has a corrupt corner and you have forgotten how the decoder works. Here the thorough option cost almost nothing, so I took it. Every layer afterwards got to stand on something proven.

That changes the honest counterfactual. Without agents this is not a four-day project, it is most of a year of evenings for someone who already knows 68000 assembly, VDP internals and three.js. More likely, it is not a project at all. Things like this die at a specific place: month two, the decoder is 95% right, one room renders garbage, there is no oracle because building the oracle felt like a detour, and the debugging plateau runs for weeks with nothing to show. That is where reverse engineering side projects go to be abandoned. The test suite makes that plateau survivable.

What is left is a WebAssembly build, which moves the core into the browser and makes the whole thing a static page instead of a server per player. Also every remaining NPC sprite sheet, which I will probably not do.

The last thing I typed at this project, at six in the morning after too many parallel sessions, was "small change, make her house a rainbow themed house". Ten minutes later: "damn, wrong session, pls revert". By then the agent had already regenerated the house.

---

The code is not public yet. When it is, it goes up without the ROM and without the extracted assets, which is the only way it can go up. The spec I started from is [here](spec.md), unedited.
