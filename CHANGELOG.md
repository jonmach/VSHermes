# Changelog

## 2.0.1 (2026-08-13)

- **`@file` mentions** — `@` anywhere in the message opens a workspace file
  picker (files whose path contains the query, live as you type); selecting
  one inserts `@file <absolute path>` as a filename reference. No content
  inlining — Hermes reads the file itself via its own tools when it needs
  it. (Earlier draft inlined file contents; dropped by design to keep the
  prompt lean and let sub-agents read on demand.)

- **Chat window resets on session change** — `/new`, `/clear` and deleting
  the current session now clear the message list (webview rule: a `state`
  message with a different session id resets the view). Previously the old
  session's messages stayed on screen under the new session id.
- **Stop button fixed** — the send button doubles as Stop while streaming
  (■), but was disabled exactly while streaming, so clicks died; `/stop`
  still worked. The button is now always clickable and routes to stop.
- **No more fake stream errors on intentional abort** — Stop, `/new` and
  session switches mid-stream ended with a "Stream ended with an error:
  This operation was aborted" toast. `AbortError` is now treated as a clean
  stop (client-side).
- **Gateway health polling** — `/health` every 30s: gateway restarts flip
  the status bar/connection state automatically; reconnect refreshes
  capabilities, sync state and history. (Also surfaced a Hermes-side bug:
  a client disconnect mid-SSE-stream crashed the gateway process; fixed in
  the api_server stream handler by swallowing `ConnectionResetError`.)
- **Export Session as Markdown** — chat header icon + palette command;
  writes title, session metadata, messages, thinking (blockquotes) and tool
  calls to a `.md` file via save dialog.
- **Copy Conversation as Markdown** — chat header icon + palette command;
  same serialization, straight to the clipboard.
- **Copy buttons everywhere** — hover copy on message bubbles, thinking
  blocks, code blocks and tool outputs (webview-native clipboard with
  fallback). Code-block/tool-output buttons survive streaming updates.
- **Search History** — palette command filters the history tree by title,
  id, model or source (pure, unit-tested filter module).
- **Image thumbnails in history** — file-mode pasted images render as
  thumbnails when a session is re-opened or refreshed (stored path
  references mapped to webview URIs; attachments dir added to webview
  resource roots).
- **Publisher → synapticity** — extension id is now `synapticity.vsh-hermes`
  (marketplace listing + GitHub Release v2.0.0).
- **Packaging hygiene** — `.github/**` excluded from the vsix; test suite
  grown to 94 tests (session-switch clearing, stop-while-streaming, copy
  buttons, export markdown, session filter, image refs).

## 2.0.0 (2026-08-12)

- **Versioning reset.** The product is one release line, now at 2.0.0.
  Incremental 0.1.x builds were the same product at increasing build
  numbers; this marks the current build as 2.0.0 (BETA) as published in
  README + package.json. No functional change in this bump itself — see
  0.1.1–0.1.6 below for what the build contains.
- **Marketplace prep.** Added `repository` / `bugs` / `homepage` fields,
  128×128 marketplace icon (`media/icon-marketplace.png`), MIT `LICENSE`,
  and BETA branding in the listing metadata. README rewritten to describe
  current functionality and design decisions.

## 0.1.6 (2026-08-12)

- **`/title` is now a working slash command** — it was missing from the
  catalog entirely, so the picker couldn't show it. Picker → `/title ` →
  type the name → Enter → `PATCH /api/sessions/{id}` sets the session title
  (empty args opens an InputBox prompt instead). History + chat refresh.
- **`/status` added** — shows current session info in chat (id, title,
  model, message count, source, started) via GET /api/sessions/{id}.
- **Slash catalog synced with the Hermes reference** — `/branch` (fork
  alias) as an action; `/save`, `/compress`, `/queue`, `/steer` marked
  informational (sent as text, no API equivalent); TUI-only commands now
  listed honestly as unsupported (`/rollback`, `/diff`, `/snapshot`,
  `/goal`, `/fast`, `/reasoning`, `/voice`, `/approvals`, `/tools`,
  `/toolsets`, `/browser`, `/bundles`, `/learn`, `/init`, `/cron`,
  `/reload`, `/version`, `/whoami`, `/usage`, `/update`, `/paste`,
  `/image`, `/quit`). `/prompt`'s wrong summary fixed (it composes in
  $EDITOR — TUI-only, reclassified unsupported).

## 0.1.5 (2026-08-12)

- **Input helper text removed** — the "Enter to send · Shift+Enter newline ·
  / commands · paste or drop images" hint line under the input is gone
  (it wrapped on narrow sidebars), and the textarea placeholder is just
  "Message Hermes…" (dropped the "(/ for commands, paste images)" part).

## 0.1.4 (2026-08-12)

- **Home tab removed.** Webview-based views have an enforced minimum size in
  VS Code — a 40px dock still occupied ~150px of sidebar with blank space,
  and the border couldn't be dragged smaller. The four frequent actions are
  now icons in the Chat view's title bar (`+` New Chat, `⟳` Check Sync,
  `⚙` Switch Model, `↻` Refresh History — codicons with hover tooltips);
  Set API Key stays command-palette only. Container is now Chat + History.
  All actions remain in the palette (VSHermes: …). The home webview, its
  bundle, and its tests were deleted.

## 0.1.3 (2026-08-12)

- **Home tab slimmed to just the icon dock** — the connection status line
  (redundant with the status-bar item) and the "New actions will appear
  here" note are gone. The tab is now a single ~40px row of icon buttons.
  All actions remain available from the command palette (VSHermes: New
  Chat / Check Hermes Sync / Switch Model / Set API Key / Refresh History).

## 0.1.2 (2026-08-12)

- **Home tab compacted to icon buttons** — the six full-width text buttons
  (3 rows, ~130px) are now a single row of 28px icon buttons with hover
  tooltips. Labels moved into the tooltip (`title` + `aria-label`).
  Distinct glyphs: `+` New Chat, `⟳` Check Sync, `⚙` Switch Model,
  `🔑` Set API Key, `↻` Refresh History.
- **History button removed from Home** — History is already a sidebar tab in
  the same container (Home / Chat / History), and the button's focus-only
  behavior (no toggle) made a second click a no-op. The tab is the one door;
  the command palette entry (`VSHermes: Open History`) remains for keyboard
  users. Refresh History (`↻`) stays — it reloads the session list.

## 0.1.1 (2026-08-12)

- **Activity-bar icon fixed — root cause: client-side cache keyed to the
  extension install path.** The white square was NOT the icon file: six
  different files (badge, silhouette, PNG, official SVG, simplified redraw)
  all rendered identically because the VS Code client caches the container
  icon against the extension path (`vsh.vsh-hermes-0.1.0`), which never
  changed. The diagnostic chain: pixel-decoded user screenshots → identified
  every activity-bar item by shape (Claude, Cline, ACP all rendering fine) →
  the white square occupied the only slot matching none of the shipped
  icons → confirmed the file was never the variable. Bumping to 0.1.1
  creates a new install path and forces a fresh icon load. Confirmed fixed.
  **Lesson: for VS Code activity-bar container icons, a version bump is
  required for ANY icon change to reach the running UI.**

## 0.1.0 (2026-08-12)

Initial release.

- Chat panel over the Hermes API Server (Surface A): streaming session chat, markdown rendering, tool activity cards, thinking blocks
- Multiline input (Enter send / Shift+Enter newline)
- Image paste + drag-drop → data-URL image parts (downscaled over 8MB/4096px)
- Slash command picker with client-side catalog; TUI-only commands marked unsupported
- Session history tree (open / continue / fork / delete)
- Approval dialog + run stop (interrupt)
- Per-session model lock + model picker
- Sync engine: manifest diff against /health + /v1/capabilities with status bar + banner flagging
- Contract verified against Hermes 0.20.0 (see README diagnosis table)

## Fixed (0.1.0, second install)

- **Webview script died on load** — the DOM helper passed `#id` to
  `getElementById`, returning null on every element and crashing the module
  at the approval wiring. Enter, the send button, slash picker and sync
  banner were all dead. Fixed + covered by a jsdom test that runs the
  shipped bundle (`test/webview.test.ts`).
- **Check Sync gave no feedback when aligned** — now shows a toast with the
  verdict and logs every check to the new VSHermes Output channel.
- **Silent webview failures eliminated** — the webview reports script errors
  to the host (Output channel + error toast).
- CSP hardened (script-src includes the webview resource origin).
- **Image paste works with text-only main models** — pasted images are saved
  to $HERMES_HOME/attachments/ and referenced by path (vision_analyze →
  documented OMLX fallback) instead of being sent as image_url parts, which
  text-only models (deepseek-v4-flash) reject with 400. Configurable via
  `vsh.hermes.imageTransfer` (auto/inline/file; auto = inline only when the
  model advertises vision).
- **Check Sync is now visibly responsive on every path** — all triggers
  (command, banner button, welcome button) toast the verdict, and the banner
  shows the result for every status, including a green "✓ In sync" bar.
- **Home tab added** — action buttons (New Chat, Check Sync, Switch Model,
  History, Set API Key, Refresh) moved out of the Chat/History tab headers
  into a dedicated Home tab above Chat; future actions slot into it.
- **Activity-bar icon: root cause found and fixed** — the white square was
  NOT a rendering failure: VS Code tints activity-bar icons with the theme
  foreground, and the official Hermes Agent logo is too dense to read at
  24px (54% solid pixel coverage, 1px gaps — it renders as a solid white
  mass). The user-supplied `hermesagent.svg` was installed and rendering
  correctly all along; it *is* the white square. Verified by rendering the
  SVG at 24px and matching the pixel geometry of the user's screenshot.
  Fixed with a simplified redraw of the same logo (head circle, wings, two
  pillars, base — 19% coverage, real negative space), which reads clearly
  at 24px. Lesson: activity-bar icons need strong negative space at 24px;
  dense logos (however official) render as solid blocks.
- **Welcome screen removed from the Chat tab** — the centered New chat /
  Check sync buttons it carried confused the layout (those actions live in
  the Home tab now); replaced with a slim inline hint when no session exists.
- **History button focus hardened** — falls back to focusing the VSHermes
  container if the generated view-focus command is unavailable.

