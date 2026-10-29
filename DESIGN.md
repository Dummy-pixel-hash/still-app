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

Preserve the terminal workspace and its recognizable structure. The Agents surface keeps the accepted **Minimal index** layout: neutral black and text-led controls, with the user's clarified horizontal red particle aurora and genuinely frosted writing/history panes. This is scoped to Agents; it does not restyle the terminal workspace or orb.

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

### Agent workspace — T3-informed operating surface

The structural reference is **T3 Code's actual desktop workspace and OpenAI's Codex desktop app**. The latest direction keeps **Minimal index**, replacing the blue-black glass experiment: #050505 content, near-black navigation, neutral off-white type, and a horizontal red particle aurora. The user clarified that the particles should radiate outward from a gently undulating horizontal band, not scatter uniformly across the screen or form a connected stroked line. There is no blue foundation or outer window ornament. Glass is genuinely translucent: the writing surface samples the aurora through 28px backdrop blur, the compact recent-conversation pane through 22px blur, and the header through 20px blur. Semantic provider marks and real file additions/removals retain their colors.

The launch headline stays on the open workspace, with a 46.2px serif heading at desktop size and a 33px minimum. The redundant hero mark, tagline, and footer note are removed. Prompt starters remain functional but are text-only actions rather than icon pills. Recent conversations sit in a compact frosted pane beside the composer, with provider/folder metadata retained as text. The horizon now behaves as flowing gas and fine dust rather than a fixed particle line: domain-warped noise makes soft, changing wisps, and thousands of particles follow a shared curling flow. One visible canvas draws roughly 10,000 points at the usual desktop width, capped at 12,000, with a 3,600-point compact budget. Dust is batched into four fills, not individual draw calls or DOM nodes. The gas texture is at most 176 × 56 pixels, refreshed at 15fps; the composed scene is capped at 30fps and 900,000 backing pixels. Motion stops for reduced motion, hidden windows, and unmount. A static SVG is requested only when canvas cannot initialize. The effect never intercepts input. Compact launch rows size to their content so the headline cannot overlap the composer.

Navigation shares the same smoked-glass material: sidebar and header both use 28px backdrop blur, a translucent near-black base, and fine silver edges. The sidebar is an inset rounded pane (280px including its desktop gutter), collapsing to a 56px pane; on mobile it becomes a rounded drawer offset from the viewport edge. The topbar is an inset 44px strip with a 10px top margin (46px plus 8px on mobile), preserving its original 54px layout allocation. Search and New conversation have restrained glass surfaces rather than default flat fills. The Still mark and selected conversation use muted rose-red, not the old blue selection outline. Sidebar search, collapse, and mobile focus behavior remain intact; the aurora/composer layout is not moved to accommodate chrome styling.

The material system covers the full conversation path, not only the launch screen. `agent-materials.css` defines shared etched-control, inset, sheet, and elevated-sheet tokens for sidebar actions, messages, model/command/project menus, requests, settings dialogs, change summaries, and the Changes pane. The sidebar has a distinct hierarchy: editorial Still wordmark, one inviting glass New conversation action, quiet inset search, generous project-group spacing, and open conversation rows. Selection is a warm, low-contrast wash without a formal outline; provider marks and activity times stay legible. Reading glass is applied once to the conversation viewport; individual messages and nested tool/code blocks do not each create blur layers. Code remains dark and readable, and real additions/deletions keep semantic green/red. New-conversation and Changes have purpose-drawn SVG marks; standard navigation icons and provider identities are retained. The composer shortcut-hint element is removed, not merely hidden. Keyboard instructions remain in the textarea's accessible description; genuine preparation/loading notices render separately as a status.

These are shared production components: `Workspace` opens `RemoteAgentWorkspace`, which renders `AgentWorkspace` with the same material CSS and particle renderer used by the fixtures. The real `/` application entry is covered by a Playwright integration test. Live-design scripts, tokens, and session artifacts are not part of the shipped app or source commit.

After the user rejected the split-rail sidebar, navigation became **one full-width 272px column**, closer to Codex's folder-and-thread hierarchy. A compact header holds the Still wordmark and collapse toggle; labelled New conversation, search, and archive actions precede the project list. Folder groups contain compact single-line conversation rows, with a small provider mark, readable title, and relative activity. Contextual actions replace the trailing time on hover/focus, keeping the title's position stable. Settings sits at the bottom; routine save-success copy stays hidden while save failures remain explicit. The **48px icon rail appears only when collapsed**. Search and `/sessions` expand and focus the search field, and Ctrl/Cmd+backslash toggles the panel. Server/path remains available in accessible names and tooltips. Selection, pending input, and working state are visually distinct. The main panel keeps its own 54px header but no decorative outer frame.

Folders own conversations. Global entry never chooses the first terminal, a default home directory, or a main project. Global New begins an unassigned draft; project-scoped New has a visible host/path. Thread actions live in anchored, keyboard-operable contextual menus. Agent/model, message, and Send/Stop lead the composer; configuration and diagnostics are disclosed on demand. Saved/offline history is an ordinary state. Tools form compact, stable activity groups with lazily revealed detail; approvals and actionable errors remain visible.

Selecting an agent for a chosen project connects it before the first message. A compact status line above the composer shows connecting, model-ready, and actionable connection errors. The provider picker stays available while preparing; the model picker and Send enable once that selected connection is ready. Switching providers keeps the draft, and unused preparations are cleaned up. Send claims the prepared connection as the actual conversation. No manual Connect button returns.

Supported user messages have compact **Revert** and **Retry** text actions beneath the message. A focused confirmation names the chosen message and makes the scope clear: conversation history, with project files kept. Retry uses the selected model and retains an unrelated draft. Actions remain disabled while a turn or history change is active, during offline reading, or when its delivery is uncertain; unsupported providers and messages without provider checkpoints omit them.

Home and a new conversation lead with a clear serif heading, the actual composer immediately below, and optional text prompt starters that only fill the draft. Recent local conversations sit alongside returning users' drafts and stack below at compact widths. No server/project is implicitly selected. The same composer docks below the transcript once a conversation exists, with a clear writing area, a recognizable provider, searchable model controls, and a circular neutral Send/Stop action. Command search is available beside Send and from Ctrl/Cmd+P or `/`; `/settings` opens secondary provider options. Execution context sits on a separate small line beneath. The body uses Geist at 15px; navigation uses 13px and contextual metadata 11–12px. Code uses Geist Mono and real syntax highlighting.

T3's change-review workflow is the second anchor: the header and an in-conversation file summary open a **Changes inspector** built from provider-supplied diffs. It shows filenames, computed additions/removals, and unified hunks with line numbers. Failed, pending, and unconfirmed edits are labelled explicitly and excluded from completed-change totals. It is not a claim about the current remote working tree. The inspector is side-by-side on larger windows and an accessible dismissible drawer on smaller ones. The mobile project drawer also owns focus and restores its trigger on dismissal. No inert Open/Commit controls or invented repository data. Short positional transitions clarify entering a conversation, revealing tools, and opening review; reduced motion remains fully supported.

Native persistence owns metadata and drafts independently of provider executions. Long histories open a recent page with explicit earlier-activity loading and full-conversation message search. Scrolling follows the end only when appropriate, anchors a newly submitted turn, and preserves the reader's item/offset during streaming, disclosure, resize, and conversation switches. Copy and external-link actions keep the native OS bridge. Menu entrance is 150–180ms; disclosure uses a measured 170ms transition; deliberate list reordering uses 150ms positional feedback. Reduced motion removes travelling and size transitions. Streamed tokens have no entrance animation.

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
