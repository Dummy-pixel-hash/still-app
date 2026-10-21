---
name: Still
description: Persistent remote terminals with an opt-in smoked-glass companion
colors:
  ink: "#050505"
  foreground: "#e2dce5"
  dim: "#99929f"
  card: "#0b0b0e"
  border: "#242126"
  accent: "#ff4a4a"
typography:
  display:
    fontFamily: "Instrument Serif, Georgia, serif"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
  mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
rounded:
  window: "8px"
  field: "8px"
  menu: "12px"
---

# Design System: Still

## Overview

Preserve the incumbent workspace. It is a dark spatial terminal workspace, with restrained red accents and serif display headings; it is not being redesigned as part of the companion work.

The user selected **B · Smoked glass** from `../orb-mockups/`. That approved material is the visual authority for the orb: a near-black spherical shell, asymmetric silver rim, and a folded ribbon of blue, violet, and pearl light. Existing UI controls remain ordinary, legible controls rather than becoming glass objects.

## Colors

The frontmatter records the existing tokens in `src/styles/tokens.css` and `theme.css`. The red accent remains the workspace interaction colour. Orb light colours are state-specific and live in `src/orb/glassRenderer.ts`: cool blue/violet for observed output, amber for attention, red/pink for errors, and quiet neutral light for unknown/idle. The renderer also supports a green completion appearance, but a connection does not establish agent completion.

## Typography

Keep the existing Geist/system UI stack for controls and explanatory text, the mono stack for terminal/code content, and Instrument Serif/Georgia for incumbent display headings. The orb has no typography painted into its canvas; status names belong in accessible labels and the session menu.

## Layout

Preserve project/card organization and the card-origin terminal transition. Settings extend the existing scrollable sheet; controls wrap rather than forcing horizontal scrolling. The standalone native orb is a separate, compact webview, not a scaled-down workspace.

## Elevation & Depth

The sphere's depth comes from the original shader's lens, folded light, and reflections, not a large external glow or backdrop blur. Its surroundings are genuinely transparent. Native context menus follow the operating system; the browser-only preview uses a dark, elevated menu.

## Shapes

Keep existing workspace/window and field radii. The orb silhouette stays circular across states. Its visible size is selectable at 48, 64, or 96 CSS pixels; extra canvas space is for anti-aliasing and focus, not a surrounding panel.

## Components

- **SmokedGlassOrb:** reusable, status-driven rendering; bounded resolution and frame rate; pause plus a Slow/Normal/Fast speed preference; static visible frames when paused or reduced motion is requested. Canvas2D is the graceful fallback, not the default design.
- **Orb companion controls:** opt-in enable, size, motion, and reset; actual pending/error feedback. The small settings material preview is explicitly not live status.
- **Orb action:** click/Enter/Space returns to Still; dragging must not trigger activation. A small status symbol supplements colour, and the menu exposes readable status labels.
- **Session menu:** metadata only, with session activation, motion, reset, and hide. No synthetic session data in the live interface.

## Do's and Don'ts

- Do match the selected glass study at actual desktop size over both dark and light backgrounds.
- Do preserve the main window's opacity and existing terminal appearance.
- Do keep material animation independent of status observation and IPC.
- Don't add eyes, a segmented neon ring, a full-rainbow voice visualization, or microphone behavior.
- Don't label connection activity as a confirmed agent verdict, or silence/disconnection as completion.
