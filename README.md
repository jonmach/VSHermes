# VSHermes — Hermes Agent chat for VS Code

> One product, current build 2.0.4 — each build re-verified
> against the pinned Hermes API surface. This README describes current
> functionality, not history (see CHANGELOG.md for the change log).

A Claude-Code-style chat panel for [Hermes Agent](https://hermes-agent.nousresearch.com),
running over the **Hermes API Server** — not a terminal wrapper. The chat
lives in a webview panel in the sidebar: real multiline input, image paste,
a slash-command picker, session history, live tool activity, approvals, and
model switching.

## Features

**Chat panel**
- Multiline input: **Enter** sends, **Shift+Enter** inserts a newline; the
  input auto-grows with its content (long absolute paths wrap instead of
  scrolling) and resets to one line after send
- Streaming markdown rendering; thinking shown in a collapsible block; tool
  calls rendered as live cards (`tool.started` / `tool.progress` /
  `tool.completed`)
- **Stop** — the send button doubles as Stop while streaming (aborts the
  stream and calls `POST /v1/runs/{id}/stop`); `/stop` works identically.
  Intentional aborts end cleanly with no spurious error
- **Approval dialogs** for agent actions that require it
  (`POST /v1/runs/{id}/approval` — deny / once / session / always)
- **Copy buttons** (hover, one click): every message bubble, thinking block,
  code block and tool output can be copied — clipboard handled in the
  webview, no host round-trip
- `/new`, `/clear` and deleting the current session **reset the chat
  window** — the view always shows the current session's messages
- **`@` file references** — type `@` anywhere in the message and a
  workspace file picker opens (`@CHAN` lists every file whose path contains
  "CHAN", live as you type); selecting one inserts `@<absolute path>` — a
  plain reference (files or folders), never copied. A **Browse…** entry at
  the bottom of the picker opens the OS dialog for anything outside the
  workspace. Hermes reads the content itself via its own tools when it
  needs it, so the prompt stays lean
- **Attach files** (`@file <path>`, paperclip button, or drag & drop
  anywhere on the panel) — the file is **copied into
  `$HERMES_HOME/attachments/`** (deterministic name, no duplicates on
  re-send) and sent as `@file <copy path>`: the message stays a small path
  per file, the session owns a durable copy (survives the original moving
  or being deleted), and the LLM decides whether/when to load the content.
  No size limit — zips, PDFs, datasets and binaries all work. **Drag &
  drop** works from the OS file manager (local windows) and from the
  Explorer/tree views. One caveat — **devcontainers / remote workspaces**:
  VS Code does not deliver host-filesystem (Finder) drops to webviews
  there, which is *correct* VS Code behavior (microsoft/vscode#193558,
  #158150), not a VSHermes bug; use the **paperclip** (container file
  picker) in that case, or drop the file into the Explorer first (uploads
  it into the container), then drag it from there

**Images**
- Paste or drag-drop into the chat; chips show pending attachments
- Default **file mode**: images are saved to `$HERMES_HOME/attachments/` and
  sent as a path reference, so text-only main models still work via Hermes'
  own vision fallback chain. `vsh.hermes.imageTransfer`: `auto | inline | file`
  (`auto` = inline only when the model advertises vision capability)
- `vsh.hermes.maxImageBytes` / `vsh.hermes.maxImageDimension` downscale
  oversized pastes before sending
- Pasted images render as **thumbnails in history** — stored
  `[Image pasted: …]` path references are mapped to webview-loadable URIs on
  render (attachments directory registered in the webview resource roots)

**Slash commands** (`/` opens the picker)
- Working actions (executed client-side against the API):
  `/new` `/clear` `/model` `/stop` `/history` `/sessions` `/resume`
  `/title` `/status` `/skills` `/fork` `/branch` `/help`
  (`/title My Session` sets the session title via `PATCH /api/sessions/{id}`;
  `/status` shows session info in chat)
- Informational (sent to Hermes as plain text, flagged as such):
  `/compact` `/retry` `/personality` `/save` `/compress` `/queue` `/steer`
- TUI-only commands (`/undo` `/yolo` `/rollback` `/diff` `/goal` `/cron`
  `/memory` `/mcp` `/plugins` …) are listed honestly as **unsupported** and
  never sent as literal text

**Endpoints** (gear codicon in the chat title bar, or "VSHermes: Endpoints…")
- A built-in **Local connection** row is always present (legacy resolution:
  baseUrl setting → `$HERMES_HOME/.env` → `http://127.0.0.1:8642`) — click
  Activate to return to it; it has none of the remote constraints
- Named endpoint profiles (name + URL), each with its own API key stored in
  VS Code **SecretStorage** (never settings.json) — e.g. your local
  container and a Hermes API server on another machine. **A profile's key
  is the `API_SERVER_KEY` from *that server's* Hermes `.env`** — the
  gateway's bearer credential. It is unrelated to model/provider keys
  (DeepSeek, OpenAI, …), which Hermes holds in its own config
- **Remote endpoints require a key** — a non-loopback profile without an
  API key is refused at connect ("Remote endpoints require the server's
  API_SERVER_KEY — set it in the Endpoints panel (Save key)"), the panel
  badge shows `key required`, and **activation is refused too** — a
  keyless remote endpoint never becomes active (panel Activate and
  auto-switch on session open both fail with a clear note). Keyless
  connections are only possible to loopback (local) servers
- **Test** probes reachability *and* validates the key (an authenticated
  probe after `/health`), so a missing or wrong key is reported explicitly
  instead of a false "OK"; Activate switches and reconnects. With no
  profiles configured, behaviour is unchanged
- **Remote endpoints** (any non-loopback host) disable file attach — the
  gateway can't receive files, so `@file`, the paperclip and drag & drop
  are hard-restricted with clear messages; `@path` references stay allowed
  (plain text). Pasted images are **sent inline** over HTTP, so image paste
  keeps working with a vision-capable model
- Switching endpoints resets the current chat session (ids are
  server-scoped); the abandoned session stays on its server. Reconnects
  are deduped per server (a switch never reuses an in-flight connection to
  a different server) and the "/help" welcome posts once per activation,
  not per switch

**Sessions**
- History tree view grouped **per server**: one collapsible section per
  server (Local, profile names), keyed by **canonical URL** — two profiles
  pointing at the same machine collapse into a single section — with an
  attach-enabled/disabled badge; cached across reloads. A background
  refresh that outlives an endpoint switch is stored under the server it
  actually queried, so sessions can never be mis-filed under another server
- **Opening a session auto-switches to the server it lives on** — you
  continue where you left off, on the right machine; fork/delete do the
  same. An unreachable server surfaces a clear error and the chat stays put
- Terminal (CLI) sessions open with full history — one pool of sessions

**Actions & navigation**
- Chat header icons: New Chat, Check Sync, Switch Model, Refresh History,
  Export as Markdown, Copy Conversation
- Every action also in the command palette (`VSHermes: …`), incl. Set API Key
  and **Search History** (filters the history tree by title / id / model /
  source; empty input clears)
- Status bar: connected / offline / sync-warning + current model
- Model switching per session (provider + model pickers, model lock)
- **Health polling:** `/health` is checked every 30s; gateway restarts flip
  the connection state automatically, and reconnect refreshes capabilities,
  sync state and history without user action

**Sync flagging**
- The plugin ships a pinned manifest (minimum Hermes version, required
  features, required endpoints) and diffs it against `GET /health` +
  `GET /v1/capabilities` on connect. Verdicts — `ok` / `outdated` / `ahead` —
  are always visible (banner + status bar + toast), so drift is flagged
  instead of silently breaking.

## Architecture & design decisions

```
┌─────────────────────────── VS Code ───────────────────────────┐
│  Webview (chat panel)            Tree view (history)          │
│  src/views/media/chat.ts         src/views/historyProvider.ts │
│        │ postMessage (protocol.ts)                            │
│  Extension host                                                  │
│  src/extension.ts — orchestrator, session + stream state       │
│  src/api/client.ts — HermesClient (fetch + SSE parser)          │
│  src/api/sync.ts   — capability diff engine                     │
└───────────────────────────────┬────────────────────────────────┘
                                │ HTTP (Bearer API_SERVER_KEY)
                    Hermes Gateway — platform api_server (:8642)
                    /api/sessions, /chat[/stream], /v1/runs,
                    /v1/runs/{id}/events|approval|stop,
                    /v1/capabilities, /api/model/options, …
```

- **Transport = the API Server (Surface A), not the TUI WebSocket.** It is
  the surface Hermes intends for external UIs — self-describing via
  `/v1/capabilities`, and a stable contract.
- **Webview panel, not a terminal wrapper.** VS Code's integrated terminal
  can't deliver Shift+Enter (a decade-old upstream limitation), and terminal
  image paste needs protocol hacks. A webview textarea gives multiline
  input, paste/drag-drop and a real command picker natively.
- **Slash commands are implemented client-side.** The API server is
  OpenAI-compatible and does not interpret `/` text (verified against
  0.20.0; only session `/model` overrides exist as an endpoint). The
  catalog maps commands to endpoints and keeps TUI-only commands visible but
  marked. If Hermes later exposes a slash RPC over the API, the catalog's
  `kind` flags switch entries to `action` without UI changes.
- **Images default to file mode.** Text-only main models reject inline
  `image_url` parts with a 400; saving to `$HERMES_HOME/attachments/` and
  referencing the path lets Hermes' vision fallback chain do the analysis,
  and the image persists on disk.
- **Attach = copy + reference, never inline.** `@<path>` is a plain
  reference (the LLM reads the file or folder in place when it wants);
  `@file <path>` — from the picker's attach form, the paperclip button,
  drag & drop, or typed — copies the file into `$HERMES_HOME/attachments/`
  (deterministic `name__<hash>.ext`, so re-sends never duplicate) and the
  token points at the copy. The message stays a path per file, the session
  owns a durable copy, and the LLM decides when to load the content — so
  there are no size limits and no prompt bloat. Content is never inlined.
- **Sync manifest instead of silent drift.** The plugin pins the API surface
  it was built against and diffs the live server's self-description against
  it, so a Hermes upgrade can't break the plugin unnoticed.
- **Zero-config connection.** The API key and base URL are auto-discovered
  (SecretStorage → `VSHERMES_API_KEY` → `$HERMES_HOME/.env`, mirroring
  Hermes' own resolution order); a stale `~/.hermes` can't shadow the live
  config. Fallback: `VSHermes: Set API Key` (stored in SecretStorage, never
  in settings.json).
- **The webview never holds the API key.** All API traffic runs in the
  extension host.
- **The chat window shows the current session's messages only.** The webview
  resets its message list whenever the host's `state` reports a different
  session id — one rule covering `/new`, `/clear`, delete-current and any
  future session switch, instead of per-action clear calls.
- **File-mode images are mapped to webview URIs on render.** The webview
  sandbox can't read `$HERMES_HOME/attachments/` paths directly, so the host
  rewrites stored `[Image pasted: …]` references to `asWebviewUri`-mapped
  markdown images before posting messages.
- **Copy is webview-native.** Copy buttons use `navigator.clipboard` with an
  `execCommand` fallback — copying a message, thinking block, code block or
  tool output never round-trips through the extension host.
- **Activity-bar icon:** VS Code renders container icons as monochrome
  masks tinted by the theme, so the mark must read at 24px with real
  negative space. Note: the container icon is cached client-side keyed to
  the extension install path — any icon change requires a version bump to
  reach the running UI.

## Requirements

- VS Code ≥ 1.85 (same extension API works in Cursor/Windsurf)
- Hermes with the gateway **api_server** platform enabled:

  `.env`:
  ```
  API_SERVER_ENABLED=true
  API_SERVER_KEY=<your-secret-key-min-8-chars>
  API_SERVER_HOST=127.0.0.1
  API_SERVER_PORT=8642
  ```

  then `hermes gateway run` (or `hermes gateway install` for a background
  service). Restart after config changes: `hermes gateway run --replace`.

## Install

**From GitHub Releases:** download `vsh-hermes-<version>.vsix` from the
[latest release](https://github.com/jonmach/VSHermes/releases/latest), then
Extensions → Install from VSIX.

**From the Marketplace** (extension ID `synapticity.vsh-hermes`):
search "VSHermes" in the Extensions view.

First launch: the API key is auto-discovered from the Hermes `.env` (see
Requirements); only prompted for if none is found anywhere. **Clients
connecting to a remote server need that server's `API_SERVER_KEY` value —
the same string from its `.env` — stored for the profile (Endpoints →
Save key); remote connections without a key are refused.**

## Build & install from source (development)

```bash
npm install
npm run compile          # tsc + esbuild → dist/extension.js + dist/media/chat.js
npm test                 # unit + contract-mock tests (no gateway needed)
npm run test:live        # live integration against a real API server
                         # (key auto-read from $HERMES_HOME/.env)
```

Package and install into a remote/dev-container extension host (no F5 —
there is no desktop GUI in this environment):

```bash
npx @vscode/vsce package          # dist/vsh-hermes-<version>.vsix
code --install-extension dist/vsh-hermes-<version>.vsix --force
# then: Command Palette → Developer: Reload Window
```

Settings: `vsh.hermes.baseUrl` (default `http://127.0.0.1:8642`),
`vsh.hermes.endpoints`, `vsh.hermes.activeEndpoint`,
`vsh.hermes.checkSyncOnStartup`, `vsh.hermes.maxImageBytes`,
`vsh.hermes.maxImageDimension`, `vsh.hermes.imageTransfer`.

## Sync verdicts

| Verdict  | Meaning                                                               | Action                                        |
| -------- | --------------------------------------------------------------------- | --------------------------------------------- |
| ok       | aligned with the verified surface                                     | —                                             |
| outdated | Hermes missing a required feature/endpoint, or older than the minimum | upgrade Hermes (or install an older VSHermes) |
| ahead    | Hermes advertises features the plugin doesn't know                    | informational — plugin still works            |
| unknown  | server unreachable / bad key                                          | fix connection                                |

Re-check anytime via the header icon, the `VSHermes: Check Hermes Sync`
command, or `npm run check-sync` (standalone script).

## Roadmap

- Diff/checkpoint review for file changes (Hermes `checkpoints` integration)
- AGENTS.md context injection per workspace
- Runs/SSE activity feed for standalone `/v1/runs` submissions
- Webview terminal output rendering for tool results

## License

MIT
