import { physicsFloorId } from "@dotbot/game/mapModel";
import {
  OUTDOOR_FLOOR_ID,
  type GameSnapshot,
  type MapDocument,
  type Rect,
  type Vec2,
} from "@dotbot/game/types";
import type { LiveMark } from "../pings";

export const WORLD_MAP_PING_FLOOR = OUTDOOR_FLOOR_ID;

export type ExteriorBuildingPresentation = {
  buildingId: string;
  generatedRoofVisible: boolean;
  /** An authored ROOF is exterior art; every other floor is forbidden here. */
  visibleFloorIds: string[];
};

export type ExteriorMapPresentation = {
  bounds: Rect;
  buildings: ExteriorBuildingPresentation[];
};

/**
 * The complete and only static knowledge shown by the world map.
 *
 * Kept pure because the security property is which containers the Pixi canvas is
 * allowed to enable. The canvas applies this answer to `buildMapArt`; it never
 * receives a current floor and therefore cannot accidentally follow one.
 */
export function exteriorMapPresentation(map: MapDocument): ExteriorMapPresentation {
  return {
    bounds: worldMapBounds(map),
    buildings: map.buildings.map((building) => {
      const roof = building.floors.find((floor) => floor.label === "ROOF");
      return {
        buildingId: building.id,
        generatedRoofVisible: roof === undefined,
        visibleFloorIds: roof ? [roof.id] : [],
      };
    }),
  };
}

export type SquadMapMarker = {
  id: string;
  name: string;
  position: Vec2;
  state: "alive" | "downed";
  isViewer: boolean;
};

export type PingMapMarker = LiveMark;

/**
 * Dynamic map state is an allow-list, never "the snapshot minus a few things".
 *
 * A subtraction list eventually forgets a new entity collection. Building this
 * result from squad bodies and exterior squad marks makes enemies, Dots, mines,
 * doors, coverage, noises and private intel unrepresentable here.
 */
export function mapMarkers(
  map: MapDocument,
  snapshot: GameSnapshot,
  viewerId: string,
  marks: readonly LiveMark[],
): { squad: SquadMapMarker[]; pings: PingMapMarker[] } {
  const viewer = snapshot.bots.find((bot) => bot.id === viewerId);
  if (!viewer) return { squad: [], pings: [] };
  return {
    squad: snapshot.bots
      .filter((bot) => bot.squadId === viewer.squadId && !bot.isAmbient)
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        position: { ...bot.position },
        state: bot.state,
        isViewer: bot.id === viewerId,
      })),
    pings: marks
      .filter((mark) => {
        const owner = snapshot.bots.find((bot) => bot.id === mark.botId);
        return owner?.squadId === viewer.squadId
          && !owner.isAmbient
          && physicsFloorId(map, mark.floorId) === OUTDOOR_FLOOR_ID;
      })
      .map((mark) => ({ ...mark, position: { ...mark.position } })),
  };
}

export function worldMapBounds(map: Pick<MapDocument, "width" | "height">): Rect {
  return { x: 0, y: 0, w: map.width, h: map.height };
}

export function fitWorldMapScale(
  bounds: Rect,
  viewport: { width: number; height: number },
  margin: number,
): number {
  const availableWidth = Math.max(1, viewport.width - margin * 2);
  const availableHeight = Math.max(1, viewport.height - margin * 2);
  return Math.min(availableWidth / Math.max(1, bounds.w), availableHeight / Math.max(1, bounds.h));
}

/** Keep a little chart under the viewport at every zoom instead of panning into void. */
export function clampWorldMapCentre(
  centre: Vec2,
  bounds: Rect,
  viewport: { width: number; height: number },
  scale: number,
): Vec2 {
  const halfWidth = viewport.width / Math.max(scale, 0.0001) / 2;
  const halfHeight = viewport.height / Math.max(scale, 0.0001) / 2;
  const visibleX = Math.min(bounds.w / 2, halfWidth * 0.75);
  const visibleY = Math.min(bounds.h / 2, halfHeight * 0.75);
  return {
    x: Math.max(bounds.x + visibleX, Math.min(bounds.x + bounds.w - visibleX, centre.x)),
    y: Math.max(bounds.y + visibleY, Math.min(bounds.y + bounds.h - visibleY, centre.y)),
  };
}
