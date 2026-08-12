# Changelog

## [0.1.0] — 2026-08-12

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

