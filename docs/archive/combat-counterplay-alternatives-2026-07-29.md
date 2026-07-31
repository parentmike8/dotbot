# Combat counterplay — three options for a parry

Status: historical design exploration, written 2026-07-29. The recommendation
below predates the current implementation and is not an active TODO.

**Chosen implementation (2026-07-31):** opposing plated, non-ambient bots whose
committed dashes meet resolve an authoritative `clash`: neither loses a plate,
both recoil, and prediction plus audiovisual feedback present a distinct parry
cue. The relevant behavior lives in `packages/game/src/simulation.ts`, with
tuning in `packages/game/src/config.ts` and client prediction in
`apps/client/src/game/prediction/LitePredictor.ts`. The owner chose this shipped
direction on 2026-07-31. This archived note is retained only as design history.

Three ways to give DotBot combat a defensive read. They are presented in the order they were
arrived at, because each one exists to fix a specific flaw in the one before it. The
recommendation is **Option C**, but the reasoning matters more than the verdict — see
"Questions for reviewers" at the end.

---

## Background: what a fight is today

Everything below turns on three facts about the current build.

**1. Dash is the only way to deal damage.** A hit needs closing speed ≥ `damageSpeed` 360.
Walking is 230, `botSpeed` is 168, knockback is 320. Only `dashSpeed` 640 clears the bar, on a
1300ms cooldown for 145ms. (Mines are the one bounded exception, and they take exactly one
plate.)

**2. Attacking is unconditionally free.** In `damageBot`
([simulation.ts](../../packages/game/src/simulation.ts) ~2652) the target gets invulnerability,
knockback, and a broken plate. **The source gets nothing** — whether the dash broke armour or
found an exposed arc:

| Outcome | Target | Attacker |
|---|---|---|
| `armourHit.core === false` | plate breaks, knocked back, 720ms invulnerable | unaffected |
| `armourHit.core === true` | downed | unaffected |

There is no wrong moment to dash. That is why a duel reads as a cooldown race rather than a
read, and it is the actual defect all three options address.

**3. Aim is already decoupled from your body — but only while moving.** `facing` follows the
**stick**, not displacement ([simulation.ts:2228](../../packages/game/src/simulation.ts)):

```ts
if (length(direction) > 0.05) bot.facing = Math.atan2(direction.y, direction.x);
```

Surviving plates re-seat best-first toward travel. So pointing your good plate at a threat
already means *moving toward it*. A defensive skill exists and is expressible today. Nothing
rewards it.

### The arc geometry that constrains everything

A plate spans `2π/3 − 0.24` ≈ **106°**. This is the single most important number in the
decision:

| Plates | Exposed | What that means |
|---|---|---|
| 3 | ~42°, in three 14° slivers | the core is **unhittable**; you *must* break armour first |
| 2 | ~148°, mostly rear | getting behind now wins |
| 1 | ~254° | nearly dead |
| 0 | 360° | anyone who touches you wins |

**At full plates, breaking armour is the only legal move.** Any design that punishes it
punishes the only thing a player can do.

### The control budget

A stick, dash, three bays, swap, ping. That is already at the limit for a thumb on a phone,
and "anyone can pick it up in a browser" is the product. **No option here may add a button.**
An earlier version of Option B was rejected on exactly this ground.

---

## Option A — Unconditional bounce

> Any dash that breaks an intact plate bounces the attacker and cancels their dash.
> A dash that finds an exposed arc is clean.

**Defender's input:** none. It is automatic.

**The idea:** the plate stops being an HP pip and becomes a parry. Hitting armour becomes a
mistake you pay 1.3 seconds for, so the attacker has to circle to the gap instead of mashing
dash. Costs no new controls.

**Why it fails:** the arc geometry above. At three plates the core is unhittable, so breaking
armour is the *only* available opening — and this punishes it. Both players get a reason to
let the other commit first, and two players both waiting is circling. In an 8-minute run with
an extraction clock, that dead time is expensive.

It also punishes symmetrically regardless of skill: a perfectly-read engage and a blind one
cost the attacker exactly the same.

**Verdict: rejected.** But it contains the right instinct — the attacker should sometimes pay
— and Option C is this idea with a condition attached.

---

## Option B — Brace

> Hold the dash button after the dash ends and you plant. Braced, you aim freely but go
> nowhere. A dash into a braced plate bounces the attacker **and the plate does not break**.

**Defender's input:** a held button, and a visible, immobile commitment.

### The control

Press fires the dash **immediately**. If the button is still held when `dashActiveMs` reaches
0, the bot plants. Release resumes normal movement. One continuous gesture — lunge, then set
your feet.

This inversion is essential. Gating the dash behind a hold timer to distinguish tap from hold
would add ~150ms of latency to the only offensive verb in the game, which is disqualifying on
its own.

`dash` is currently an **edge** (consumed on the tick it is considered,
[simulation.ts:893](../../packages/game/src/simulation.ts)). Brace needs a **level**, so
`InputCommand` gains a separate `brace?: boolean` that is *not* cleared with the edge inputs.
The client must track release on `pointercancel` and `pointerleave` too, or a thumb sliding
off the button leaves you braced forever.

### The verb

While braced:

- `moveVelocity = 0`. This falls out of `ramSpeedToward` reading own movement, so **a braced
  bot cannot damage anyone** — no extra code.
- **Facing still follows the stick.** This is the whole value: it decouples aim from travel,
  which is otherwise impossible in this game.
- Knockback suppressed — braced is an anchor, consistent with the existing separation rule
  ("the mover yields, a standing bot is an anchor").
- **All channels cancelled and blocked.** Non-negotiable: coverage channels only require
  staying in range, not standing still, so without this you could brace *and* extract at once
  — a parry that also wins the run.

A hit into a braced target's **exposed arc** still downs them. Bracing does not save you from
being read.

**Why the plate survives here but not in Option C:** the costs differ. C costs a step of
movement; B costs your entire mobility, your channels, and your ability to deal damage, all
telegraphed in advance. If B turtles in play, breaking the plate is a one-line downgrade.

### Strengths

- **Highest ceiling.** It is the only option that adds a genuinely new expressive axis rather
  than re-weighting an existing one.
- **A real read.** The attacker can see the trap and choose not to take it; the defender is
  betting on the attacker's impatience.
- **Self-limiting.** Braced you cannot extract, capture, loot, chase, or escape. In a timed
  extraction run, standing still is losing — so the classic turtle failure never gets going.

### Costs and risks

- **Thumb-rest misfire.** Players hold and mash buttons. A dash button that becomes a stance
  when held *will* fire accidentally, constantly, especially on mobile. This is the strongest
  single argument against it.
- **Modality.** One button meaning two things by duration is exactly what a pick-up-and-play
  browser game should avoid.
- **New wire field.** `DotBotEntity.braced` must serialize
  ([wire.ts](../../packages/protocol/src/wire.ts)) and be mirrored in `LitePredictor`, or the
  local player rubber-bands every time they brace.
- **Mandatory visual tell.** An unreadable stance is a coin flip, not a mind game, and it
  breaks the standing rule against invisible state. The attacker must see it before committing.
- **AI work.** Red stand-in squads need to brace *and* bait braces (`tryAiDash`). Ambient
  greys must never brace — they are dumb obstacles by design.

**Verdict: highest ceiling, highest cost.** Worth building, but not first.

---

## Option C — The closing counter (RECOMMENDED)

> A dash that lands on the plate of a defender who is **walking into it** bounces the attacker
> and eats their dash. The defender still loses the plate.

**Defender's input:** push the stick toward the incoming attack. No new control — and because
`facing` follows the stick, that same push is what points your best plate at them. The
defensive verb has been sitting in the movement stick the whole time; nothing rewarded it.

### Behaviour

On a hit where `armourHit.core === false`, if the target was closing on the source at or above
`counterClosingSpeed`:

1. Bounce the source along `-away` at `counterBounceSpeed` for `counterBounceDurationMs`.
2. `source.dashActiveMs = 0` — the dash is over.
3. `source.dashCooldownMs = config.dashCooldownMs` — full cooldown, even if the dash came from
   an overcharge charge. The overcharge already bought the extra attempt.

The target's outcome is **unchanged**: the plate still breaks, knockback still applies,
invulnerability still starts. The counter denies the follow-up; it does not negate the hit.

### Why the condition fixes Option A

Against a defender who is **not** closing, the hit table is byte-for-byte what ships today. So
there is no new tax on attacking and no reason to circle. The punish exists only when someone
deliberately steps into your dash — a skill check, not a tax.

### Strengths

- No new control, no modality, nothing to teach, nothing to mis-press.
- No wire change, no AI change, no new visual state — the recoil itself is the feedback, and
  two bodies flying apart is the clearest possible statement.
- **Rewards forward play.** The counter to aggression is more aggression, which suits a
  brawler and cannot become turtling.
- Self-limiting: closing means eating the hit. You trade a plate for tempo.
- Smallest possible diff — one condition inside an existing function, on a value the sim
  already computes.

### Weaknesses

- **Shallower than B.** The payoff is "you survived the engage and got 1.3 seconds," not a
  hard read with a hard punish.
- **May be too subtle to notice.** The biggest risk: if players never realise it is a
  mechanic, it is just physics that occasionally feels good. Presentation carries more weight
  here than in B.
- The defender still bleeds a plate on every exchange, so it slows the death spiral rather
  than reversing it.
- Threshold tuning is load-bearing — set too low and it fires on accidental drift.

### Exact change

In `damageBot`, after the `armourHit.core` early-return, before the existing target knockback.
`away` already exists and points from source toward target, so the attacker's bounce is `-away`.

```ts
// The defender stepped into it. Landing on an aimed plate costs the attacker the
// follow-up — the hit still lands, but the tempo goes the other way.
const closing = this.ramSpeedToward(target, source);
if (
  this.config.counterEnabled &&
  !target.isAmbient &&
  closing >= this.config.counterClosingSpeed
) {
  source.knockbackVel = scale({ x: -away.x, y: -away.y }, this.config.counterBounceSpeed);
  source.knockbackMs = this.config.counterBounceDurationMs;
  source.dashActiveMs = 0;
  source.dashCooldownMs = this.config.dashCooldownMs;
  countered = true;
}
```

`ramSpeedToward` ([simulation.ts:2637](../../packages/game/src/simulation.ts)) already returns
exactly the right number: own movement only (`moveVelocity`, not `velocity`, so wearing a shove
is not defending), and only the component pointing at the other body.

`!target.isAmbient` matters — a grey wandering into you must not parry.

### Config

| Key | Value | Reasoning |
|---|---|---|
| `counterEnabled` | `true` | A/B flag; the whole feature switchable in one place |
| `counterClosingSpeed` | `140` | ~60% of `playerSpeed` 230 — a deliberate step in, not a drift. Tune first if it feels accidental. |
| `counterBounceSpeed` | `380` | above `knockbackSpeed` 320; the attacker carried dash momentum |
| `counterBounceDurationMs` | `180` | longer than `knockbackDurationMs` 140, so the recoil reads as distinct |

### Wire and presentation

The `hit` SimEvent gains an optional `countered?: boolean`. **Do not extend `HitResult`** — it
is documented as exactly two outcomes tied to the plate model, and a counter is still a
`plateBreak`.

The counter must look different from a plain hit. Given the "too subtle" risk above, treat
this as part of the feature, not polish: a harder impact ring plus the attacker's physical
recoil. See `ImpactFeedback.ts` and the hit path in `GameRenderer.ts`.

### Prediction

Highest-risk part of the change. The attacking client predicts its own contact
([LitePredictor.ts](../../apps/client/src/game/prediction/LitePredictor.ts) already stops a
predicted dash at contact). `dashActiveMs` and `dashCooldownMs` are tracked locally, so without
mirroring, client and server disagree for up to a full cooldown after every counter. On a
confirmed `countered` hit where the local bot is `byBotId`, zero `dashActiveMs` and set
`dashCooldownMs`. Verify with the existing netgraph counters (`predictionErrorPx`,
`correctionsPerSecond`) before and after.

### Tests

Prove each fails before it passes.

1. **Counter fires.** Target closing ≥140 into an attacking dash → attacker `dashActiveMs === 0`,
   `dashCooldownMs === config.dashCooldownMs`, `knockbackMs > 0`.
2. **No counter on a retreating defender** → attacker untouched. This is the regression that
   keeps aggression free.
3. **No counter below threshold.** Closing at 100 → attacker untouched.
4. **The hit still lands.** Every countered case still costs the target exactly one plate and
   starts invulnerability. The counter is not a negation.
5. **Core hits are never countered.** Closing target, hit in an exposed arc → downed, attacker
   untouched. Finding the gap is always clean.
6. **Greys cannot counter.** `isAmbient` target closing → attacker untouched.
7. **Bounce direction.** Attacker `knockbackVel` dotted with `away` is negative.
8. **Flag off is a no-op.** `counterEnabled: false` reproduces current behaviour exactly.
9. **Determinism holds.** Existing determinism test stays green.

---

## Side by side

| | A · Unconditional | B · Brace | C · Closing counter |
|---|---|---|---|
| Defender input | none | hold dash | push stick toward attacker |
| New control | no | **yes (modal)** | no |
| Plate survives the parry | no | **yes** | no |
| Attacker punished when | always, on armour | only vs. a braced plate | only vs. a closing defender |
| Aggression taxed | **yes, always** | no | no |
| Wire change | no | yes (`braced`) | optional flag on `hit` |
| Predictor work | dash cancel | full state mirror | dash cancel |
| New visual state | no | **required** | recoil only |
| AI work | no | **brace + bait** | no |
| Accidental trigger | n/a | **likely on mobile** | unlikely |
| Depth added | low | **high** | medium |
| Risk | **breaks the opening move** | modality, misfires | too subtle to notice |
| Diff size | small | large | **smallest** |

---

## The prerequisite (please weigh this before picking)

All three deepen a system players are not currently forced to enter. Nothing in a run makes two
squads want to be in the same room at the same minute: dot spawns are scattered, and contracts
are **private and per-player**, so my objective never puts me near yours.

**A parry in a game where nobody has to fight makes fights rarer, not better.**

If only one change ships, it should not be any of these — it should be a public timed objective
(one building lights up mid-run, visible to every squad, holding the run's best blueprint) with
the extraction pads closing in sequence behind it. That turns 8 minutes of wandering into
scavenge → contest → run, and it is what makes combat depth get used at all.

Option C is cheap and additive enough to build alongside it. Option B should wait for evidence.

---

## Questions for reviewers

The places where outside opinion actually changes the decision:

1. **Is C too subtle?** It has no icon, no stance, no new state — just a recoil. Does that read
   as a mechanic players learn, or as physics that occasionally feels nice? This is the main
   reason to prefer B despite the cost.
2. **Is B's thumb-rest misfire fatal, or solvable?** A short engage delay (~200ms after the
   dash window) would filter most accidental holds. Does that fix it, or does it just make
   brace unreliable when you need it?
3. **Should C's plate survive after all?** That makes it a soft B with no control change — much
   stronger, but it removes the attacker's only guaranteed progress and risks re-introducing
   A's stalemate.
4. **Is `counterClosingSpeed` 140 the right commitment?** Too low and it fires on drift; too
   high and only a dash-into-dash triggers it, which already exists.
5. **Does any of this matter before convergence pressure exists?** If the honest answer is no,
   the right move is to build the public objective first and revisit combat with real fight
   data.

## Do not

- Do not add a new button.
- Do not gate the dash behind a hold timer.
- Do not make a counter unconditional (Option A).
- Do not extend `HitResult`.
- Do not let a counter or brace prevent a core hit from downing.
- Do not add stat modifiers of any kind. Upgrades expand options, never numbers
  (systems spec §2).
