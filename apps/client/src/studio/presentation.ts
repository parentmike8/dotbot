import { Container, Graphics } from "pixi.js";
import { collectSolids } from "@dotbot/game/collision";
import type { MapDocument, Solid } from "@dotbot/game/types";
import type { MapArt } from "../game/renderer/mapArt";

export type StudioOverlayRequest = {
  map: MapDocument;
  building: string | null;
  floor: string | null;
  showCollision?: boolean;
  showClearance?: boolean;
};

/** Resolve Studio's authored floor label to the compiled physics-plane owner. */
export function studioFloorId(
  map: MapDocument,
  building: string | null,
  floor: string | null,
): string {
  if (building && floor) {
    const owner = map.buildings.find((candidate) => candidate.id === building);
    const compiled = owner?.floors.find((candidate) =>
      candidate.label === floor || candidate.id === floor);
    if (compiled) return compiled.id;
  }
  return floor ?? "outdoor";
}

export function studioOverlaySolids(
  request: StudioOverlayRequest,
): { collision: Solid[]; clearance: Solid[] } {
  const solids = collectSolids(
    request.map,
    studioFloorId(request.map, request.building, request.floor),
  );
  return {
    collision: request.showCollision ? solids : [],
    clearance: request.showClearance ? solids : [],
  };
}

/** Destroy every map-art root that lives outside the production root container. */
export function destroyStudioMapArt(
  world: Container,
  art: MapArt,
): void {
  if (art.root.parent === world) world.removeChild(art.root);
  if (art.overhead.parent === world) world.removeChild(art.overhead);
  art.root.destroy({ children: true });
  art.overhead.destroy({ children: true });
  // The live renderer consumes this as a fog mask. Studio has no fog pass, but
  // still owns the detached container returned by buildMapArt.
  art.foreground.destroy({ children: true });
}

/** Replace production map art while keeping editor ink above every visual layer. */
export function replaceStudioMapArt(
  world: Container,
  overlay: Graphics,
  current: MapArt | null,
  next: MapArt,
): MapArt {
  if (current) destroyStudioMapArt(world, current);
  if (overlay.parent !== world) world.addChild(overlay);
  world.addChildAt(next.root, 0);
  world.addChildAt(next.overhead, 1);
  return next;
}
