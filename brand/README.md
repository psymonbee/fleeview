# agenticADE — brand assets

Logo system for **agenticADE** (Agentic Development Environment). The mark is an
**open swarm of bubbles** — carbonation *and* agents rising in parallel — playing on
the fizzy-drink `-ade` suffix.

## Files

| File | Use |
| --- | --- |
| `symbol.svg` | Open-swarm symbol (transparent). Primary mark in the wild. |
| `app-icon.svg` | Contained swarm on a crimson tile. Source for app icon / favicon. |
| `lockup-light.svg` / `lockup-dark.svg` | Symbol + wordmark. Everyday horizontal logo. |
| `wordmark-light.svg` / `wordmark-dark.svg` | Wordmark only, with the pink i-dot bubble. |
| `png/` | Rendered PNGs of each (512/1024 for marks, 1200–1600 wide for type). |

Use `*-light` on light backgrounds, `*-dark` on dark. All SVGs are **self-contained
outlines** — no font needed to render them.

Favicons live in `../public/`: `favicon.svg`, `favicon.ico` (16/32/48),
`favicon-16/32/48.png`, `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`.

## Colors

| Token | Hex | Role |
| --- | --- | --- |
| Cherryade crimson | `#E11D6B` | Primary — `ADE`, symbol, tile |
| Fizz pink | `#FF5C8A` | Accent — i-dot bubble, highlight bubbles |
| Ink | `#201A2A` | `agentic` on light backgrounds |
| Ink (dark mode) | `#EDE9F2` | `agentic` on dark backgrounds |
| Paper | `#FBF7F0` | Light surface |
| Charcoal | `#17161C` | Dark surface |

### Flavor system (optional theming)

The mark reflavors for themes/modes: cherry `#E11D6B` · lemon `#F5B301` ·
lime `#7CB518` · orange `#FF6A2B`.

## Typography

Wordmark set in **Space Grotesk** (weight 600), [SIL OFL 1.1](https://github.com/floriankarsten/space-grotesk).
The delivered SVGs are outlined, so the font is not a runtime dependency.

## Wiring the favicon

Add to `public/index.html` `<head>`:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```
