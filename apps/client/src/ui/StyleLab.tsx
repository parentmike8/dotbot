import { useEffect, useRef } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { shieldArcSpan } from "@dotbot/game/shields";
import type { Building, DotSpawn, FloorPlan, Rect, Vec2 } from "@dotbot/game/types";
import { downtownMap } from "@dotbot/game/content/downtown";
import { quaysideMap } from "@dotbot/game/content/quaysideDepot";
import { buildMapArt } from "../game/renderer/mapArt";
import { buildFloorModel } from "../game/renderer/model/modelFloor";
import { buildGeometryProof } from "../game/renderer/model/geometryProof";
import { drawDotDisc } from "../game/renderer/dotArt";
import { drawCatchLight, drawGroundShadow } from "../game/renderer/grounding";
import { V } from "../game/renderer/model/tone";

/**
 * Style lab: one authored floor, drawn once, at a fixed camera.
 *
 * Deliberately not a game surface. There is no ticker, no input and no
 * simulation, so the same floor can be re-rendered and screenshotted hundreds
 * of times while an art language is being tuned. `?lab` selects it.
 *
 *   ?lab&view=model|plan|split   which drawing language
 *   ?lab&zoom=fit|play|close     camera
 *   ?lab&focus=racks|dock|shop|office
 *   ?lab&floor=GROUND|B1
 *   ?lab&actors=0                hide bots and Dots
 */

const BUILDING_ID = "lot6";

type LabParams = {
  view: "model" | "plan" | "split" | "city" | "cityPlan" | "geometry" | "quay";
  zoom: "fit" | "play" | "close";
  focus: string;
  floorLabel: string;
  actors: boolean;
};

function readParams(search: string): LabParams {
  const p = new URLSearchParams(search);
  const view = p.get("view");
  const zoom = p.get("zoom");
  return {
    view: view === "plan" || view === "split" || view === "city" || view === "cityPlan" || view === "geometry" || view === "quay" ? view : "model",
    zoom: zoom === "play" || zoom === "close" ? zoom : "fit",
    focus: p.get("focus") ?? "racks",
    floorLabel: (p.get("floor") ?? "GROUND").toUpperCase(),
    actors: p.get("actors") !== "0",
  };
}

// ---------------------------------------------------------------------------
// Gameplay colour: the entire chromatic budget, spent where it earns attention
// ---------------------------------------------------------------------------

const SQUAD = 0x22b8cf;
const RIVAL = 0xe03131;
const AMBIENT = 0x868e96;
const DOT_POWERUP = 0xe8590c;
const DOT_RARE = 0xf2b400;
const HULL = 0x14171a;

function powerupColor(spawn: DotSpawn): number {
  if (spawn.item.kind !== "powerup") return 0x1971c2;
  return spawn.item.type === "incognito" ? DOT_RARE : DOT_POWERUP;
}

type LabBot = {
  at: Vec2;
  facing: number;
  color: number;
  shields: number[];
  radius: number;
};

/** The shipped plate language, drawn with the production grounding primitives. */
function drawLabBot(g: Graphics, bot: LabBot): void {
  const { at, radius } = bot;
  drawGroundShadow(g, at, radius);

  const max = bot.shields.length;
  const span = shieldArcSpan(max);
  const step = (Math.PI * 2) / max;
  const shieldRadius = radius * 0.78;

  g.circle(at.x, at.y, radius - 0.5).stroke({ color: HULL, width: 1, alpha: 0.22 });

  for (let i = 0; i < max; i += 1) {
    const state = bot.shields[i];
    const start = bot.facing + i * step - span / 2;
    if (state >= 1) {
      arc(g, at, shieldRadius, start, start + span, bot.color, 5, 1);
    } else if (state > 0) {
      arc(g, at, shieldRadius, start, start + span * 0.42, bot.color, 3, 0.9);
      arc(g, at, shieldRadius, start + span * 0.58, start + span, bot.color, 3, 0.9);
    } else {
      arc(g, at, shieldRadius, start, start + span, bot.color, 2, 0.3);
    }
  }

  g.circle(at.x, at.y, radius * 0.4).fill({ color: HULL, alpha: 0.95 });
  g.circle(at.x, at.y, radius * 0.4).stroke({ color: HULL, width: 2 });
  drawCatchLight(g, at, radius * 0.4);
}

function arc(g: Graphics, at: Vec2, r: number, from: number, to: number, color: number, width: number, alpha: number): void {
  g.moveTo(at.x + Math.cos(from) * r, at.y + Math.sin(from) * r);
  g.arc(at.x, at.y, r, from, to).stroke({ color, width, alpha });
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

const FOCUS: Record<string, Rect> = {
  // Pick aisles and the racking runs: the hero of a depot floor.
  racks: { x: 330, y: 1120, w: 380, h: 300 },
  // Dock strip, roll-up doors and staged freight.
  dock: { x: 170, y: 1005, w: 480, h: 220 },
  // Workshop bench, tool chest and locker bank.
  shop: { x: 165, y: 1175, w: 260, h: 270 },
  // Dispatch office.
  office: { x: 690, y: 1290, w: 175, h: 170 },
  // Main St crossing Third Ave: kerbs, crossings, parked cars, street trees.
  street: { x: 900, y: 560, w: 700, h: 440 },
};

/**
 * `?focus=x,y,w,h` frames an arbitrary rectangle of the sheet.
 *
 * The named regions above are all interiors, which is no use during a pass over
 * the exterior: judging a frontage or a yard means looking at one, and the
 * whole-sheet fit is too small to see paving joints or how a tree meets a kerb.
 */
function focusRect(focus: string): Rect | null {
  const parts = focus.split(",").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [x, y, w, h] = parts;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function cameraFor(params: LabParams, fp: Rect, viewport: { w: number; h: number }): { scale: number; center: Vec2 } {
  const explicit = focusRect(params.focus);
  if (explicit) {
    const margin = 16;
    return {
      scale: Math.min((viewport.w - margin * 2) / explicit.w, (viewport.h - margin * 2) / explicit.h),
      center: { x: explicit.x + explicit.w / 2, y: explicit.y + explicit.h / 2 },
    };
  }

  if (params.view === "quay") {
    const margin = 22;
    const sheet = { x: 0, y: 0, w: quaysideMap.width, h: quaysideMap.height };
    return {
      scale: Math.min((viewport.w - margin * 2) / sheet.w, (viewport.h - margin * 2) / sheet.h),
      center: { x: sheet.w / 2, y: sheet.h / 2 },
    };
  }
  if (params.view === "geometry") {
    const margin = 24;
    return {
      scale: Math.min((viewport.w - margin * 2) / fp.w, (viewport.h - margin * 2) / fp.h),
      center: { x: fp.x + fp.w / 2, y: fp.y + fp.h / 2 },
    };
  }
  const city = params.view === "city" || params.view === "cityPlan";
  if (city && params.zoom === "fit") {
    const sheet = { x: 0, y: 0, w: downtownMap.width, h: downtownMap.height };
    const margin = 20;
    return {
      scale: Math.min((viewport.w - margin * 2) / sheet.w, (viewport.h - margin * 2) / sheet.h),
      center: { x: sheet.w / 2, y: sheet.h / 2 },
    };
  }
  if (params.zoom === "fit") {
    const margin = 34;
    const scale = Math.min((viewport.w - margin * 2) / fp.w, (viewport.h - margin * 2) / fp.h);
    return { scale, center: { x: fp.x + fp.w / 2, y: fp.y + fp.h / 2 } };
  }
  const region = FOCUS[params.focus] ?? FOCUS.racks;
  if (params.zoom === "close") {
    const scale = Math.min(viewport.w / region.w, viewport.h / region.h);
    return { scale, center: { x: region.x + region.w / 2, y: region.y + region.h / 2 } };
  }
  // Play zoom: roughly what a player sees on this device, independent of region
  // size, so legibility can be judged rather than composition.
  const visibleHeight = 660;
  const scale = viewport.h / visibleHeight;
  // Keep the frame inside the building where it fits, so a legibility test is
  // not half filled with the void outside the footprint.
  const halfW = viewport.w / 2 / scale;
  const halfH = viewport.h / 2 / scale;
  const clamp = (value: number, lo: number, hi: number): number =>
    (hi < lo ? (lo + hi) / 2 : Math.min(Math.max(value, lo), hi));
  return {
    scale,
    center: {
      x: clamp(region.x + region.w / 2, fp.x + halfW, fp.x + fp.w - halfW),
      y: clamp(region.y + region.h / 2, fp.y + halfH, fp.y + fp.h - halfH),
    },
  };
}

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

function findFloor(building: Building, label: string): FloorPlan {
  return building.floors.find((f) => f.label === label) ?? building.floors[0];
}

/** The new language. */
function modelWorld(building: Building, floor: FloorPlan, params: LabParams): Container {
  const world = new Container();
  const { view } = buildFloorModel(building, floor);
  world.addChild(view);

  if (!params.actors) return world;

  const actors = new Graphics();
  for (const spawn of floor.dotSpawns) {
    drawDotDisc(actors, spawn.position, spawn.radius ?? 11, powerupColor(spawn));
  }
  for (const bot of labBots(floor)) drawLabBot(actors, bot);
  world.addChild(actors);
  return world;
}

/**
 * The whole sheet as a player standing on the street sees it: interiors hidden,
 * each building showing either its authored ROOF plan or its generated roof.
 * `buildMapArt` builds every floor and leaves visibility to the caller, so a
 * city view that skips this stacks every interior on top of the roofs.
 */
function cityWorld(theme: "lit-model" | undefined): Container {
  const world = new Container();
  const art = buildMapArt(theme ? { ...downtownMap, visualTheme: theme } : downtownMap);
  for (const building of art.buildings) {
    const hasRoof = building.building.floors.some((floor) => floor.label === "ROOF");
    for (const floorArt of building.floors) {
      floorArt.view.visible = floorArt.floor.label === "ROOF";
      floorArt.foreground.visible = floorArt.view.visible;
    }
    building.roof.visible = !hasRoof;
  }
  world.addChild(art.root);
  return world;
}

/** The shipped pen-plotter language, for honest comparison. */
function planWorld(building: Building, floor: FloorPlan, params: LabParams): Container {
  const world = new Container();
  const art = buildMapArt(downtownMap);

  // Isolate the one building and the one floor.
  art.ground.visible = false;
  art.outdoorDetail.visible = false;
  art.outdoorObjects.visible = false;
  art.labels.visible = false;
  for (const b of art.buildings) {
    const mine = b.building.id === building.id;
    b.roof.visible = false;
    b.entranceMarks.visible = false;
    b.label.visible = false;
    for (const f of b.floors) {
      f.view.visible = mine && f.floor.id === floor.id;
      f.view.alpha = 1;
    }
  }
  world.addChild(art.root);

  if (!params.actors) return world;
  const actors = new Graphics();
  for (const spawn of floor.dotSpawns) {
    actors.circle(spawn.position.x, spawn.position.y, spawn.radius ?? 11).fill({ color: powerupColor(spawn) });
    actors.circle(spawn.position.x, spawn.position.y, spawn.radius ?? 11).stroke({ color: HULL, width: 2 });
  }
  for (const bot of labBots(floor)) drawLabBot(actors, bot);
  world.addChild(actors);
  return world;
}

/**
 * Three bots placed to test the thing that matters: can you find your own bot,
 * spot a rival and read a Dot in one glance, in a room this dense?
 */
function labBots(floor: FloorPlan): LabBot[] {
  if (floor.label !== "GROUND") {
    return [{ at: { x: 470, y: 1200 }, facing: -Math.PI / 2, color: SQUAD, shields: [1, 1, 1], radius: 24 }];
  }
  return [
    { at: { x: 453, y: 1330 }, facing: -Math.PI / 2, color: SQUAD, shields: [1, 0.5, 1], radius: 24 },
    { at: { x: 573, y: 1215 }, facing: Math.PI / 2, color: RIVAL, shields: [1, 1, 0], radius: 24 },
    { at: { x: 700, y: 1075 }, facing: Math.PI, color: AMBIENT, shields: [1, 1, 1], radius: 24 },
  ];
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function caption(text: string): Text {
  return new Text({
    text,
    style: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11,
      letterSpacing: 1.4,
      fill: 0x6b7178,
      fontWeight: "600",
    },
  });
}

/** One frame the lab knows how to draw. */
type Shot = LabParams & { name: string; w: number; h: number };

/**
 * The deliverable set. Exported at a fixed size so the frames are comparable to
 * each other and independent of whatever window the lab happens to open in.
 */
const SHOT_SET: Shot[] = [
  { name: "31-quayside-source", view: "quay", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: false, w: 1400, h: 1440 },
  { name: "30-geometry-kernel", view: "geometry", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: false, w: 1900, h: 800 },
  { name: "20-city-model", view: "city", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: false, w: 1800, h: 1200 },
  { name: "21-street-close", view: "city", zoom: "close", focus: "street", floorLabel: "GROUND", actors: false, w: 1600, h: 1000 },
  { name: "22-city-plan", view: "cityPlan", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: false, w: 1800, h: 1200 },
  { name: "01-floor-model", view: "model", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: true, w: 1500, h: 1000 },
  { name: "02-floor-plan", view: "plan", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: true, w: 1500, h: 1000 },
  { name: "03-compare-racks", view: "split", zoom: "close", focus: "racks", floorLabel: "GROUND", actors: true, w: 1700, h: 780 },
  { name: "04-compare-shop", view: "split", zoom: "close", focus: "shop", floorLabel: "GROUND", actors: true, w: 1700, h: 780 },
  { name: "05-racks-close", view: "model", zoom: "close", focus: "racks", floorLabel: "GROUND", actors: true, w: 1500, h: 1100 },
  { name: "06-dock-close", view: "model", zoom: "close", focus: "dock", floorLabel: "GROUND", actors: true, w: 1600, h: 760 },
  { name: "07-shop-close", view: "model", zoom: "close", focus: "shop", floorLabel: "GROUND", actors: true, w: 1100, h: 1150 },
  { name: "08-office-close", view: "model", zoom: "close", focus: "office", floorLabel: "GROUND", actors: true, w: 1100, h: 1000 },
  { name: "09-basement-model", view: "model", zoom: "fit", focus: "racks", floorLabel: "B1", actors: true, w: 1500, h: 1000 },
  { name: "10-play-zoom", view: "model", zoom: "play", focus: "racks", floorLabel: "GROUND", actors: true, w: 900, h: 560 },
  { name: "11-play-zoom-phone", view: "model", zoom: "play", focus: "racks", floorLabel: "GROUND", actors: true, w: 390, h: 720 },
];

export function StyleLab() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let app: Application | null = null;
    let disposed = false;

    const params = readParams(window.location.search);
    const shotMode = new URLSearchParams(window.location.search).has("shots");
    const building = downtownMap.buildings.find((b) => b.id === BUILDING_ID)!;
    const fp = building.footprint;

    void (async () => {
      const created = new Application();
      await created.init({
        background: params.view === "plan" ? 0xffffff : V.void,
        width: host.clientWidth,
        height: host.clientHeight,
        antialias: true,
        autoStart: false,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        preference: "webgl",
        preserveDrawingBuffer: true,
      });
      if (disposed) {
        created.destroy(true);
        return;
      }
      app = created;
      // Pixi sizes the backing store; the element still needs a CSS box or it
      // lays out at its device-pixel width and the camera reads as 2x zoomed.
      created.canvas.style.width = "100%";
      created.canvas.style.height = "100%";
      created.canvas.style.display = "block";
      host.appendChild(created.canvas);

      /** Draw one spec into a viewport of the given size. */
      const compose = (spec: LabParams, viewport: { w: number; h: number }): void => {
        created.stage.removeChildren();
        const floor = findFloor(building, spec.floorLabel);

        if (spec.view === "split") {
          // Split along the long axis, so each panel stays close to the
          // proportions of the region being compared.
          const sideBySide = viewport.w >= viewport.h;
          const panelSize = sideBySide
            ? { w: viewport.w / 2, h: viewport.h }
            : { w: viewport.w, h: viewport.h / 2 };
          const camera = cameraFor(spec, fp, panelSize);
          const panels = [
            { world: planWorld(building, floor, spec), label: "SHIPPED — LINE PLAN", bg: 0xffffff },
            { world: modelWorld(building, floor, spec), label: "PROPOSED — LIT MODEL", bg: V.void },
          ];
          panels.forEach((panel, index) => {
            const ox = sideBySide ? panelSize.w * index : 0;
            const oy = sideBySide ? 0 : panelSize.h * index;
            const holder = new Container();
            const bg = new Graphics();
            bg.rect(ox, oy, panelSize.w, panelSize.h).fill({ color: panel.bg });
            const mask = new Graphics();
            mask.rect(ox, oy, panelSize.w, panelSize.h).fill({ color: 0xffffff });
            panel.world.scale.set(camera.scale);
            panel.world.position.set(
              ox + panelSize.w / 2 - camera.center.x * camera.scale,
              oy + panelSize.h / 2 - camera.center.y * camera.scale,
            );
            holder.addChild(bg, panel.world);
            holder.mask = mask;
            const tag = caption(panel.label);
            tag.position.set(ox + 16, oy + 14);
            created.stage.addChild(mask, holder, tag);
          });
          const divider = new Graphics();
          if (sideBySide) divider.rect(viewport.w / 2 - 1, 0, 2, viewport.h).fill({ color: 0x8b9197 });
          else divider.rect(0, viewport.h / 2 - 1, viewport.w, 2).fill({ color: 0x8b9197 });
          created.stage.addChild(divider);
          return;
        }

        const bg = new Graphics();
        bg.rect(0, 0, viewport.w, viewport.h).fill({ color: spec.view === "plan" || spec.view === "cityPlan" ? 0xffffff : V.void });
        created.stage.addChild(bg);

        if (spec.view === "quay") {
          const camera = cameraFor(spec, fp, viewport);
          const bg = new Graphics();
          bg.rect(0, 0, viewport.w, viewport.h).fill({ color: V.void });
          const art = buildMapArt(quaysideMap);
          // Ground floor visible: this is a walk-in view, not a street view.
          for (const building of art.buildings) {
            for (const floorArt of building.floors) {
              floorArt.view.visible = floorArt.floor.label === "GROUND";
              floorArt.foreground.visible = floorArt.view.visible;
            }
            building.roof.visible = false;
            building.entranceMarks.visible = false;
          }
          const world = new Container();
          world.addChild(art.root);
          world.scale.set(camera.scale);
          world.position.set(
            viewport.w / 2 - camera.center.x * camera.scale,
            viewport.h / 2 - camera.center.y * camera.scale,
          );
          created.stage.addChild(bg, world);
          created.stage.addChild(Object.assign(
            caption("QUAYSIDE DEPOT  ·  authored in map source  ·  L-plan shell, chamfer, diagonal + curved partitions, curved quay wall"),
            { x: 16, y: 14 },
          ));
          return;
        }
        if (spec.view === "geometry") {
          const proof = buildGeometryProof();
          const camera = cameraFor(spec, proof.bounds, viewport);
          proof.view.scale.set(camera.scale);
          proof.view.position.set(
            viewport.w / 2 - camera.center.x * camera.scale,
            viewport.h / 2 - camera.center.y * camera.scale,
          );
          created.stage.addChild(proof.view);
          created.stage.addChild(Object.assign(
            caption("GEOMETRY KERNEL  ·  polygons, thick paths, fillets  ·  cyan track = where a 24-unit bot is actually stopped"),
            { x: 16, y: 14 },
          ));
          return;
        }

        const camera = cameraFor(spec, fp, viewport);
        const world = spec.view === "city"
          ? cityWorld("lit-model")
          : spec.view === "cityPlan"
            ? cityWorld(undefined)
            : spec.view === "plan"
              ? planWorld(building, floor, spec)
              : modelWorld(building, floor, spec);
        world.scale.set(camera.scale);
        world.position.set(
          viewport.w / 2 - camera.center.x * camera.scale,
          viewport.h / 2 - camera.center.y * camera.scale,
        );
        created.stage.addChild(world);
        created.stage.addChild(
          Object.assign(
            caption(
              `${building.name} / ${floor.label}  ·  ${spec.view.toUpperCase()}  ·  ${spec.zoom}${
                spec.zoom === "fit" ? "" : ` @ ${spec.focus}`
              }`,
            ),
            { x: 16, y: 14 },
          ),
        );
      };

      const draw = (): void => {
        // Pixi's own `resizeTo` defers the resize to the next ticker frame, and
        // this surface deliberately has no ticker, so resize explicitly.
        created.renderer.resize(host.clientWidth, host.clientHeight);
        compose(params, { w: created.screen.width, h: created.screen.height });
        created.render();
      };

      /**
       * Cost of the language, measured rather than asserted. Reported as the
       * median of repeated passes: build is the once-per-floor geometry cost,
       * render is what a frame actually pays.
       */
      const measure = (): Record<string, unknown> => {
        const floor = findFloor(building, "GROUND");
        const median = (runs: number, fn: () => void): number => {
          const times: number[] = [];
          for (let i = 0; i < runs; i += 1) {
            const t0 = performance.now();
            fn();
            times.push(performance.now() - t0);
          }
          return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
        };

        let built: Container | null = null;
        const buildMs = median(9, () => {
          built = buildFloorModel(building, floor).view;
        });

        created.renderer.resize(1280, 720);
        created.stage.removeChildren();
        const world = built!;
        world.scale.set(1.6);
        world.position.set(640 - 510 * 1.6, 360 - 1230 * 1.6);
        created.stage.addChild(world);
        const renderMs = median(30, () => created.render());

        let nodes = 0;
        const walk = (node: Container): void => {
          nodes += 1;
          for (const child of node.children) walk(child as Container);
        };
        walk(world);

        return {
          floorObjects: floor.objects.length,
          floorWalls: floor.walls.length,
          buildMs: Number(buildMs.toFixed(2)),
          renderMs: Number(renderMs.toFixed(3)),
          displayNodes: nodes,
        };
      };

      if (shotMode) {
        const results: string[] = [];
        for (const shot of SHOT_SET) {
          created.renderer.resize(shot.w, shot.h);
          compose(shot, { w: shot.w, h: shot.h });
          created.render();
          const png = created.canvas.toDataURL("image/png");
          const response = await fetch("/__lab/shot", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: shot.name, png }),
          });
          const body = await response.json() as { ok?: boolean; error?: string };
          results.push(`${shot.name}: ${body.ok ? "ok" : `FAILED ${body.error ?? ""}`}`);
        }
        (window as unknown as { labShots?: string[] }).labShots = results;
        (window as unknown as { labPerf?: unknown }).labPerf = measure();
        draw();
        return;
      }

      draw();
      const observer = new ResizeObserver(() => draw());
      observer.observe(host);
      (created as unknown as { __labObserver?: ResizeObserver }).__labObserver = observer;
    })();

    return () => {
      disposed = true;
      const held = app as unknown as { __labObserver?: ResizeObserver } | null;
      held?.__labObserver?.disconnect();
      app?.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} style={{ position: "fixed", inset: 0, overflow: "hidden" }} />;
}
