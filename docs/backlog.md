# Active backlog

Status: **reviewed with the owner, 2026-07-31.** This is the only
repository-level TODO list. Completed milestone briefs, historical spec
questions, and old review notes are not active tasks unless promoted here.

## Release verification

### Full-world traversal verification

Complete one post-fix production-renderer traversal at normal speed:

- Downtown → Main Street gate → works road → turntable extraction pad.
- Downtown → Third Avenue gate → fair drive → midway.
- Midway → east trail → Temple plaza.
- Yard → spur gate → end of the line.
- Enter and leave the roundhouse, box, pavilion, Temple, and observatory; take
  both directions of every stair transition.

Automated map audits already pass; this is the remaining hands-on release proof
required by the map-building contract. Watch especially for snags on the Temple
grand stair, the roundhouse's curved roll-up doors, and the pavilion's four-way
approach.

Disposition: **retain as a release verification gate, not a product feature.**
It should produce a dated result, not new map work unless the traversal exposes
a defect.

## Product decisions closed in this review

- The shipped simultaneous-dash parry/clash is the chosen combat counterplay.
  The earlier alternatives are archived in
  [`archive/combat-counterplay-alternatives-2026-07-29.md`](archive/combat-counterplay-alternatives-2026-07-29.md).
- No standalone exterior-door roof-peek task. Reopen only from a visible defect.
- No extra Temple forest traversability task.
- No extra big-top breathing-room task.

## Not backlog

- The M0–M8 roadmap, NET-1, PERF-1, and UX-1 are completed and have reports in
  [`../handoffs`](../handoffs).
- Old “open questions” in the game, systems, and map/editor specs are historical
  discovery prompts. Current code and the world/run bible supersede them.
- Large source files such as `simulation.ts` are maintainability hotspots, not
  performance defects by themselves. Split them only as part of a behavior
  change with focused tests, not as cosmetic cleanup.
