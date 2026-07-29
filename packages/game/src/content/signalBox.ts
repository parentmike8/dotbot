import { compileBuilding, type SourceBuilding } from "../mapSource";

/**
 * Fenchurch Box — the small enterable building at the yard throat.
 *
 * It is here because a signal box stands where the points are, and the points are where
 * the main line splits off into the yard. That is the whole justification: put it
 * anywhere else on the sheet and it becomes a shed with a name. It also gives the works
 * road something built along it, which the city audit demands of every road and is right
 * to — a road with nothing on it is a road to nowhere.
 *
 * Two floors, and they are genuinely different rooms rather than one plan twice. The
 * locking room below holds the mechanism; the operating floor above holds the lever
 * frame and the window a signaller watches the throat through. A player who climbs it
 * gains the one commanding view over the yard.
 *
 * It started at 220 x 260 and could not hold what it needed to: a 160-unit stair in a
 * 196-unit room leaves no floor, and the blueprint placer — which needs 64 units between
 * any two Dots — could not find anywhere to put the lever frame's blueprint at all. The
 * failure was useful, because a building too small to furnish is too small to fight in.
 */

const X = 3020;
const Y = 310;
const W = 300;
const H = 300;

export const SIGNAL_BOX_SOURCE: SourceBuilding = {
  id: "box",
  kind: "office",
  name: "FENCHURCH BOX",
  shellThickness: 12,
  outline: { shape: "rect", x: X, y: Y, w: W, h: H },
  stairs: [{
    /**
     * Against the east wall, so the floor's whole west half stays one room.
     *
     * `openEnd`: the flight is freestanding inside the box, so the dashed half gets side
     * rails and a far-end cap while the entry half stays open at its foot and along its
     * west flank — which is the side with 158 units of clear floor beside it, so a bot
     * leaving the flight after a floor change has somewhere to go.
     */
    id: "box-stair",
    rect: { x: 3190, y: 400, w: 88, h: 160 },
    from: "GROUND",
    to: "F1",
    bottom: "S",
    access: "openEnd",
  }],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "House the locking mechanism the levers above are interlocked through.",
        zones: ["the locking frame down the west wall", "the cable run", "the stair well east"],
        sequence: "In off the yard on the south, up the west side past the locking frame, up the stair.",
        adjacency: "Frame and cable run are one bank against the west wall, because they are one machine; the cables leave north toward the points they work.",
        negativeSpace: "The middle of the floor and the stair's run-up. It is a one-room building and that room is the route.",
      },
      shellOpenings: [
        { kind: "door", width: 64, near: { x: 3140, y: Y + H } },
        { kind: "window", width: 70, near: { x: X, y: 420 } },
      ],
      objects: [
        // One bank against the west wall: the locking frame, its cable run, and the
        // spare-parts cupboard under them. Attached seams, because it is one machine.
        { id: "box-locking", kind: "utilityBox", x: 3044, y: 350, w: 34, h: 120, facing: "E" },
        { id: "box-cable", kind: "serverRack", x: 3044, y: 486, w: 34, h: 56, facing: "E" },
        { id: "box-cupboard", kind: "cabinet", x: 3040, y: 558, w: 34, h: 30, facing: "E" },
      ],
      dots: [{ id: "box-dot-a", item: { kind: "powerup", type: "incognito" }, x: 3150, y: 350 }],
    },
    {
      label: "F1",
      brief: {
        purpose: "Work the throat: set the road into the yard, hold the main line clear.",
        zones: ["the lever frame along the north window", "the desk and train register", "the stove corner", "the stair head"],
        sequence: "Off the stair to the frame, pull the road, register it at the desk.",
        adjacency: "The frame faces the window so a signaller watches the points actually being worked; the stove is in the far corner, away from the glass.",
        negativeSpace: "The length of floor behind the frame. It is the walk a signaller does all shift, and here it is the only cover from a window wall.",
      },
      shellOpenings: [
        // A signal box is mostly glass on the side it watches, and it watches the throat.
        { kind: "window", width: 84, near: { x: 3080, y: Y } },
        { kind: "window", width: 84, near: { x: 3190, y: Y } },
        { kind: "window", width: 70, near: { x: X + W, y: 360 } },
      ],
      objects: [
        { id: "box-frame", kind: "planningTable", x: 3050, y: 336, w: 120, h: 40, facing: "N", scannable: true },
        { id: "box-diagram", kind: "shelf", x: 3040, y: 392, w: 26, h: 60 },
        /**
         * The register desk, and the chair on the SOUTH side of it.
         *
         * The chair used to sit north of the desk, which put the signaller between the desk
         * and the window with their back to the lever frame, the glass, and the throat — the
         * entire reason the room exists. The desk already declared `facing: "N"`, so the
         * furniture and the person disagreed about which way the room faced. Nothing measures
         * that: both objects cleared every solid, both were reachable, and the floor passed
         * every audit. It is only visible in the image.
         *
         * Moved north to 470 so the chair has somewhere to go, and the chair is FLUSH against
         * the desk rather than parked 8 units off it. The first attempt left that 8-unit gap
         * and `wedged-fixture` rejected it: the contract allows an attached seam of 16 or an
         * aisle of 64, and 8 units face-to-face is neither. It is also just wrong about the
         * furniture — a chair at a desk is tucked under it, and a chair floating a third of a
         * bot-width off its own desk is the same "placed by arithmetic" tell as the rest.
         *
         * Desk 470..514, chair 514..542, and 56 units left to the south wall so a bot can
         * still walk behind the person sitting there.
         */
        { id: "box-desk", kind: "desk", x: 3090, y: 470, w: 80, h: 44, facing: "N" },
        { id: "box-chair", kind: "chair", x: 3106, y: 514, w: 30, h: 28, facing: "N" },
        { id: "box-stove", kind: "stove", x: 3040, y: 558, w: 40, h: 40, facing: "E" },
      ],
      dots: [{ id: "box-dot-b", item: { kind: "powerup", type: "radar" }, x: 3140, y: 440 }],
    },
  ],
};

export const signalBox = compileBuilding(SIGNAL_BOX_SOURCE);
