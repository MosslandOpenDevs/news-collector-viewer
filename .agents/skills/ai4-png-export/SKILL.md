---
name: ai4-png-export
description: "Generate ai4 blog images as 2 PNG files (hero thumbnail and Rank1-to-Curated body) with transparent inter-card gaps and stable crop rules"
---

# AI4 PNG Export

## When To Use

- Use this skill when the user asks to regenerate `ai4.html` images for blog upload
- Use this skill when HTML text/layout changed and both PNGs must be recreated
- Use this skill when card ordering/content is finalized and only image export is needed

## Output Contract

- Always generate exactly 2 files in `output/`
- File 1: `ai4-thumbnail.png`
- File 2: `ai4-rank1-curated.png`

## Export Rules

- Capture thumbnail from `.heroThumb` only
- Keep hero rounded shape as rendered element capture
- Capture body from first `.hotCard` top to `.pageFooter` bottom
- Keep Curated Sources area in original colors
- Make only inter-card gap areas fully transparent (alpha 0)
- Avoid extra blank space inside cards by using export-only CSS overrides

## How To Run

- Run:
```powershell
python .\.agents\skills\ai4-png-export\scripts\export_ai4_png.py
```
- Optional language override:
```powershell
python .\.agents\skills\ai4-png-export\scripts\export_ai4_png.py --lang ko
```
- Optional custom HTML path:
```powershell
python .\.agents\skills\ai4-png-export\scripts\export_ai4_png.py --html .\ai4.html
```

## Validation Checklist

- Verify `output/ai4-thumbnail.png` exists and shows only hero image block
- Verify `output/ai4-rank1-curated.png` includes Rank 1 through Curated Sources
- Verify no card content is missing and no large artificial blank area appears inside cards
- Verify inter-card spaces are transparent while footer colors remain intact
