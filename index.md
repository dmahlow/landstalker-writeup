---
layout: default
---

# The ROM is still the game

<p class="subtitle">Rendering a 1992 Mega Drive game in three.js, with the original ROM still running as the simulation.</p>

## What this is

The other kids had a Super Nintendo, which meant they had Zelda. I had a Mega Drive, which meant I had Sonic and a set of carefully rehearsed opinions about why that was better. It wasn't better. What I wanted was the game where you wander around a world, talk to people and open things, and Nintendo owned that one.

<figure class="wide">
<img src="media/orig-title.png" alt="Japan got it in 1992, the rest of us in 1993." loading="lazy">
<figcaption>Japan got it in 1992, the rest of us in 1993.</figcaption>
</figure>

Then Landstalker turned up. Isometric, a real adventure, a treasure hunt for King Nole's gold, dungeons built almost entirely out of jumping puzzles, and a fairy called Friday who does not stop talking. A Zelda-shaped hole filled in by the machine that supposedly couldn't do Zelda. I was nine.

<figure class="wide">
<img src="media/orig-prologue.png" alt="Nigel on a ledge above the pines. Also, and this will matter later, possibly standing in the pines. There is no way to tell." loading="lazy">
<figcaption>Nigel on a ledge above the pines. Also, and this will matter later, possibly standing in the pines. There is no way to tell.</figcaption>
</figure>

<figure class="wide">
<img src="media/orig-friday.png" alt="Friday, who says this a lot." loading="lazy">
<figcaption>Friday, who says this a lot.</figcaption>
</figure>

<!-- MEMORY: specific childhood detail goes here -->

**[one specific memory goes here]**

It also had the worst jumping in the genre. The camera is a fixed three-quarter projection with no shadows and no parallax, so when you're mid-jump over a pit you have no idea where you are or where you'll land. I replayed it on emulators over the years and never stopped resenting that one thing.

<figure class="wide">
<img src="media/orig-trench.png" alt="Four ledges at four different heights, no shadow anywhere, and a drop between them. Now jump." loading="lazy">
<figcaption>Four ledges at four different heights, no shadow anywhere, and a drop between them. Now jump.</figcaption>
</figure>

Over four days at the start of August I built a remaster of it.

<figure class="wide">
<img src="media/gumi-hd.png" alt="Gumi village. Geometry, lighting and shadows are the renderer, the world, the physics and everything you can interact with are the 1992 ROM." loading="lazy">
<figcaption>Gumi village. Geometry, lighting and shadows are the renderer, the world, the physics and everything you can interact with are the 1992 ROM.</figcaption>
</figure>

<figure class="wide">
<video controls muted loop playsinline preload="metadata" src="media/demo-hd-walkthrough.mp4"></video>
<figcaption>Walking around, running at 60Hz off the emulator's RAM.</figcaption>
</figure>

For as long as I'd thought about it at all, I assumed fixing the jumping meant fixing the game. Patch the 68000 collision routines in the disassembly, or pull the whole thing apart, rebuild the engine, and write a controller that felt right. Both are real projects. Both are expensive, and I priced them properly one evening before writing a line of code, along with a full remake, which is worse.

Then I noticed I'd been solving the wrong problem. I don't want better physics, I want to see where I'm going to land.

The cheap version of that is to leave the game exactly as it is and change only what you see. Which had already been ruled out earlier that same evening, on the perfectly sound grounds that if the emulator is the physics then it can never fix the jumping.

Nothing in it is reimplemented. The original ROM runs unmodified in Genesis Plus GX at 60Hz, and combat, dialogue, physics, item handling, puzzle state and room transitions still happen in the 68000 code. What I replaced is the presentation layer: a bridge reads the emulator's work RAM every frame and streams the game state over a websocket, and a three.js renderer draws that state as real geometry, using tile and sprite art extracted from the ROM. The emulator's own video output gets thrown away. It's in there as a physics and logic server. Audio passes straight through, because there was no reason to touch it.

Never write to emulator RAM. Input goes in through the pad, the same three buttons and d-pad the hardware has, and state only comes out. Two reasons.

1. The moment you poke memory, you've forked the game. Its bugs are now your bugs, and every "just this once" after that is more unbounded work.
2. The read-only constraint is checkable. There's a test, `test_ram_is_never_written`, that snapshots the entity table, calls the state reader twice, and asserts nothing moved. It's a slightly silly test and I'd write it again, because this rule is the only thing standing between the project and a slow reimplementation of Landstalker.

So even the click-to-move pathfinding plays by pad: it plans a route over the extracted collision grid and then presses direction buttons cell by cell, like a very patient person with a controller.

Once the world is actual geometry instead of a painted picture, a lot of things that were impossible on the hardware come nearly for free. Point lights from the torches that cast real shadows. Ambient occlusion. Arbitrary zoom. A browser as the display with a phone as the controller. And a soft shadow under the player that shrinks as he rises. I didn't fix the jumping (the physics lives in the ROM and stays there), but you can now see where you'll land, which is all I ever actually wanted.

About the ROM: "ship code, never content" is the line in the project spec. The ROM isn't in the repo and isn't distributed, it's a read-only input supplied by whoever runs this, pinned by SHA-1, with a hard fail on any mismatch.

One more thing before the technical part, so nobody has to wonder: this was built with coding agents. I typed 62 messages total across the four days. There's a section about that at the end, with numbers, including the parts where it went badly. I put it at the end because the interesting observation comes from comparing the two halves of this project (the reverse engineering against the AI art), and that comparison needs the rest of the article first.

That does raise a question about the word "I" in everything that follows. I'm using it the way you'd say you built a house without having laid a brick. I decided things, I looked at things, I said what was wrong. Most of the typing wasn't mine, and a fair amount of what comes next I reconstructed afterwards, from the transcripts, the commit log and the handover notes the agents wrote for each other, because at the time I was largely watching it go past. Where the difference matters to the story, I'll say so.

## The emulator as a physics server

To draw the game myself I needed to know, sixty times a second, where everything in it was. The bridge is a Python process holding the Genesis Plus GX libretro core through ctypes. It runs a frame, reads memory, sends messages, then sleeps until the next 60Hz tick. The whole protocol fits in a docstring:

```
server -> client: {"t": "hello", "audio_rate": 44100}   once on connect
server -> client: {"t": "state", ...gamestate}          every frame
server -> client: {"t": "video", "png": ..., "hud_mask": ...}  every 4th frame
client -> server: {"t": "input", "buttons": ["up", "c"]}
Binary frames are reserved for audio.
```

<figure class="wide">
<img src="media/architecture-diagram.png" alt="Architecture: ROM and emulator on the left, bridge in the middle, three.js renderer on the right" loading="lazy">
<figcaption>The shape of it. Input goes in through the pad and state comes out through the memory reader, and nothing ever goes the other way. The emulator's own video output is used only for the HUD and the dialogue boxes, everything you play is drawn from the state message.</figcaption>
</figure>

The state message is the important one. Every tick it does one bulk read of the entity table at `0xFF5400`, sixteen slots of `0x80` bytes each, slot 0 being the player. The table walk uses two sentinels the game itself uses: a first byte of `0x7F` marks an empty slot, and anything `>= 0x80` ends the table. Per entity it pulls position, height, facing, animation state and hp. Alongside that go the camera words at `0xFF1200` and `0xFF1202`, the room id, the live colour RAM, and the registers of the VDP, the console's graphics chip, along with the copies of those registers the game keeps in RAM. That's everything the renderer knows about the game.

The video message arrives at 15fps and exists only so the browser can composite the HUD, dialogue boxes and menus. The graphics chip draws those on a separate layer, and reproducing them would have been tedious, so I didn't.

Audio was almost free, and this surprised me. The core had been generating the full soundtrack the entire time, the driver was just dropping it on the floor because nobody had implemented the libretro audio callbacks. Implementing them got the PCM out, and it now goes over the same websocket as binary frames, batched every two emulated frames into roughly 23ms chunks, into an AudioWorklet ring buffer in the browser.

Two parts of the bridge cost me real time. Neither showed up as an error.

The first is that Genesis Plus GX stores 68000 work RAM byte-swapped within 16-bit words on little-endian hosts. Every read has to be `[addr ^ 1]`. Fine, once you know it. But VDP registers are *not* swapped. And colour RAM is swapped *and also* packed differently from what the hardware documentation describes: 9-bit `BBBGGGRRR` rather than VDP colour words. None of this is written down anywhere obvious. The way it presents is that your numbers are nonsense: an entity X coordinate that jumps by 256 when the player takes one step, colours that are almost but not quite right. You stare at plausible-looking garbage and you have no idea which layer is lying to you.

The second was a hang. Mid-afternoon on the fourth day the bridge stopped sending states, while still accepting new connections and answering the handshake, which is the worst kind of failure because every quick check tells you the server is fine. The cause turned out to be a websocket send with no timeout. Vite's dev-server proxy holds a connection open after its page navigates away, that socket never drains, its buffer fills, and one `await ws.send()` blocks the entire 60Hz loop forever. The fix is one line and the comment above it is longer than the code:

```
# A half-open socket (e.g. the vite proxy after its page navigated
# away) never drains: an unbounded send blocks the 60Hz loop forever
# (observed 2026-08-06, bridge hung within minutes). Time out fast
# and drop the client.
await asyncio.wait_for(ws.send(m), timeout=1.0)
```

## Getting the world out of the ROM

The state reader only helps if the room around those entities can also be reconstructed. Landstalker stores its rooms as a heightmap: every cell carries a floor height, a set of collision flags, and a floor type. The game needs this because it's doing real 3D collision internally, on a 68000, in 1992. So the geometry I need is already in the cartridge, and the job is to decode it.

Getting to it goes through four formats stacked on each other, and I'll describe them in some detail because the details are where the difficulty lives.

At the bottom is an LZ77 variant that's not deflate and not the Nintendo one. No header, no size field. A command byte carries eight flags, MSB first, a set flag means "copy one literal byte", a clear flag means a two-byte back-reference where the first byte holds the offset's high nibble in its top half and an inverse length code in its bottom half, so `length = 18 - (b1 & 0x0F)`. An offset of zero terminates the stream. Copies can overlap, deliberately, so the copy loop has to run one byte at a time.

On top of that sit blocksets. A block is 2x2 VDP tiles, and the compressed form interleaves three separate concerns. First come three run-length-coded bitmasks over every tile, one each for priority, vertical flip and horizontal flip. Then the tile indices, through a 16-entry move-to-front queue, so recently used tiles get short codes: one bit chooses between a 4-bit queue index and an 11-bit literal that gets pushed. Then, because tiles usually come in mirrored pairs, tiles are decoded two at a time: after the first, a single bit says "the second is the first plus or minus one", and which of plus or minus depends on the horizontal flip attribute that was decoded back in the first mask pass. That's a cross-pass dependency inside a bitstream. If you get the sign backwards, the output still looks like a tilemap.

Room maps are two independent bitstreams in one blob, one for the tile layers and one for the heightmap, each with its own small command language and neither of them documented.

Sprites are a four-level pointer chase (a base pointer, an animation table of 403 entries, a frame pointer table of 1268 entries resolving to 834 unique blobs) with no count fields anywhere, so animation ranges have to be recovered by differencing consecutive pointers. Inside a frame, the tile data has LZ77 nested within its own command-word stream. Two of the lookup tables aren't reachable through any pointer table at all: they're addressed by 68000 `lea d16(pc)` instructions, so the extractor decodes two instructions out of the code segment and takes the sign-extended displacements.

I didn't work any of this out from raw bytes. Landstalker has been reverse engineered for years by people who were very good at it. There's a full disassembly that reassembles byte-identical, a C++ format library, an editor, and two randomizers. One randomizer reads live RAM from a running US ROM, so it corroborates memory addresses rather than cartridge ones. All five got vendored into a `refs/` directory and treated as the specification.

What none of them had done was connect any of that to a renderer. The data side of Landstalker has been solved for years by people doing careful, unglamorous work. Nobody had done much with the drawing side.

The project spec I started from deliberately contained zero addresses. It had a note attached: any offsets it supplied from memory would be unreliable, so derive every one from those sources or from live investigation, and write each into `docs/offsets.md` with a note on how it was confirmed. That file has a provenance column. Entries never confirmed against a live emulator are still marked unverified. One of the format docs says outright that two flag bits are disputed between two reference implementations and that I don't know which is right. I'd rather write down what I don't know than pretend the table is finished.

## How you know it's right

A subtly wrong decompressor doesn't crash. It produces plausible-looking garbage, and then you build a renderer on top of it and spend a week wondering why one room in twenty has a corrupt corner. I've abandoned enough hobby projects at exactly that point to know the shape of it. So before building the renderer, I built three oracles.

For LZ77 there's a command-line tool in one of the reference repos, so the test shells out to it for every compressed sample in the disassembly and asserts byte equality. That's 64 blocks: fonts, tilesets, title screen, HUD, inventory, the lithograph, the ending.

For room maps and blocksets, the reference C++ library is the oracle, but not through its shipped CLI. That CLI round-trips through CSV and never tells you how many compressed bytes it consumed. The consumed size is the single most bug-prone return value in a bitstream decoder, because every off-by-one in your bit accounting shows up there first and nowhere else. So there's a 65-line C++ program in `test/oracle/` that links the library directly and dumps values line by line: header fields, then one line per cell. The Python decoder has to match every field, every foreground cell, every background cell, every heightmap cell, and the compressed size, across 643 room maps and 115 blocksets.

For the ROM tables, where no library helps, the disassembly's own packed binary assets are ground truth. Some tests are direct byte-slice equality, which proves an offset constant is right. Others hash the decoded structure and require it to be a member of the set of hashes from the disassembly's files, which proves the pointer-table walk finds the right blobs even though rooms share maps. That path caught a real trap: the sprite frame files carry a trailing pad byte when a frame has odd length, because frames must start on even 68000 addresses, and without an explicit allowance for it you get two hundred spurious mismatches.

Altogether 856 tests, running in 4.7 seconds. The suite also boots the actual emulator, drives it to gameplay from a cached savestate, and asserts that the frame counter advances by exactly ten when you run ten frames.

On top of the tests there's a pixel harness. It compares the emulator's own framebuffer against a pure-Python render of the same room from extracted assets, and reports a percentage. Getting that number to mean anything took more care than the comparison itself: it waits for the palette fade to finish and the camera words to stop moving before capturing, it renders colours through the emulator's exact RGB565 expansion rather than a naive ramp, and it masks out sprite pixels by walking the VDP sprite attribute table's link list, since entities aren't part of a static room render. The number came out at 98.1% average background match across the reachable rooms, worst room 97.0%. The residual is animated tile phase, plus a couple of places where the game edits its own tilemap at runtime. There's a rope bridge in the prologue that physically collapses, so the live tilemap legitimately differs from the cartridge there.

One of the bugs the harness caught was in the harness itself. The match percentage sat stubbornly low, several points below where it should have been, and it wouldn't move. So the decoders got audited. They were fine. Then the palette expansion. Also fine. What finally cracked it was looking at *where* the mismatching pixels actually were, which was all at the top and bottom of the frame. The game only draws the scrolling map in screen rows 21 through 184. Above that is the HUD, below it is blank, and the comparison had been counting both regions as extraction errors. The extracted geometry had been correct the whole time, and an entire debugging session had gone into auditing innocent code. I find this a strong argument for building harnesses even when they're miscalibrated: a wrong number is something you can investigate, and without one I'd never have looked at all.

<figure>
<img src="media/extraction-vs-emulator.png" alt="The pixel harness. Top is the emulator's own framebuffer, bottom is the room rendered from extracted assets. The magenta band is the region under test." loading="lazy">
<figcaption>The pixel harness. Top is the emulator's own framebuffer, bottom is the room rendered from extracted assets. The magenta band is the region under test.</figcaption>
</figure>

The animated tileset table shows where this approach runs out. It has a length field, and it got read as bytes. It's VDP words, so every animation frame was half the size it should be. No oracle covered that table, so nothing failed, and the bug sat there until reading the game's own DMA routine and watching live VRAM exposed it. Wherever ground truth runs out, this is what the work goes back to looking like.

## Drawing it

Now I had the shape of the world and no idea where to put it on screen. The game's own answer is in the disassembly, in a routine that converts world coordinates to screen coordinates every frame:

```
dx = CentreX - Z - camX
dy = CentreY - Z - camY
screen_x = dx - dy + 0x120
screen_y = ((dx + dy + parity) >> 1) + 0xE8
```

Two consequences fall out of this. Z cancels from the horizontal axis entirely, contributing only to screen_y, which is exactly why the game is unreadable in the air. And the camera words aren't a camera position at all, they're the player's own flattened coordinates, tracked incrementally as he moves. The player is always drawn at screen (160, 104) and everything else moves around him.

Written continuously, the map is `screen_x = 16(x - y)` and `screen_y = 8(x + y) - 16z`. The view axis, the direction that projects to a single point, is exactly (1, 1, 1). Depth is therefore just `x + y + z`.

The renderer uses that identity directly. Geometry is built in screen space, with `x + y + z` written into the z coordinate, and viewed through a plain orthographic camera. There are no rotation matrices and no camera rig. It is exact by construction, and several later features reuse the same identity.

Textures are palette indices, not colours. Each room rasterises into a two-channel texture holding a 0-15 palette index and an emissive flag per pixel, and the fragment shader resolves the index against a 16-entry palette texture that gets re-uploaded from live colour RAM every frame. Fades, menu dimming, damage flashes and room transitions stay frame-accurate because they're palette animations in the original, and they remain palette animations here.

Matching the emulator's colours exactly needed one more piece of trivia: Genesis Plus GX in its normal mode doubles each 3-bit channel and then packs to RGB565, and the maximum channel value that comes out the other side is 238, not 255. Every colour in the game is slightly darker than a naive expansion gives you. Get this wrong and every pixel in the room mismatches by a little, and the harness can't tell you whether your decoders are broken or just your palette.

The renderer runs in linear light with a float palette, and the only pixels allowed to exceed 1.0 are emissive ones, so a bloom pass thresholded at exactly 1 picks up torch flames and nothing else.

The original draws 320x224 because that's what the hardware had. The 3D view has no VRAM limit, so the viewport fits the original playfield and shows more of the room around it when the browser window is bigger.

## The sprite problem

The spec warned me about this before a line of it existed: priority bits and sort order will fight you, budget real time, this is the main source of visual wrongness. It was right, and it still took three attempts.

> one more thing, there is some odd clipping [...] seems to happen when nigel is against a non-room wall?

That's the bug report, in full, from me on a couch on day one.

Sprites are billboards, flat quads standing in the world. The first version put each quad at its entity's depth, and walls behind the character clipped his head off, because a wall face one cell further back has greater depth than the character's feet. Obvious enough in hindsight.

Second attempt: lean the top edge of each quad toward the camera by the sprite's own height. This fixed the general case. Then characters pressed flush against a wall still lost a few pixels, so the quad got a half-cell depth bias, on the reasoning that a sprite represents the front half of a person. Better. Still wrong near the huts in the first village, and still wrong mid-jump. By this point it was constant-tuning, and each fix made a different room worse, which is usually the sign that the premise is broken.

The premise was broken. The VDP doesn't depth-test sprites against background graphics. There is no depth buffer on a Mega Drive at all. Sprites and planes are separate layers composited by fixed rules, and the only mechanism by which background art can cover a sprite is a single priority bit. Landstalker computes that bit itself, every frame, per entity: a routine checks whether terrain in front of the entity is taller than it is, and if so clears the bit so the entity draws behind the foreground art. It caches the result in a per-entity structure, and the bridge reads it out and ships it as a boolean. (The bit reads 0 in the trench room's ditches and 1 on open floor, which is how I confirmed I was reading the right byte.)

So the third version stopped trying to be clever and reproduced the hardware. Room geometry draws into a full depth buffer. Then the depth buffer is cleared. Then a second scene draws the sprites plus one extra pass of the room geometry containing only its priority-bit pixels, sequenced by render order: demoted sprites first (writing depth), then the priority art on top of them (ignoring depth), then normal sprites (depth-testing, so they only lose to a closer demoted sprite, which is the one case where the hardware keeps the plane art in front).

That removed the clipping, and it removed it categorically: room geometry can no longer shave a sprite under any circumstances, because on the console it never could. The artists drew those rooms knowing that, and placed roofs and ledges and eaves to take advantage of it. My earlier attempts were fighting their art direction with a depth buffer.

<figure class="wide">
<img src="media/sprite-priority-massan.png" alt="Massan, the room where the clipping was worst. Roof and step faces used to shave pixels off the character, now only the game's own priority bit can put art in front of him." loading="lazy">
<figcaption>Massan, the room where the clipping was worst. Roof and step faces used to shave pixels off the character, now only the game's own priority bit can put art in front of him.</figcaption>
</figure>

Every visual change in this project has to keep an exact-mode render pixel-identical to the Python renderer, and this rework did.

## What you get for free once the world is 3D

Torch lights were the first thing that felt like cheating. Hand-placing lights across 816 rooms was obviously not happening, and it turned out I didn't have to: flames in this game are animated tiles, and a warm-coloured animated tile is in practice always fire, since the other animated tiles are cool-coloured. So the renderer scans a room's block layers, picks out animated tiles whose average colour is strongly red-dominant, clusters adjacent cells, and emits one point light per cluster. Nothing hand-authored, and it covers every room in the game.

My favourite three lines in the codebase handle flames painted on walls. A flame like that is at the wall's position, but a light source there sits inside the geometry. Because the view axis is (1, 1, 1), every point along that axis projects to the same screen pixel, so the light just slides along the view axis until it finds passable floor, and ends up hovering in front of the wall while its projection stays exactly on the painted flame.

<figure>
<img src="media/torches-early.png" alt="First attempt at torch lights." loading="lazy">
<figcaption>First attempt at torch lights.</figcaption>
</figure>

<figure>
<img src="media/torches-final.png" alt="After clustering, flicker and emissive bloom. Nothing here is hand-placed, the room was scanned for warm animated tiles." loading="lazy">
<figcaption>After clustering, flicker and emissive bloom. Nothing here is hand-placed, the room was scanned for warm animated tiles.</figcaption>
</figure>

Cast shadows work off the heightmap. At room load, every visible face gets sample points marched toward the sun over the heightmap grid, a blocked ray means that sample is in shadow. The results rasterise into a half-resolution screen-space mask, resolving overlaps with the same `x + y + z` depth rule, get one box blur for a soft edge, and are sampled in the fragment shader. This takes 15 to 17 milliseconds per room and is cached, so it happens inside the game's own fade-to-black on room entry and nobody ever sees it happen.

<figure class="wide">
<img src="media/sun-shadows-massan.png" alt="Directional sun with baked shadows off the heightmap." loading="lazy">
<figcaption>Directional sun with baked shadows off the heightmap.</figcaption>
</figure>

And the blob shadows, which are the reason I started all of this. Ground height comes from the extracted heightmap, and the shadow is a world-space circle laid on the floor, which the projection turns into a correctly proportioned ellipse without any extra work. It shrinks and fades as the character rises. That's the whole feature. The jump arcs are identical to 1992, but you can see where you'll land now.

<figure class="wide">
<video controls muted loop playsinline preload="metadata" src="media/demo-pathfinding-zoom.mp4"></video>
<figcaption>Click-to-move pathfinding and free zoom. Every move is still pad input into the emulator.</figcaption>
</figure>

Every one of these features defaults to off, and with the neutral settings the shader arithmetic reduces to multiplying by one and adding zero. Exact mode forces the features off entirely, so the pixel harness can't drift while I'm making things pretty. This is the only reason I still trust the 98.1% after four days of visual changes. Note what it protects, though: the extracted renderer. It says nothing about whether a generated backdrop still depicts the same room. Which brings me to the half of the project where nothing could be asserted.

## The other half: the art, and the gate that couldn't see

The generated art had no oracle, and couldn't have one, and this section is about what that turned out to mean in practice.

One admission first. The ideation conversation never discussed generating art at all. The only trace of it is a passing exchange about giving NPCs more variety, where the answer pointed out that outside the ROM there are no VRAM or palette limits, and that the hard part would be stylistic consistency: new art has to match the original's conventions or it reads as foreign against the extracted world. That's the whole second half of this project, described in one sentence, on day zero, by someone who hadn't seen any of it. I filed it under later.

The pipeline rasterises a room canvas from the extracted assets, pads it with black to the nearest aspect ratio the image API supports, and sends it image-to-image to Gemini at 4K with a prompt insisting the layout is authoritative. It resizes the result back to exactly 4x, crops the padding, and forces the void area black again. Room variants share art, so deduplicating by rendered identity turns 816 rooms into 647 unique canvases. The renderer then swaps the palette-index albedo for the generated image and keeps every other feature: lighting, shadows, ambient occlusion, the priority overlay, and the colour-RAM fade tracking, so HD rooms still fade correctly through doors.

It works, and to my eye the result looks better than I expected. I went through six style candidates before settling on a Vanillaware-ish painted register.

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
<figcaption>The register I didn't take. Photoreal renders of the same rooms look genuinely good and belong to a different game.</figcaption>
</figure>

<figure class="wide">
<video controls muted loop playsinline preload="metadata" src="media/demo-realistic-style.mp4"></video>
<figcaption>The same thing in motion, which is where it stops working.</figcaption>
</figure>

Quality control started with alignment, which is at least measurable. Take the generation, downscale it back to source resolution, run a Sobel filter on both, take the top decile of gradient magnitude as "strong edges", and measure the median distance from each source strong edge to the nearest generated strong edge. Require it under four pixels. Also FFT phase-correlate the two gradient fields and require a global shift of exactly zero. Three attempts, then mark the canvas rejected and fall back to pixel art. This gate catches the model reframing or rescaling the image, which it does surprisingly often, two canvases have never passed it in any style because the model insists on shifting them.

<figure class="wide">
<img src="media/route434-before-after.png" alt="route canvas before and after" loading="lazy">
<figcaption>What a good one looks like. Source render on top, generation below, same silhouette and the same walkable path.</figcaption>
</figure>

Then I walked into the church interior, which had passed the gate cleanly, and it was badly wrong. The model had read a small indoor room as an outdoor plaza. The walls had become floor. The statue and altar were gone. And the gate didn't care, because edges staying put is exactly what a content inversion with intact layout looks like.

Four more turned up the same way. A route canvas where the vertical cliff face became a top-down forest floor, so the walkable path ran across what now read as treetops, the waterfall collapsed into a puddle, and a ladder had been invented against a doorway that had none. Another where the model painted a river along the walkable dirt path, narrowing it and replacing half of it with water the player walks straight through. That one scored a median edge distance of 1.0 pixels and zero global shift. A perfect alignment report, for a canvas with a river through the middle of the road.

<figure class="wide"><div class="triptych"><img src="media/gate-426-source.png" alt="source" loading="lazy"><img src="media/gate-426-broken.png" alt="broken generation" loading="lazy"><img src="media/gate-426-fixed.png" alt="corrected generation" loading="lazy"></div><figcaption>Left: the source render. Middle: a generation that passed the alignment gate. The vertical cliff has become a top-down forest floor, the waterfall has collapsed into a puddle, and a ladder has been invented against the doorway. Right: the same canvas after the prompt and the gate were fixed.</figcaption></figure>

So: five semantically broken canvases, zero caught by the automated gate. All five were caught by a human looking at pictures, two by me noticing something looked off while playing, the rest in a manual pass over the batch.

I built a second gate that tries to see meaning. The conclusion is going to be that it doesn't work well enough, because the ways it fails are instructive. It works off the game's own heightmap. Project each cell's top face into the canvas, sample that patch in both the source render and the generation, and blur both until the brushwork averages out and only the material-level colour is left. Cells that are the same material in the source should still be the same material in the generation, wherever they sit in the room. Faithful restyling leaves small deviations scattered around, a semantic inversion leaves a big connected blob all drifting the same way. Reject if more than a quarter of the sampled cells are anomalous. Plus a second, embarrassingly specific rule for invented water: eight or more connected anomalous cells, drifting in a consistent direction, blue-shifted, not darkened (to separate a painted river from a painted shadow), and smoother than their reference cells, because water is flat and foliage is busy.

All three broken canvases I'd kept as backups now reject. Forty-five of the forty-six previously accepted canvases pass, and the one that flags was independently known to be degraded. So far so good.

It still can't see. Room 181 scored an anomaly fraction of 0.0, no coherent component at all, a median edge distance of 1.0 pixels (a flawless report on every axis I measure), and the statue in that room had been repainted as a living person. A pit in a floor got painted as a pool of water, the gate rejected two attempts and accepted the third, because the pool was dark and my "not darkened" condition let it through. Conifer trees appeared inside a cave, and the water detector was structurally incapable of firing because the colour drift went the wrong way on every one of its axes. And the two canvases that never pass the alignment gate sample one cell and twenty cells respectively, both below the thirty-cell minimum where the structural gate declares itself inconclusive and passes by default. On the rooms most likely to fail, the gate never runs at all.

The prompt is an archaeological record of the same process. It started at six clauses and grew one per disaster. Merging trees produced a clause about keeping their exact count and species. The church produced another that spells out which part of an isometric interior is wall and which is floor. Water must stay saturated blue. Clause eight reads in part "A flat wall decoration in the source stays a flat wall decoration; never reinterpret one as a ladder or any other three-dimensional object", after a test generation turned a wall banner into a ladder.

Character sprites presented the same problem in a different shape. All of a character's frames go into one grid and get regenerated in a single call, because that's what holds identity constant across poses. Alpha authority never leaves the original: the source silhouette, dilated two pixels, caps what can be opaque, so a generated sprite physically can't leak outside an honest outline. Identity drift between adjacent walk frames came out at a worst-case channel shift of 6 out of 255, which is excellent, and I was briefly pleased with myself. Then I watched them in motion. They shimmer. Hair tufts change shape, the scabbard drifts a few degrees, the dog's harness wobbles, and at 60Hz it reads as a faint boil. The metric measured colour consistency, which held up, and said nothing about shape consistency, which failed.

<figure class="wide">
<img src="media/nigel-sheet-hd.png" alt="One character, every frame, one generation. Sending them as a single sheet is what keeps the character the same person across poses." loading="lazy">
<figcaption>One character, every frame, one generation. Sending them as a single sheet is what keeps the character the same person across poses.</figcaption>
</figure>

<figure class="wide"><div class="triptych"><img src="media/nigel-walk-hd.gif" alt="Nigel walk cycle" loading="lazy"><img src="media/dog-walk-hd.gif" alt="dog walk cycle" loading="lazy"><img src="media/chicken-walk-hd.gif" alt="chicken walk cycle" loading="lazy"></div><figcaption>Sliced back into animations. The boil is easier to see than to describe.</figcaption></figure>

My honest conclusion after three generations of art packs: the gate will never be sound, because the question is semantic and the measurement isn't. The eyeball pass is doing the work, so the thing to do is make it cheap: one contact sheet, source beside generation, all forty-eight canvases in the current pack, one scroll. I should have built that first, instead of the two gates. I built the metrics because building metrics was more fun, and I'm writing that down so that at least next time I'll know I knew.

## How this actually got built

The build took four days, three substantive sessions, roughly twenty background subagents, and 62 messages typed by me. The first one was 172 characters:

> read ~/Downloads/landstalker-3d-spec.md - find the ROM in the same folder, do more research as you see fit, then let's start implementing this. if you need to amcq, do that

Twenty-six minutes later the agent had pinned a ROM revision by SHA-1 and asked whether I wanted a different dump. My answer, in full: "commit as you wish, and US is fine if you say it is. continue". Most of the rest of the project is in that register.

I categorised all 62 messages afterwards. About a third are taste and art direction. About a quarter are bug reports from playing the thing. A sixth are some variant of "go ahead". A sixth are managing the work queue: which subagent does what, in what order, what to parallelise. Roughly one is architectural.

The flattering way to read that distribution is that I set the constraints and then stepped back. I'd like to claim it. The transcripts don't really support it.

The constraints came from the spec, which I'd written in a separate conversation before opening an editor. It names the model (the original stays authoritative, replace only presentation) and it lists non-goals in imperative form, each with a one-line reason. Do not reimplement game logic. Do not fix the jumping. Do not build a free camera. Do not modify or redistribute the ROM. With a line above them that I never had to repeat: "Each one converts a bounded project into an unbounded one."

Those non-goals are what was left after the hour of pricing alternatives I described at the start: four options, three of them expensive, and the cheap one only becoming available once I stopped trying to fix the physics. They held across 62 messages without me ever once defending them, which I think is because they had already been argued.

Several decisions came close to the line (click-to-move pathfinding and the step-up jump assist both sit right on the boundary between presentation and gameplay), and the agent held the line itself, in the spec's own vocabulary, and wrote the reasoning into the commit messages. Two of my three session-opening prompts were handover documents that the previous session's agent had written for me, which I pasted without editing. The most technically detailed "human" message in the corpus is one of those, and I didn't write a word of it. On day four I described my own project back to the agent to check that I understood it, and got three corrections and two omissions in return.

What I actually contributed came almost entirely from having the game open in front of me:

> btw the sprites seem to be upside down, the stats and Nigel are, in our version

> hmm, the original vanillaware looked better, more detailed. this one looks like a flash game, sort of. any ideas why, and how we can get it more like the initial version I fell in love with?

> ok cool. btw. I noticed a small bug in the interior, the church looks broken, at least with the previous HD backdrop, something to check maybe

That last one, typed in passing, is the church from the previous section, and it's the reason the structural gate exists.

<figure class="wide">
<img src="media/sprites-upside-down.png" alt="sprites rendered upside down" loading="lazy">
<figcaption>The first of those reports. Billboards were rendering vertically flipped, character and torch flame both. The inset bottom right is the emulator's own output, which is what it should have looked like. The camera is y-down, so the sprite texture needed its vertical flip disabled.</figcaption>
</figure>

The mobile controls show the same thing. A subagent built a touch layer and verified it exhaustively, with real Chrome touch events dispatched through the debugging protocol, proving that tap and drag and flick and pinch all produced the right pad output, 850 tests green, screenshots attached. Every gesture worked. I put it on my phone, played for twenty minutes, and reported: "right now I don't even know how to swing the sword". It had shipped a gesture-only scheme with no visible buttons. The verification was complete and correct and the thing was unusable, because nothing it could check would have told it that.

The irritating part is that the right shape had already been specified. The same ideation conversation had described it before any code existed: a screen-relative stick that appears under the thumb, snapping to the world axes, with visible buttons kept out of the play area. That's roughly what the touch layer became on the second attempt. The prediction was there. What nobody predicted was that an agent would ship 850 passing tests around the wrong shape first.

<figure class="wide">
<img src="media/phone-touch-layer.png" alt="The replacement: a floating stick under the left thumb and actual visible buttons under the right." loading="lazy">
<figcaption>The replacement: a floating stick under the left thumb and actual visible buttons under the right.</figcaption>
</figure>

Here is the comparison I promised at the top. The two halves of this project were built in the same week, with the same tools and the same coding agent. The emulator, extractor and renderer half had cheap sound oracles at every step: a reference implementation to diff against, a byte-exact assertion, a pixel percentage, 856 tests in under five seconds. That half converged in days, ran largely unsupervised through background agents, and I honestly couldn't tell you what most of the commits contain. The art half has no oracle, because "is this canvas semantically faithful" isn't a question you can assert on. That half needed me for every judgment, produced five semantic failures that no automated check caught, and after three generations of art packs is still not settled. The only thing that differed was whether the feedback loop could run without me.

The cheap feedback also changed which work was worth doing at all. Working alone, I'd never have written a C++ oracle harness for a hobby project. Nobody does. You spot-check three rooms, decide it looks fine, and pay compound interest on that decision for the rest of the project, usually around week three, when one room in twenty has a corrupt corner and you've forgotten how the decoder works. Here it cost almost nothing, so I took it.

Without agents this isn't a four-day project, it's most of a year of evenings for someone who already knows 68000 assembly, VDP internals and three.js. More likely, it's not a project at all. Things like this die at a specific place: month two, the decoder is 95% right, one room renders garbage, there's no oracle because building the oracle felt like a detour, and the debugging plateau runs for weeks with nothing to show for it. Having a test suite is what gets you through that part.

What is left: a WebAssembly build, which moves the core into the browser and makes the whole thing a static page instead of a server per player. And every remaining NPC sprite sheet, which I'll probably not do.

So are more of these coming? I think so.

What made this cheap is that somebody had already spent years reverse engineering Landstalker: a disassembly that reassembles byte-identical, a C++ format library, an editor, two randomizers. That's a ton of careful unpaid work, and the whole project stands on it. Which seems to say this only works for games that already have all that, and not many do.

I don't think that's right, and the reason is sitting in the harness. It never checked my decoders against the disassembly. It checked them against the running game's own framebuffer and reported a percentage. That loop needs no prior art at all: decode a room, draw it, diff it against what the emulator puts on screen, read the number. The prior art made this faster. It was never what made it possible. The oracle ships with the game, and libretro cores exist for most of the hardware anyone is nostalgic about.

Two things temper it. Landstalker stores a real heightmap, per-cell height and collision flags, because it was doing 3D on a 68000 in 1992. That's the only reason there's any geometry here to light or cast shadows from. A flat 2D game hands you a painted plane and nothing to project, and what you would be doing is upscaling, which is a duller project, though.

The other is the half of this article you've just read. The part that would supposedly scale to twenty games is the art, and the art is the part with no oracle, that needed me for every judgment, that produced five semantic failures nothing automated caught, and that's still not settled. Most of what people mean by a remaster is taste, and taste stayed at human speed.

So, hedged exactly as far as I believe it: more of these are coming, and they will be made one person at a time, for one game that person loved, over a handful of evenings, rather than by anybody doing twenty.

There's a group for whom this is economics rather than affection, and it's not us. None of it is distributable. Sega could ship this tomorrow, I can only build it for myself. Which, going back through the ideation conversation, is the only thing I ever asked for:

> I just want this for myself

---

The code isn't public yet. When it is, it goes up without the ROM and without the extracted assets, which is the only way it can go up.
