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

The frontmatter records the existing tokens in `src/styles/tokens.css` and `theme.css`. Red is reserved for the brand (mark, ambient workspace glow, aurora), destructive actions and genuine failures. Ordinary interaction states are neutral: focus rings (`--ring`, `--ag-focus`), text selection, input focus borders, hover glows, drop indicators and selected options use off-white washes. Connected is calm green, working is blue, attention and uncertain states are amber. Orb light colours are state-specific and live in `src/orb/glassRenderer.ts`: cool blue/violet for observed output, amber for attention, red/pink for errors, and quiet neutral light for unknown/idle. The renderer also supports a green completion appearance, but a connection does not establish agent completion.

## Typography

Keep the existing Geist/system UI stack for controls and explanatory text, the mono stack for terminal/code content, and Instrument Serif/Georgia for incumbent display headings. The orb has no typography painted into its canvas; status names belong in accessible labels and the session menu.

## Layout

Preserve project/card organization and the card-origin terminal transition. Settings is a **full page**: a portalled, full-screen dialog with a header (title, search, Close), a vertical category tablist on the left (Up/Down/Home/End; a select below 640px) and the active category's panel on the right. Categories are General, Terminal, Themes, Accessibility, Keyboard shortcuts, SSH keys, Companion and Updates. Search lists every matching setting grouped by category with a count on each tab; Escape clears the search first, then closes and returns focus to the opener. Controls wrap rather than forcing horizontal scrolling, and no text on the page is smaller than 12px. The standalone native orb is a separate, compact webview, not a scaled-down workspace.

## Terminal themes

Every terminal draws from a **theme**: 21 colour slots (background, foreground, cursor, cursor text, selection and the 16 ANSI colours). Six built-in presets ship, all with original names: **Still** (the exact shipped palette and the default), **Still high contrast** (every colour at least 7:1), **Paper** (light), **Tide**, **Moss** and **Dusk**. Presets are read-only; duplicating one creates a custom theme (up to 50) that can be renamed, recoloured with a picker plus hex field, and deleted. Contrast warnings are advisory (text 4.5:1, ANSI colours and cursor 3:1) and announced in a status region.

The default theme, font size, cursor, blink, minimum contrast, screen-reader mode and visual bell live in Settings. A single terminal may override only **theme** and **font size**: zooming (Ctrl +, -, 0) and the command palette write to that session and never to the global default, and clearing an override falls back to the default. Resolution order is session override, then default, then the Still preset, so a deleted theme can never leave a terminal unthemed.

Themes colour **terminal surfaces and card previews only** (the overlay background, xterm, the card's preview well and its fade) through `--term-bg`, `--term-fg`, `--term-preview-fg` and `--term-cursor`. They never recolour workspace chrome, the Agents surface or the orb, and the overlay's footers and controls pill stay dark on purpose. Themes are renderer-only data and never enter `ConnectRequest`. Minimum contrast defaults to "automatic": 1 (unchanged look) unless the OS asks for more contrast (4.5). Cursor blink "automatic" stops under reduced motion.

Inside xterm, Ctrl+/ and Ctrl+K belong to the shell (undo, kill-line). App shortcuts that act inside a terminal use Ctrl+Shift+letter or F6 (find Ctrl+Shift+F, palette Ctrl+Shift+K, shortcut help Ctrl+Shift+/, controls pill F6). One registry, `src/ui/shortcuts.ts`, drives the overlay's capture gate, xterm's key backstop, the help dialog and the Settings list.

## Errors and notices

Errors must never dominate the screen. Every error, warning or status notice, in the terminal and in Agents, is **one line**: a 6px tone dot, one short plain sentence in normal or dim text, and at most a couple of non-wrapping actions. Tone lives only in the dot: rose for a real failure, amber for attention or uncertainty, blue for working, neutral for information. There are no tinted red backgrounds or borders and no red body text.

Raw technical text (stderr, OS error chains, stack traces, JSON, full public keys) is never the headline. `splitErrorText` in `src/bridge/errors.ts` derives the visible sentence; the untouched original sits behind a **Details** disclosure in mono with a capped, scrollable height so it can still be copied. The helper is display-only: stored values such as `lastError` keep their `[code]` prefixes for logic.

One problem is stated once, in its primary place; elsewhere it appears only as a status dot. Agents shows at most one notice row beneath the topbar, with a "+N more" popover that overlays rather than pushes the transcript. Composer notices are capped at about three rows, and the composer dock never covers more than 60% of the conversation. Consecutive identical transcript errors collapse into one row with a count; failed activity groups stay collapsed with a failure count. Host-key verification is the deliberate exception: it remains a full card because it is a security decision, though its full key is disclosed on demand.

Pills and capsules never wrap: the terminal controls pill and composer controls truncate text instead, so their height is constant at every window size.

## Elevation & Depth

The sphere's depth comes from the original shader's lens, folded light, and reflections, not a large external glow or backdrop blur. Its surroundings are genuinely transparent. Native context menus follow the operating system; the browser-only preview uses a dark, elevated menu.

## Shapes

Keep existing workspace/window and field radii. The orb silhouette stays circular across states. Its visible size is selectable at 48, 64, or 96 CSS pixels; extra canvas space is for anti-aliasing and focus, not a surrounding panel.

## Components

### Agent workspace — T3-informed operating surface

The structural reference is **T3 Code's actual desktop workspace and OpenAI's Codex desktop app**. The latest direction keeps **Minimal index**, replacing the blue-black glass experiment: #050505 content, near-black navigation, neutral off-white type, and a horizontal red particle aurora. The user clarified that the particles should radiate outward from a gently undulating horizontal band, not scatter uniformly across the screen or form a connected stroked line. There is no blue foundation or outer window ornament. Glass is genuinely translucent: the writing surface samples the aurora through 28px backdrop blur, the compact recent-conversation pane through 22px blur, and the header through 20px blur. Semantic provider marks and real file additions/removals retain their colors.

The launch headline stays on the open workspace, with a 46.2px serif heading at desktop size and a 33px minimum. The redundant hero mark, tagline, and footer note are removed. Prompt starters remain functional but are text-only actions rather than icon pills. Recent conversations sit in a compact frosted pane beside the composer, with provider/folder metadata retained as text. The horizon now behaves as flowing gas and fine dust rather than a fixed particle line: domain-warped noise makes soft, changing wisps, and thousands of particles follow a shared curling flow. One visible canvas draws roughly 10,000 points at the usual desktop width, capped at 12,000, with a 3,600-point compact budget. Dust is batched into four fills, not individual draw calls or DOM nodes. The gas texture is at most 176 × 56 pixels, refreshed at 15fps; the composed scene is capped at 30fps and 900,000 backing pixels. Motion stops for reduced motion, hidden windows, and unmount. A static SVG is requested only when canvas cannot initialize. The effect never intercepts input. Compact launch rows size to their content so the headline cannot overlap the composer.

Navigation shares the same smoked-glass material: sidebar and header both use 28px backdrop blur, a translucent near-black base, and fine silver edges. The sidebar is an inset rounded pane (280px including its desktop gutter), collapsing to a 56px pane; on mobile it becomes a rounded drawer offset from the viewport edge. The topbar is an inset 44px strip with a 10px top margin (46px plus 8px on mobile), preserving its original 54px layout allocation. Search and New conversation have restrained glass surfaces rather than default flat fills. The Still mark is the custom terminal tile in `public/agents/still-terminal-icon.svg`; selection uses muted rose-red, not the old blue outline. Sidebar search, collapse, and mobile focus behavior remain intact; the aurora/composer layout is not moved to accommodate chrome styling.

The material system covers the full conversation path, not only the launch screen. `agent-materials.css` defines shared etched-control, inset, sheet, and elevated-sheet tokens for sidebar actions, messages, model/command/project menus, requests, settings dialogs, change summaries, and the Changes pane. The sidebar has a distinct hierarchy: editorial Still wordmark, one inviting glass New conversation action, quiet inset search, generous project-group spacing, and open conversation rows. Selection is a warm, low-contrast wash without a formal outline; provider marks and activity times stay legible. Reading glass is applied once to the conversation viewport; individual messages and nested tool/code blocks do not each create blur layers.

The composer is one calm writing surface with a soft glass edge. Its writing rail keeps the provider mark inside a single filled model pill, places bare rounded reasoning bars beside it, and gives the mode one quiet action; only the circular neutral Send/Stop control carries full weight. The bars render one step per option reported by the current model, preserving provider order and exact values. Clicking anywhere on the reasoning control advances to the next reported effort and wraps at the end; Enter and Space do the same. There is no surrounding box or visible label/tooltip, while screen-reader labels retain the current and next values. The model menu contains only model search and a compact name list; selecting a model closes it after acknowledgement. Reasoning is not duplicated inside that menu.

The focus cue belongs to the composer's outer edge rather than the textarea. Expansion measures text at its final width, then morphs only the glass shell and crossfades the controls. Text width and minimum height are never animated, so opening the composer cannot inflate the input until the first keystroke. Interrupted transitions continue from the current glass frame, and reduced motion skips the morph. Code remains dark and readable, and real additions/deletions keep semantic green/red. New-conversation and Changes have purpose-drawn SVG marks; standard navigation icons and provider identities are retained. The composer shortcut-hint element is removed, not merely hidden. Keyboard instructions remain in the textarea's accessible description; genuine preparation/loading notices render separately as a status. Tauri WebViews also receive a native-only translucent material treatment on the glass surfaces, so the frost remains visible when a WebView renderer parses but fails to composite CSS backdrop filters; the browser keeps sampling the live aurora directly.

These are shared production components: `Workspace` opens `RemoteAgentWorkspace`, which renders `AgentWorkspace` with the same material CSS and particle renderer used by the fixtures. The real `/` application entry is covered by a Playwright integration test. Live-design scripts, tokens, and session artifacts are not part of the shipped app or source commit.

After the user rejected the split-rail sidebar, navigation became one rounded, inset pane with **272px of usable content inside a 280px desktop width**. It keeps the folder-and-thread hierarchy while separating visually from the open black canvas. A compact header holds the Still wordmark and collapse toggle; New conversation, search, and archive actions precede the project list. Folder groups have more breathing room around single-line conversation rows, with provider mark, readable title, and relative activity. Contextual actions appear on hover/focus, and settings stays at the foot. Routine save-success copy stays hidden while save failures remain explicit. The **48px navigation rail sits inside the 56px collapsed pane**. Search and `/sessions` expand/focus search; Ctrl/Cmd+backslash toggles it. Server/path remain available to assistive tech. Selection is a warm translucent wash, not an outline. On mobile the same pane is an offset rounded drawer and preserves focus on dismissal.

Folders own conversations. Global entry never chooses the first terminal, a default home directory, or a main project. Global New begins an unassigned draft; project-scoped New has a visible host/path. Thread actions live in anchored, keyboard-operable contextual menus. Agent/model, message, and Send/Stop lead the composer; configuration and diagnostics are disclosed on demand. Saved/offline history is an ordinary state. Tools form compact, stable activity groups with lazily revealed detail; approvals and actionable errors remain visible.

Selecting an agent for a chosen project connects it before the first message. A compact status line above the composer shows connecting, model-ready, and actionable connection errors. The provider picker stays available while preparing; the model picker and Send enable once that selected connection is ready. Switching providers keeps the draft, and unused preparations are cleaned up. Send claims the prepared connection as the actual conversation. No manual Connect button returns.

Supported user messages have compact **Revert** and **Retry** text actions beneath the message. A focused confirmation names the chosen message and makes the scope clear: conversation history, with project files kept. Retry uses the selected model and retains an unrelated draft. Actions remain disabled while a turn or history change is active, during offline reading, or when its delivery is uncertain; unsupported providers and messages without provider checkpoints omit them.

Home and a new conversation lead with a clear serif heading, the actual composer immediately below, and optional text prompt starters that only fill the draft. Recent local conversations sit alongside returning users' drafts and stack below at compact widths. No server/project is implicitly selected. The same composer docks below the transcript once a conversation exists, with a clear writing area, a recognizable provider, searchable model controls, and a circular neutral Send/Stop action. Command search is available beside Send and from Ctrl/Cmd+P or `/`; `/settings` opens secondary provider options. Execution context sits on a separate small line beneath. The body uses Geist at 15px; navigation uses 13px and contextual metadata 11–12px. Code uses Geist Mono and real syntax highlighting.

The Changes screen is a **Still-native review workspace**, not a generic edge-to-edge editor or side drawer. Opening it temporarily replaces project navigation with changed-file navigation; returning restores the conversation, draft, scroll, and saved sidebar preference. One inset rounded smoked-glass shell contains the source switch, file navigator, and uninterrupted reading area. It inherits the composer's translucent near-black material, fine silver edge, Geist controls, and muted rose selection. The aurora remains visible behind the shell, not through individual code lines. Terminal, orb, and ordinary conversation styling are unchanged.

Changes has one quiet shell header, a file rail on spacious desktop windows, and a selected-file heading above the diff. Narrow windows switch between file navigation and reading rather than adding another overlay. Controls use the same rounded, understated vocabulary as the composer. The review-specific diff renderer has aligned before/after gutters, legible mono text, restrained semantic green/rose changed lines, and softly separated hunks. No nested glass cards or repeated path toolbars. Repository details remain available on demand. Repository and Conversation never share data semantics: Repository is the current read-only Git snapshot; Conversation is the history of supplied edits. Failed, pending, and unconfirmed edits remain explicit and excluded from completed totals. Raw, snippet, write-only, binary, offline, and error states remain honest; no original file, line count, or repository state is invented. Source-tab arrow keys stay independent of comparison controls.

Native persistence owns metadata and drafts independently of provider executions. Long histories open a recent page with explicit earlier-activity loading and full-conversation message search. Scrolling follows the end only when appropriate, anchors a newly submitted turn, and preserves the reader's item/offset during streaming, disclosure, resize, and conversation switches. Copy and external-link actions keep the native OS bridge. Menu entrance is 150–180ms; disclosure uses a measured 170ms transition; deliberate list reordering uses 150ms positional feedback. Reduced motion removes travelling and size transitions. Streamed tokens have no entrance animation.

- **SmokedGlassOrb:** reusable, status-driven rendering; bounded resolution and frame rate; pause plus a Slow/Normal/Fast speed preference; static visible frames when paused or reduced motion is requested. Canvas2D is the graceful fallback, not the default design.
- **Orb companion controls:** opt-in enable, size, motion, and reset; actual pending/error feedback. The small settings material preview is explicitly not live status.
- **Orb action:** click/Enter/Space returns to Still; dragging must not trigger activation. A small status symbol supplements colour, and the menu exposes readable status labels.
- **Session menu:** metadata only, with session activation, motion, reset, and hide. No synthetic session data in the live interface.

## Android phone library

The phone keeps its approved flat black/rose identity (`#080809`, `#eee9ed`,
`#b5a9b8`, `#f0b0c5`), Source Sans 3 body text, Bricolage Grotesque headings and
floating navigation. Do not bring desktop window controls or sidebar framing into
this shell.

Threads form flat, collapsible project sections identified by exact server/account
and remote folder, never just a folder basename. Native project and sort pickers
offer All projects, recent project activity and natural A–Z ordering. Each section
shows its name, server/path, thread count and attention count; pinned conversations
lead, then newest activity. Search, a selected project and Needs you expose matching
rows even if their All projects section was collapsed. Sync is one compact action,
with account choices disclosed only when needed.

Project selection, sort and collapsed sections are device-owned preferences; they
do not reorder shared metadata or start providers. All projects keeps New task
unassigned; an explicitly selected active project becomes the new task's visible
context. Accessible native pickers have at least 48px touch targets. Empty states
explain the current scope and offer a return to All projects. Existing titles,
history, drafts, unread state, provider identities and terminal navigation survive
view changes.

## Do's and Don'ts

- Do match the selected glass study at actual desktop size over both dark and light backgrounds.
- Do preserve the main window's opacity and existing terminal appearance.
- Do keep material animation independent of status observation and IPC.
- Don't add eyes, a segmented neon ring, a full-rainbow voice visualization, or microphone behavior.
- Don't label connection activity as a confirmed agent verdict, or silence/disconnection as completion.
