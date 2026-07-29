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

## Where the current regions stand

Every one of the four has somewhere obvious for ambient motion, and none of them has any:

- **The fairground.** The carousel and the waltzer should turn, slowly and unevenly. This is
  not a compromise on the derelict story — *wind* moving a ride nobody maintains is a better
  version of it than a ride welded still. The big top's canvas should breathe.
- **The temple.** The cenote is standing water, which breathes rather than flows. The forest
  is the largest sway surface in the world.
- **The yard.** A working depot whose motion is engines, and there are no engines yet.
- **Downtown.** Street trees, and the first honest place for a vehicle.
