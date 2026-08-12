# Changelog

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

