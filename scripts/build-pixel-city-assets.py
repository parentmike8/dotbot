#!/usr/bin/env python3
"""Build the shippable pixel-city atlases from Mike's local licensed packs.

The purchased source folders are intentionally ignored. This script selects a
small production subset, packs it into one atlas, and also builds the first-
party DotBot directional/state atlas used by the renderer.
"""

from __future__ import annotations

import json
import math
import argparse
from itertools import product
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "apps/client/public/assets/pixel-city"
EXTERIOR = ROOT / "Game Assets/modernexteriors-win/Modern_Exteriors_48x48/Modern_Exteriors_Complete_Singles_48x48"
EXTERIOR_ANIMATED = ROOT / "Game Assets/modernexteriors-win/Modern_Exteriors_48x48/Animated_48x48/Animated_sheets_48x48"
GROCERY = ROOT / "Game Assets/moderninteriors-win/1_Interiors/48x48/Theme_Sorter_Black_Shadow_Singles_48x48/16_Grocery_Store_Black_Shadow_Singles_48x48"
CLOTHING = ROOT / "Game Assets/moderninteriors-win/1_Interiors/48x48/Theme_Sorter_Black_Shadow_Singles_48x48/21_Clothing_Store_Black_Shadow_Singles_48x48"
KITCHEN = ROOT / "Game Assets/moderninteriors-win/1_Interiors/48x48/Theme_Sorter_Black_Shadow_Singles_48x48/12_Kitchen_Black_Shadow_Singles_48x48"
BASEMENT = ROOT / "Game Assets/moderninteriors-win/1_Interiors/48x48/Theme_Sorter_Black_Shadow_Singles_48x48/14_Basement_Black_Shadow_Singles_48x48"
INTERIOR_FLOORS = ROOT / "Game Assets/moderninteriors-win/1_Interiors/48x48/Room_Builder_subfiles_48x48/Room_Builder_Floors_48x48.png"
OFFICE = ROOT / "Game Assets/Modern_Office_Revamped_v1.2/4_Modern_Office_singles/48x48"
OFFICE_ROOM_BUILDER = ROOT / "Game Assets/Modern_Office_Revamped_v1.2/1_Room_Builder_Office/Room_Builder_Office_48x48.png"
INTERIOR_UPSTAIRS = ROOT / "Game Assets/moderninteriors-win/1_Interiors/48x48/Theme_Sorter_Black_Shadow_48x48/17_Visibile_Upstairs_System_Black_Shadow_48x48.png"
DOT_ITEM_SOURCE = ROOT / "design-assets/pixel-city/dots/orbs-approved.png"


def exterior(name: str) -> Path:
    return EXTERIOR / name


def grocery(number: int) -> Path:
    return GROCERY / f"Grocery_Store_Black_Shadow_Singles_48x48_{number}.png"


def office(number: int) -> Path:
    return OFFICE / f"Modern_Office_Singles_48x48_{number}.png"


def clothing(number: int) -> Path:
    return CLOTHING / f"Clothing_Store_Black_Shadow_Singles_48x48_{number}.png"


def kitchen(number: int) -> Path:
    return KITCHEN / f"Kitchen_Shadow_Singles_48x48_{number}.png"


def basement(number: int) -> Path:
    return BASEMENT / f"Basement_Shadow_Singles_48x48_{number}.png"


ASSETS: dict[str, Path] = {
    "asphalt": exterior("ME_Singles_City_Terrains_48x48_Asphalt_1_Variation_20.png"),
    "sidewalk": exterior("ME_Singles_City_Terrains_48x48_Sidewalk_5_9.png"),
    "bench": exterior("ME_Singles_City_Props_48x48_Bench_1.png"),
    "hydrant": exterior("ME_Singles_City_Props_48x48_Hydrant_1.png"),
    "street-lamp": exterior("ME_Singles_City_Props_48x48_Street_Lamp_3.png"),
    "trash-bin": exterior("ME_Singles_City_Props_48x48_Trashbin_6.png"),
    "street-tree": exterior("ME_Singles_City_Props_48x48_Tree_1.png"),
    "planter-tree": exterior("ME_Singles_City_Props_48x48_Tree_7.png"),
    "car-right": exterior("ME_Singles_Vehicles_48x48_Car_Right_1.png"),
    "car-down": exterior("ME_Singles_Vehicles_48x48_Car_Down_1.png"),
    "shop-front-blue": exterior("ME_Singles_Floor_Modular_Building_48x48_Ground_Floor_Shop_1.png"),
    "shop-front-blue-doorless": exterior("ME_Singles_Floor_Modular_Building_48x48_Ground_Floor_Shop_1.png"),
    "shop-front-red": exterior("ME_Singles_Floor_Modular_Building_48x48_Ground_Floor_Shop_8.png"),
    "shop-middle": exterior("ME_Singles_Floor_Modular_Building_48x48_Middle_Floor_1.png"),
    "shop-roof": exterior("ME_Singles_Floor_Modular_Building_48x48_Roof_1.png"),
    "parts-wall-shelf": grocery(65),
    "parts-island-a": grocery(113),
    "parts-island-b": grocery(114),
    "rolling-rack-empty": grocery(249),
    "rolling-rack-parts": grocery(250),
    "service-counter": grocery(258),
    "work-bench": grocery(253),
    "parts-case": grocery(330),
    "storage-rack-a": grocery(351),
    "storage-rack-b": grocery(355),
    "plant": office(108),
    "office-chair": office(111),
    "monitor-desk": office(235),
    "repair-console": office(237),
    "printer": office(155),
    "server-rack": office(177),
    "vending": office(176),
    # Bakery (blue building) program
    "bakery-front-doorless": exterior("ME_Singles_Floor_Modular_Building_48x48_Ground_Floor_Bakery_9.png"),
    "deli-case": grocery(149),
    "deli-case-b": grocery(150),
    "bread-shelf": grocery(201),
    "bread-shelf-b": grocery(204),
    "bakery-rack": grocery(250),
    "oven": grocery(253),
    "bakery-counter": grocery(170),
    "open-sign": grocery(2),
    # Coolies clothing store (red building) program
    "coolies-front-doorless": exterior("ME_Singles_Floor_Modular_Building_48x48_Ground_Floor_Shop_7.png"),
    "mannequin-a": clothing(56),
    "mannequin-b": clothing(60),
    "mannequin-c": clothing(101),
    "folded-stack": clothing(157),
    "mirror-tall": clothing(161),
    "clothes-rail": clothing(168),
    "clothes-rack-a": clothing(170),
    "clothes-rack-b": clothing(171),
    "clothes-rack-c": clothing(172),
    "display-table-a": clothing(202),
    "display-table-b": clothing(204),
    "cubby-shelf": clothing(206),
    "fitting-curtain": clothing(223),
    "clothes-desk": clothing(260),
    # Storage / repair / break-room fixtures for upper Plume floors
    "crate-stack-a": basement(65),
    "crate-stack-b": basement(66),
    "pallet-shelf": basement(64),
    "kitchenette": kitchen(121),
    "fridge": kitchen(159),
    "break-table": kitchen(310),
    "coffee-maker": kitchen(186),
    # Alley and street service props
    "alley-container": exterior("ME_Singles_City_Props_48x48_Container_4.png"),
    "barrel-blue": exterior("ME_Singles_City_Props_48x48_Barrel_1.png"),
    "barrel-cluster": exterior("ME_Singles_City_Props_48x48_Barrel_4.png"),
    "cardboard-a": exterior("ME_Singles_City_Props_48x48_Cardboard_Trash_1.png"),
    "cardboard-b": exterior("ME_Singles_City_Props_48x48_Cardboard_Trash_2.png"),
    "traffic-cone": exterior("ME_Singles_City_Props_48x48_Cone_3.png"),
}


def load_static_asset(key: str, path: Path) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    if key == "shop-front-blue-doorless":
        # The licensed storefront single includes a closed 96x96 door. The
        # playable shop uses the pack's matching animation in that exact tile,
        # so retaining the baked door creates a doubled frame whenever an
        # animated pose contains transparency. Replace it with the dark room
        # opening; the runtime sprite is then the sole visible door.
        # The animated cell is authored 12px left of the baked door. Clear the
        # same shifted 96px footprint, then replace the old door's remaining
        # right edge with the adjacent brick-wall pixels. The animation frames
        # already contain the dark room opening, so the facade cutout itself
        # must be transparent rather than another black box.
        wall_patch = image.crop((204, 48, 216, 144))
        ImageDraw.Draw(image).rectangle((216, 48, 311, 143), fill=(0, 0, 0, 0))
        image.alpha_composite(wall_patch, (312, 48))
    if key in {"bakery-front-doorless", "coolies-front-doorless"}:
        # Same treatment as the Plume facade: the licensed single bakes a
        # closed door into the 96px cell at x216..311 of the storefront band.
        # The runtime animated door owns that cell, so the baked door becomes
        # a transparent opening; the animation frames carry the dark interior.
        door_top = image.height - 96
        ImageDraw.Draw(image).rectangle((216, door_top, 311, image.height - 1), fill=(0, 0, 0, 0))
    return image

CROPS: dict[str, tuple[Path, tuple[int, int, int, int]]] = {
    "interior-floor": (OFFICE_ROOM_BUILDER, (480, 336, 528, 384)),
    "interior-rug": (OFFICE_ROOM_BUILDER, (624, 528, 672, 576)),
    "park-paving": (OFFICE_ROOM_BUILDER, (624, 336, 672, 384)),
    # Permanent interior view of a street doorway. Exterior animation remains
    # on the facade, while this shallow sidewalk strip makes the inside view
    # read as an open, passable gap at every animation state.
    "door-threshold": (exterior("ME_Singles_City_Terrains_48x48_Sidewalk_5_9.png"), (0, 0, 48, 16)),
    # Distinct interior surfaces so each small building reads as its own
    # program: warm checker for the bakery, plank wood for the clothing store.
    "bakery-floor": (INTERIOR_FLOORS, (240, 960, 288, 1008)),
    "wood-floor": (INTERIOR_FLOORS, (48, 576, 96, 624)),
}


STAIR_ARROW_COLOR = (82, 58, 44, 180)


def draw_stair_arrow(image: Image.Image, direction: str) -> None:
    """Bake a pixel arrow into the active half of a stair flight."""
    shaft = [(48, 164), (48, 116)]
    left_head = [(36, 129), (48, 116)]
    right_head = [(48, 116), (60, 129)]
    if direction == "down":
        shaft = [(x, 191 - y) for x, y in shaft]
        left_head = [(x, 191 - y) for x, y in left_head]
        right_head = [(x, 191 - y) for x, y in right_head]

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.line(shaft, fill=STAIR_ARROW_COLOR, width=3)
    draw.line(left_head, fill=STAIR_ARROW_COLOR, width=3)
    draw.line(right_head, fill=STAIR_ARROW_COLOR, width=3)
    image.alpha_composite(overlay)


def stair_asset(direction: str) -> Image.Image:
    """Adapt the licensed 96x192 stair to the existing open-end contract.

    The purchased sprite has heavy rails on both sides of the whole flight.
    DotBot stairs deliberately keep the active half laterally passable, so the
    corresponding rail pixels are removed while the exit half and far cap stay
    visually solid. This keeps the angled art and collision language aligned.
    """
    image = Image.open(INTERIOR_UPSTAIRS).convert("RGBA").crop((24, 864, 120, 1056))
    draw = ImageDraw.Draw(image)
    entry_y = (96, 192) if direction == "up" else (0, 96)
    draw.rectangle((0, entry_y[0], 13, entry_y[1] - 1), fill=(0, 0, 0, 0))
    draw.rectangle((82, entry_y[0], 95, entry_y[1] - 1), fill=(0, 0, 0, 0))

    cap_y = 0 if direction == "up" else 184
    draw.rectangle((0, cap_y, 95, cap_y + 7), fill=(36, 32, 52, 255))
    highlight_y = cap_y + 6 if direction == "up" else cap_y + 1
    draw.rectangle((4, highlight_y, 91, highlight_y + 1), fill=(91, 83, 109, 255))
    draw_stair_arrow(image, direction)
    return image

# The source sheet contains the return/closing half too. Runtime state owns
# direction, so packing the seven distinct opening poses avoids shipping the
# mirrored duplicate and lets one `openness` value choose the exact frame.
ANIMATED_FRAMES: dict[str, tuple[Path, int, int, tuple[int, ...]]] = {
    "shop-door-blue": (
        # This is the matching animated replacement for
        # ME_Singles_Floor_Modular_Building_48x48_Ground_Floor_Shop_1.
        # Door_4 is a narrower dark door and visibly doubles the baked facade
        # door when it is overlaid here.
        EXTERIOR_ANIMATED / "Floor_Modular_Buildings_1_Door_1_48x48.png",
        96,
        96,
        (0, 1, 2, 3, 4, 5, 6),
    ),
    # These 21-frame sheets hold a longer closed→open→closing cycle. The
    # renderer maps openness onto exactly seven frames, so seven poses are
    # sampled from the opening run only (0=closed … last=fully open).
    "bakery-door": (
        EXTERIOR_ANIMATED / "Floor_Modular_Buildings_1_Door_Bakery_48x48.png",
        96,
        96,
        (0, 3, 4, 5, 6, 7, 9),
    ),
    "clothes-door": (
        EXTERIOR_ANIMATED / "Floor_Modular_Buildings_1_Door_Clothing_Stores_48x48.png",
        96,
        96,
        (0, 3, 4, 5, 6, 7, 9),
    ),
}


def ensure_sources(paths: Iterable[Path]) -> None:
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.exists()]
    if missing:
        raise SystemExit("Missing purchased source assets:\n" + "\n".join(missing))


def pack_atlas() -> None:
    ensure_sources([
        *ASSETS.values(),
        *(path for path, _ in CROPS.values()),
        *(path for path, _, _, _ in ANIMATED_FRAMES.values()),
        INTERIOR_FLOORS,
        INTERIOR_UPSTAIRS,
    ])
    padding = 4
    max_width = 2048
    entries: list[tuple[str, Image.Image]] = [
        (key, load_static_asset(key, path)) for key, path in ASSETS.items()
    ]
    entries.extend(
        (key, Image.open(path).convert("RGBA").crop(rect))
        for key, (path, rect) in CROPS.items()
    )
    entries.extend([
        ("interior-stair-up", stair_asset("up")),
        ("interior-stair-down", stair_asset("down")),
    ])
    for key, (path, frame_width, frame_height, source_indices) in ANIMATED_FRAMES.items():
        sheet = Image.open(path).convert("RGBA")
        entries.extend(
            (f"{key}-{index}", sheet.crop((source * frame_width, 0, (source + 1) * frame_width, frame_height)))
            for index, source in enumerate(source_indices)
        )
    frames: dict[str, dict[str, int]] = {}
    x = padding
    y = padding
    row_height = 0
    placements: list[tuple[str, Image.Image, int, int]] = []
    for key, image in entries:
        if x + image.width + padding > max_width:
            x = padding
            y += row_height + padding
            row_height = 0
        placements.append((key, image, x, y))
        frames[key] = {"x": x, "y": y, "w": image.width, "h": image.height}
        x += image.width + padding
        row_height = max(row_height, image.height)

    height = y + row_height + padding
    atlas = Image.new("RGBA", (max_width, height), (0, 0, 0, 0))
    for _, image, px, py in placements:
        atlas.alpha_composite(image, (px, py))

    OUT.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT / "pixel-city.png", optimize=True)
    (OUT / "pixel-city.json").write_text(json.dumps({"frames": frames}, indent=2) + "\n")


DIRECTIONS = [
    ("e", 1.0, 0.0),
    ("se", 0.7, 0.7),
    ("s", 0.0, 1.0),
    ("sw", -0.7, 0.7),
    ("w", -1.0, 0.0),
    ("nw", -0.7, -0.7),
    ("n", 0.0, -1.0),
    ("ne", 0.7, -0.7),
]
STATES = ["idle", "glide-a", "glide-b", "dash", "downed", "armour-light", "armour-heavy"]

DOT_ITEMS = [
    ("health", (80, 250, 315, 700)),
    ("radar", (300, 250, 520, 700)),
    ("dash-overcharge", (520, 250, 735, 700)),
    ("incognito", (735, 250, 970, 700)),
    ("blueprint", (970, 250, 1195, 700)),
    ("mine", (1195, 250, 1450, 700)),
]


def extract_dot_item_frame(source: Image.Image, crop_rect: tuple[int, int, int, int]) -> Image.Image:
    """Fit one approved transparent orb into a padded 64px atlas cell.

    Mike's source already separates the pearl and its soft contact shadow from
    the background. Only near-invisible alpha noise is removed; the embedded
    mark, surface lighting, and detached shadow stay together as one sprite.
    """

    crop = source.crop(crop_rect).convert("RGBA")
    alpha = crop.getchannel("A").point(lambda value: value if value >= 4 else 0)
    bounds = alpha.getbbox()
    if not bounds:
        raise SystemExit(f"No Dot artwork found in approved source crop {crop_rect}")
    crop.putalpha(alpha)
    crop = crop.crop(bounds)
    # Store the collectible at its actual 35-unit gameplay size. Packing a
    # 64px frame and then shrinking it to 35 in Pixi caused uneven nearest-
    # neighbour sampling that made the Hide orb's dark left rim look clipped.
    scale = min(33 / crop.width, 33 / crop.height)
    scaled_size = (round(crop.width * scale), round(crop.height * scale))
    crop = crop.resize(scaled_size, Image.Resampling.LANCZOS)

    frame = Image.new("RGBA", (35, 35), (0, 0, 0, 0))
    frame.alpha_composite(crop, ((35 - scaled_size[0]) // 2, 34 - scaled_size[1]))
    return frame


def build_dot_item_atlas() -> None:
    cell = 35
    ensure_sources([DOT_ITEM_SOURCE])
    source = Image.open(DOT_ITEM_SOURCE).convert("RGBA")
    atlas = Image.new("RGBA", (len(DOT_ITEMS) * cell, cell), (0, 0, 0, 0))
    frames: dict[str, dict[str, int]] = {}
    for column, (item, crop_rect) in enumerate(DOT_ITEMS):
        frame = extract_dot_item_frame(source, crop_rect)
        x = column * cell
        atlas.alpha_composite(frame, (x, 0))
        frames[f"dot-{item}"] = {"x": x, "y": 0, "w": cell, "h": cell}
    OUT.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT / "dot-items.png", optimize=True)
    (OUT / "dot-items.json").write_text(json.dumps({"frames": frames}, indent=2) + "\n")


def draw_dotbot_frame(direction: tuple[str, float, float], state: str) -> Image.Image:
    name, dx, dy = direction
    low = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(low)
    cx = 16
    # Keep the hull on one anchor in every movement frame. Shifting the entire
    # body by two rendered pixels made the moving sprite visibly vibrate.
    cy = 16

    if state == "dash":
        for index, alpha in enumerate((80, 48, 24), start=1):
            tx = int(cx - dx * (5 + index * 3))
            ty = int(cy - dy * (4 + index * 3))
            draw.ellipse((tx - 5, ty - 2, tx + 5, ty + 2), fill=(20, 207, 225, alpha))

    if state == "downed":
        draw.ellipse((7, 18, 25, 24), fill=(18, 21, 28, 155))
        draw.ellipse((8, 16, 24, 22), fill=(37, 42, 51, 255), outline=(9, 11, 15, 255), width=1)
        draw.line((12, 18, 20, 21), fill=(34, 210, 226, 255), width=2)
        draw.line((20, 18, 12, 21), fill=(34, 210, 226, 255), width=2)
        return low.resize((64, 64), Image.Resampling.NEAREST)

    draw.ellipse((7, cy + 6, 25, cy + 10), fill=(10, 13, 19, 65))
    draw.ellipse((7, cy - 2, 25, cy + 7), fill=(19, 23, 31, 255), outline=(7, 9, 13, 255), width=1)
    draw.rectangle((8, cy + 2, 24, cy + 5), fill=(25, 29, 38, 255))
    draw.ellipse((8, cy - 5, 24, cy + 3), fill=(31, 36, 45, 255), outline=(7, 9, 13, 255), width=1)
    draw.ellipse((10, cy - 3, 22, cy + 1), fill=(10, 13, 18, 255))
    draw.arc((9, cy - 4, 23, cy + 2), 195, 345, fill=(74, 83, 98, 255), width=1)
    draw.ellipse((13, cy - 3, 19, cy), outline=(31, 218, 231, 255), width=1)

    sensor_x = int(cx + dx * 6)
    sensor_y = int(cy - 1 + dy * 3)
    draw.ellipse((sensor_x - 2, sensor_y - 1, sensor_x + 2, sensor_y + 1), fill=(31, 218, 231, 255))
    draw.point((sensor_x, sensor_y - 1), fill=(205, 252, 255, 255))

    if state in {"glide-a", "glide-b"}:
        trail = 1 if state == "glide-a" else 2
        trail_x = int(cx - dx * (9 + trail))
        trail_y = int(cy - dy * (6 + trail))
        draw.rectangle((trail_x - 1, trail_y - 1, trail_x + trail, trail_y), fill=(31, 218, 231, 185))

    if state in {"armour-light", "armour-heavy"}:
        plates = 3 if state == "armour-light" else 5
        color = (110, 126, 145, 255) if state == "armour-light" else (76, 87, 104, 255)
        for index in range(plates):
            px = 9 + index * (14 // max(plates - 1, 1))
            draw.rectangle((px - 2, cy - 4, px + 2, cy - 2), fill=color, outline=(12, 15, 21, 255))

    return low.resize((64, 64), Image.Resampling.NEAREST)


def build_dotbot_atlas() -> None:
    cell = 64
    atlas = Image.new("RGBA", (len(DIRECTIONS) * cell, len(STATES) * cell), (0, 0, 0, 0))
    frames: dict[str, dict[str, int]] = {}
    for row, state in enumerate(STATES):
        for column, direction in enumerate(DIRECTIONS):
            frame = draw_dotbot_frame(direction, state)
            x = column * cell
            y = row * cell
            atlas.alpha_composite(frame, (x, y))
            frames[f"{state}-{direction[0]}"] = {"x": x, "y": y, "w": cell, "h": cell}
    atlas.save(OUT / "dotbot.png", optimize=True)
    (OUT / "dotbot.json").write_text(json.dumps({"frames": frames}, indent=2) + "\n")


def draw_shield_frame(
    direction: tuple[str, float, float],
    signature: tuple[int, int, int],
) -> Image.Image:
    """Draw the three directional shield plates as pixel art.

    The result is a sprite overlay, not runtime vector geometry. White pixels
    are tinted by relationship in Pixi; the darker edge and cut marks survive
    that tint so intact, damaged, and broken plates remain readable.
    """

    _, dx, dy = direction
    low = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    draw = ImageDraw.Draw(low)
    facing = math.atan2(dy, dx)

    for index, condition in enumerate(signature):
        angle = facing + index * math.tau / 3
        centre_degrees = math.degrees(angle)
        start = centre_degrees - 34
        end = centre_degrees + 34
        outer_box = (2, 2, 30, 30)

        if condition == 2:
            # Broad curved energy plate with a dark pixel edge and bright core.
            draw.arc(outer_box, start, end, fill=(61, 71, 82, 255), width=6)
            draw.arc(outer_box, start + 2, end - 2, fill=(245, 252, 255, 255), width=4)
            draw.arc((3, 3, 29, 29), start + 4, end - 4, fill=(255, 255, 255, 255), width=1)
        elif condition == 1:
            # Damaged plates retain their full protective silhouette but split
            # around an unmistakable central fracture.
            for damaged_start, damaged_end in ((start, centre_degrees - 5), (centre_degrees + 5, end)):
                draw.arc(outer_box, damaged_start, damaged_end, fill=(61, 71, 82, 255), width=5)
                draw.arc(outer_box, damaged_start + 2, damaged_end - 1, fill=(226, 237, 242, 235), width=3)
        else:
            # Broken plates leave a short ghost at each mount, never a full
            # circular outline that could be mistaken for remaining power.
            draw.arc(outer_box, start, start + 8, fill=(150, 161, 171, 105), width=3)
            draw.arc(outer_box, end - 8, end, fill=(150, 161, 171, 105), width=3)

    return low.resize((64, 64), Image.Resampling.NEAREST)


def build_dotbot_shield_atlas() -> None:
    cell = 64
    signatures = list(product(range(3), repeat=3))
    atlas = Image.new("RGBA", (len(DIRECTIONS) * cell, len(signatures) * cell), (0, 0, 0, 0))
    frames: dict[str, dict[str, int]] = {}
    for row, signature in enumerate(signatures):
        signature_key = "".join(str(value) for value in signature)
        for column, direction in enumerate(DIRECTIONS):
            frame = draw_shield_frame(direction, signature)
            x = column * cell
            y = row * cell
            atlas.alpha_composite(frame, (x, y))
            frames[f"shield-{signature_key}-{direction[0]}"] = {
                "x": x,
                "y": y,
                "w": cell,
                "h": cell,
            }
    atlas.save(OUT / "dotbot-shields.png", optimize=True)
    (OUT / "dotbot-shields.json").write_text(json.dumps({"frames": frames}, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dots-only", action="store_true", help="Rebuild only the first-party collectible Dot atlas")
    args = parser.parse_args()
    if args.dots_only:
        build_dot_item_atlas()
        print(f"Built Dot item sprites in {OUT.relative_to(ROOT)}")
        return

    pack_atlas()
    build_dotbot_atlas()
    build_dotbot_shield_atlas()
    build_dot_item_atlas()
    (OUT / "ATTRIBUTION.txt").write_text(
        "LimeZu Modern asset packs — https://limezu.itch.io/\n"
        "Used under the commercial-use licenses included with the purchased packs.\n"
        "DotBot character sprite: original project artwork.\n"
        "Dot item sprites: original project artwork.\n"
    )
    print(f"Built pixel-city assets in {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
