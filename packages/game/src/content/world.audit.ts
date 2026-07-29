/**
 * A one-shot report on the world, for the loop rather than for CI.
 *
 * `pnpm --filter @dotbot/game exec tsx src/content/world.audit.ts`
 *
 * The tests assert a ledger; this prints one. Both matter and they are not the same
 * tool: a test tells you whether anything broke, and this tells you what to fix next.
 */
import { auditCity } from "../cityQuality";
import { polygonContains } from "../geometry";
import { defaultGameConfig } from "../config";
import { validateInsertionMap } from "../insertion";
import { auditBuildingFloorQuality, auditDotPlacement } from "../mapQuality";
import { worldMap } from "./world";

const lines: string[] = [];

lines.push(`=== ${worldMap.name} — ${worldMap.width} x ${worldMap.height} ===`);
lines.push(`buildings ${worldMap.buildings.length}`
  + `  floors ${worldMap.buildings.reduce((n, b) => n + b.floors.length, 0)}`
  + `  objects ${worldMap.outdoor.objects.length}`
  + `  regions ${(worldMap.outdoor.regions ?? []).length}`
  + `  surfaces ${(worldMap.outdoor.surfaces ?? []).length}`
  + `  dots ${worldMap.outdoor.dotSpawns.length}`);

lines.push("");
lines.push("--- validateInsertionMap (a squad of 3 fits at every arrival point) ---");
try {
  validateInsertionMap(worldMap, 3, defaultGameConfig.botRadius);
  lines.push("clean");
} catch (error) {
  lines.push(String(error instanceof Error ? error.message : error));
}

lines.push("");
lines.push("--- auditCity ---");
const city = auditCity(worldMap);
lines.push(city.length ? city.map((i) => `[${i.kind}] ${i.subject}: ${i.message}`).join("\n") : "clean");

lines.push("");
lines.push("--- auditDotPlacement ---");
const placement = auditDotPlacement(worldMap);
lines.push(placement.length ? placement.map((i) => `[${i.kind}] ${i.message}`).join("\n") : "clean");

/**
 * Outdoor scenery standing inside a building.
 *
 * Not a rule in `cityQuality` yet, and it should be. The temple's abandoned spur ran 470
 * units south into the pyramid, so a railway wagon was parked inside the terrace wall and
 * on top of a Dot in the tomb chamber — and the only reason it was ever noticed is that
 * `auditDotPlacement` complained about the Dot. Nothing checks the wagon itself.
 */
lines.push("");
lines.push("--- outdoor objects standing inside a building ---");
/** The object's four corners and its centre — enough to catch anything worth catching. */
const probes = (o: { x: number; y: number; w: number; h: number }) => [
  { x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x, y: o.y + o.h },
  { x: o.x + o.w, y: o.y + o.h }, { x: o.x + o.w / 2, y: o.y + o.h / 2 },
];

const trespass = worldMap.outdoor.objects.flatMap((object) =>
  worldMap.buildings
    // Against the PLAN, not the bounding box. A turntable sits inside the roundhouse's
    // bbox and 100 units clear of the shed itself, and a check that cannot tell those
    // apart reports twenty false positives and buries the four real ones.
    .filter((building) => {
      const plan = building.outline && building.outline.length >= 3 ? building.outline : null;
      if (plan) return probes(object).some((at) => polygonContains(plan, at));
      const fp = building.footprint;
      return object.x < fp.x + fp.w && fp.x < object.x + object.w
        && object.y < fp.y + fp.h && fp.y < object.y + object.h;
    })
    .map((building) => `${object.id} (${object.kind}) at ${object.x},${object.y} is inside ${building.id}`));
lines.push(trespass.length ? trespass.join("\n") : "clean");

for (const building of worldMap.buildings) {
  const issues = auditBuildingFloorQuality(worldMap, building.id);
  lines.push("");
  lines.push(`--- ${building.id} (${building.floors.map((f) => f.label).join(", ")}) ---`);
  lines.push(issues.length ? issues.map((i) => `[${i.kind}] ${i.message}`).join("\n") : "clean");
}

// eslint-disable-next-line no-console
console.log(lines.join("\n"));
