# Motion in the world, and who owns it

A decision record, not a contract. It exists because the obvious next question about a
world with a river, a fairground and a mountain in it is "can things move", and the answer
has a shape worth writing down once.

## The rule it looks like it breaks

`renderer/model/tone.ts` rule 4: **nothing in motion is drawn statically.** No smoke, no
steam, no spray, no fan blades, no flapping. A frozen moving thing reads as an artefact and
promises animation the renderer never delivers.

Every consequence drawn from that rule so far has been subtractive — a stationary guard
grille instead of fan blades, no smoke over the depot. That was the correct reading while
the renderer had no animation. But the rule's own justification is a conditional, and once
the renderer *does* deliver, it points the other way: draw the moving thing moving.

So the rule is not a ban on motion. It is a ban on *pretending*.

## The line that actually matters

Not "should it move" but **who owns the motion**.

**AMBIENT motion is cosmetic.** A pure function of the client clock. It touches no
simulation state, is never replicated, and if two players see slightly different frames of
it nothing is wrong. Flowing water, swaying canopy, drifting dust, a turning windmill.
Cost: one `Graphics` redrawn per frame. Netcode risk: zero.

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

Both are worth having. They are not worth having in the same milestone, and a current buys
most of the delight for a fraction of the risk.

## Where the current regions stand

None of the four regions on the sheet needs animation to be finished, and one of them makes
a virtue of that. **The fairground is derelict**, so every ride on it is genuinely still: a
rusted wheel that does not turn is the truth about the place, and rule 4 is satisfied with
no animated frames at all. The temple's cenote is standing water, which breathes rather
than flows. The yard is a working depot whose motion is engines, and there are no engines.

The first real use for ambient motion is water with a direction in it — a creek, a mill
leat, a shoreline — and the first real use for a current is the same water once a player can
be carried by it. Neither is blocked by anything except being asked for.
