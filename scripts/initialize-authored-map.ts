import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pixelCityBlockMap } from "../packages/game/src/content/pixelCityBlock";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "packages/game/src/content/authored/pixel-city.json");

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(pixelCityBlockMap, null, 2)}\n`, "utf8");
console.log(`Wrote ${output}`);
