# Blastmates — brand guide

**Name**: always "Blastmates" — one word, capital B. Lowercase
`blastmates` only in code identifiers, slugs and URLs. Domain:
**blastmates.app**. Tagline: *"Blow up your buddies."*

## Palette

| Name   | Hex       | Role                                              |
| ------ | --------- | ------------------------------------------------- |
| Orange | `#FF6B2C` | Primary accent, bomb body on dark backgrounds     |
| Navy   | `#1B2440` | Brand background, bomb body on light backgrounds, text on light |
| Yellow | `#FFD23F` | Spark, highlights, taglines on navy               |
| Light  | `#F4F1EA` | Text on navy, light backgrounds, shine            |

### Contrast (WCAG AA)

- Light `#F4F1EA` on Navy `#1B2440`: 13.6:1 — use for body text on navy. ✓
- Yellow `#FFD23F` on Navy `#1B2440`: 10.6:1 — fine for any text on navy. ✓
- Orange `#FF6B2C` on Navy `#1B2440`: 5.4:1 — passes AA for normal text,
  but prefer it for accents, buttons and large headlines.
- Navy on Light: 13.6:1 — use for text on light backgrounds. ✓
- Never set Orange text on Light or Yellow backgrounds (fails AA).

## Logo

The mark is an **original** round cartoon bomb: a circle body with a flat
round shine, a stubby fuse, and a 4-point spark. It has no face, limbs or
character features and must never be given any — it is an object, not a
mascot, and must not be made to resemble any existing game character.

- `logo-mark.svg` — canonical mark (navy body) for light backgrounds.
- `wordmark.svg` — navy wordmark (Baloo 2 ExtraBold-feel, outlined paths,
  OFL licensed) for light backgrounds.
- `logo-horizontal.svg` — mark + wordmark, light backgrounds.
- `logo-horizontal-light.svg` / `logo-stacked.svg` — for navy/dark
  backgrounds (orange bomb body, light wordmark).
- `favicon.svg` — simplified high-contrast mark on a navy rounded tile,
  tuned to stay legible at 16px.

### Usage rules

- Clear space: keep at least the spark's height free around the logo.
- Minimum sizes: mark 16px, horizontal lockup 120px wide.
- Don't recolor outside the palette, don't rotate, don't add outlines,
  gradients or drop shadows, don't put the navy-body mark on dark
  backgrounds (use the dark-background variants).
- The in-game pixel-art UI intentionally uses the PICO-8 palette, not the
  brand palette. Brand colors are for marketing surfaces: site metadata,
  store pages chrome, social images, app icons.

## Regenerating assets

```bash
node brand/generate.mjs   # rebuilds all SVG/PNG/ICO and copies web assets
                          # into packages/client/public
```

Font: Baloo 2 (variable TTF, SIL Open Font License) — `Baloo2-ExtraBold.ttf`
is kept here only as a build input; the wordmark ships as outlined paths.
