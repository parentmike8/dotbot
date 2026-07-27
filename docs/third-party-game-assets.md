# Third-party game assets

## LimeZu modern packs

The local `Game Assets/` directory contains Mike's purchased source copies of Modern Exteriors, Modern Interiors, Modern Office Revamped, and Modern Farm. That directory is intentionally gitignored.

The licenses permit commercial game use and editing but do not permit resale or redistribution of the raw packs. The client therefore ships a single curated production atlas at `apps/client/public/assets/pixel-city/pixel-city.png`, not the source folders or individual source PNGs.

Required credit: [limezu.itch.io](https://limezu.itch.io/)

Regenerate the curated atlas locally with:

```bash
python3 scripts/build-pixel-city-assets.py
```

The script fails clearly when the purchased source packs are absent. Do not replace missing licensed art with generated approximations or commit the source packs.
