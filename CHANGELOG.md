# Changelog

## [0.1.0] — 2026-08-12

Initial release.

- Chat panel over the Hermes API Server (Surface A): streaming session chat, markdown rendering, tool activity cards, thinking blocks
- Multiline input (Enter send / Shift+Enter newline)
- Image paste + drag-drop → data-URL image parts
- Slash command picker with client-side catalog; TUI-only commands marked unsupported
- Session history tree (open / continue / fork / delete)
- Approval dialog + run stop (interrupt)
- Per-session model lock + model picker
- Sync engine: manifest diff against /health + /v1/capabilities with status bar + banner flagging
- Contract verified against Hermes 0.20.0 (see README diagnosis table)
