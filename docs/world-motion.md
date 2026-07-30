# Motion in the world, and who owns it

**Motion is wanted.** Start here, because this document used to start somewhere else and
the difference mattered.

The goal, in Mike's words: *"to make the world come alive."* Concretely asked for — the
merry-go-round slowly turning, trees swaying a bit, leaves falling and disappearing after a
while, a subtle trail left in grass or dirt as you move through it that fades, and later a
vehicle of some kind plus various transportation and fast-travel mechanisms.

## The rule this does not break

`renderer/model/tone.ts` rule 4 says a moving thing is either animated or not drawn. It
came from **one specific defect**: smoke drawn as a puff of frozen circles over a chimney,
which reads as a solid blob of debris. That is the whole of it. A moving thing frozen into a
still mark is an artefact.

It is **not** a ban on motion, and it has been misread as one repeatedly — badly enough to
change what exists in the world rather than how it is drawn:

- a chairoplane was **deleted** rather than given swinging seats, on the grounds that a ride
  at rest has no motion to draw;
- the entire fairground was justified as derelict *because* stillness satisfied the rule,
  and this document's earlier version called that "making a virtue of it";
- braziers, chimneys and fans are all drawn cold, and only the fans were ever the point.

Mike has corrected this more than once, and each correction was lost at the next context
compaction. Hence the emphasis, in three places: here, in `tone.ts`, and in
`docs/map-building-contract.md` §2.0.

**Never cite rule 4 as a reason to cut, avoid or restyle a subject because it would need to
move.** If a subject should move, animate it.

## The line that actually matters

Not "should it move" but **who owns the motion**.

**AMBIENT motion is cosmetic.** A pure function of the client clock. It touches no
simulation state, is never replicated, and if two players see slightly different frames of
it nothing is wrong. A turning ride, a swaying canopy, drifting leaves, flowing water,
footprints fading out of the dirt. Netcode risk: zero.

**TRAVERSAL motion moves a DotBot.** That is simulation. It has to live in `packages/game`,
be deterministic, be replicated, and be predicted client-side, or a player gets dragged
downstream on the server and snaps back on their own screen.

The second kind splits again by cost:

- **A CURRENT is cheap.** A region plus a velocity vector, added to a bot's movement the
  same way a dash impulse already is. No new entity, no attachment, no ownership question.
  A river that carries you downstream is a few days of work, tests included.
- **A VEHICLE is expensive.** A gondola, a mine cart, a handcar. The bot's position becomes
  relative to a mover, which means a moving reference frame inside a predicted netcode —
  the classic hard problem, because the platform's position at the tick the client predicts
  and at the tick the server simulates must agree exactly.
- **FAST TRAVEL is somewhere in between,** and cheaper than it looks, because a teleport
  between two authored points is a state change rather than a moving frame. The hard part is
  not the motion, it is what stops a squad using it to escape a fight.

All three are wanted. They are not worth having in the same milestone.

## What ambient motion costs, and why it is cheap here

The renderer builds its geometry ONCE — `buildMapArt(map)` runs at load and every frame
after that only moves containers. The parallax pass already proved the pattern: "a transform
per building per frame, and nothing is redrawn."

Everything on the ambient list fits that pattern:

| effect | mechanism | per-frame cost |
| --- | --- | --- |
| a ride turning | its moving parts in their own `Container`, set `rotation` | one transform |
| canopy / tree sway | a `Container` per tree, small rotation from a per-id phase | one transform each |
| leaves, dust | a fixed pool of sprites recycled oldest-first, age → alpha | pool size, capped |
| trails in grass | the same: a pool of soft stamps dropped at the walker's feet | pool size, capped |

The one thing that would genuinely cost is `g.clear()` plus a redraw per frame, because that
re-tessellates the geometry. Nothing on this list needs it. **No `RenderTexture` either** —
a pool of fading stamps gets the same result as painting into a texture without the
read-back or the per-frame draw call.

Two things to hold to when implementing:

- **Spawn only what is on screen.** `GameRenderer.visibleWorldBounds()` already exists, for
  audio earshot; particles should use the same answer.
- **Respect `reducedMotion`.** The renderer already carries the preference, and camera
  look-ahead already honours it. Ambient motion is exactly what that setting is for.

## What exists now

`renderer/model/modelMotion.ts` is the general mechanism; `modelWater.ts` predates it and
stays as it is. Four of the five things on the ambient list are shipped.

| effect | state |
| --- | --- |
| water breathing | `modelWater`, two layers in opposite phase |
| the carousel and the waltzer turning | slowly, unevenly, never backwards |
| canopies swaying | one wind, gusts crossing the map at 0.35 units/ms |
| leaves falling | a fixed pool of 48, off visible canopies only |
| trails in grass and dirt | NOT DONE — the pool machinery is shared, so this is small |

**The mechanism.** A glyph tags its own moving part with `movingPart(g, kind, about)` and
gets back a `Graphics` to draw into; a builder calls `collectMovers` and hands the list up;
the renderer calls `animateAmbient` once a frame. One transform per part, nothing redrawn.

Two things learned by doing it that are not obvious from the outside:

- **A part is LIFTED off the glyph onto the layer it belongs on.** For a tree that is
  `outdoorForeground`, the layer that draws above bots, because a canopy is passable and you
  walk under it. It also clears a pixi 8 deprecation — adding children to a `Graphics` is
  going away — so ownership lives in a `WeakMap` rather than in `g.children`.
- **Reduced motion parks everything at its resting pose exactly**, which is also what makes
  the lab's stills trustworthy.

**Reviewing it.** `?worlds&play=1` animates the lab on a bare `requestAnimationFrame` — the
same `animateAmbient` the renderer calls, which is possible precisely because ambient motion
needs no socket, no snapshot and no input. `?t=<ms>` renders one still at a given clock
instead, and `&pick=` narrows the sheet to one frame so the same crop can be shot at two
clock values. Not `?at=` — that name is taken by `spawnAt`.

## Where the current regions stand

Every one of the four has somewhere obvious for ambient motion:

- **The fairground.** The carousel and the waltzer TURN. Wind moving a ride nobody maintains
  is a better version of the derelict story than a ride welded still. The big top's canvas
  should breathe, and does not yet.
- **The temple.** The cenote breathes. The forest is the largest sway surface in the world and
  it sways; it also sheds.
- **The yard.** A working depot whose motion is engines, and there are no engines yet.
- **Downtown.** Street trees sway. Still the first honest place for a vehicle.

## What a thicket does not do, and why it is written down

Thickets do NOT sway, deliberately. On a tree the drawn canopy is not the collider — the
trunk is — so moving the canopy says nothing untrue about where you can go. A thicket's
silhouette IS its collider: it is the one piece of vegetation that means *go round*, and
sliding its outline a few units would be a lie about cover in the region where cover matters
most. If a later pass wants a thicket to rustle, it needs a mechanism that leaves the
silhouette alone.
