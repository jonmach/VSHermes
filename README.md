# VSHermes

Hermes Agent chat for VS Code — a Claude-Code-style panel over the **Hermes API Server** (Surface A), not a terminal wrapper.

- Multiline input: **Enter** sends, **Shift+Enter** inserts a newline
- **Chat header actions** (icons in the Chat tab's title bar): New Chat, Check Sync, Switch Model, Refresh History — plus the full command palette (VSHermes: …) for every action including Set API Key
- **Paste or drag-drop images** — saved to `$HERMES_HOME/attachments/` and referenced by path (works with text-only models via Hermes' vision fallback chain; `vsh.hermes.imageTransfer` setting)
- **Slash command picker** (`/` in the input) with the catalog implemented client-side over the API surface, honestly marking TUI-only commands as unsupported
- **Session history** tree view: open, continue, fork, delete
- **Live tool activity** — `tool.started` / `tool.progress` / `tool.completed` rendered as cards, thinking rendered in a collapsible block
- **Approval dialogs** for agent commands that require approval (`/v1/runs/{id}/approval`)
- **Stop button** (aborts the stream + `POST /v1/runs/{id}/stop`)
- **Model switching** per session (`POST /api/sessions/{id}/model`)
- **Sync flagging**: the plugin diffs its pinned manifest against `GET /v1/capabilities` + `/health` and warns when it drifts out of sync with the Hermes it's talking to

## Architecture

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

All API traffic runs in the extension host; the webview never sees the API key.

## Requirements

- VS Code ≥ 1.85 (works in Cursor/Windsurf — same extension API)
- Hermes with the gateway **api_server** platform enabled:

  `.env`:
  ```
  API_SERVER_ENABLED=true
  API_SERVER_KEY=<your-secret-key-min-8-chars>
  API_SERVER_HOST=127.0.0.1
  API_SERVER_PORT=8642
  ```
  then `hermes gateway run` (or `hermes gateway install` as a service).

## Install (development)

```bash
npm install
npm run compile          # tsc + esbuild → dist/extension.js, dist/media/chat.js
```

Press **F5** in VS Code (Extension Development Host), or package:

```bash
npm run package          # produces vsh-hermes-0.1.0.vsix
# Install from VSIX: Extensions → … → Install from VSIX…
```

First launch: the extension prompts for the API key (`API_SERVER_KEY`) and stores it in VS Code SecretStorage. Settings: `vsh.hermes.baseUrl` (default `http://127.0.0.1:8642`), `checkSyncOnStartup`, `maxImageBytes`, `maxImageDimension`.

## Sync flagging (out-of-sync detection)

The plugin pins a manifest (`src/api/sync.ts`): minimum Hermes version, required features, required endpoints. On connect it fetches `/health` (version) and `/v1/capabilities` (self-described surface) and diffs:

| Verdict | Meaning | Action |
|---|---|---|
| ok | aligned with the verified surface | — |
| outdated | Hermes missing a required feature/endpoint, or older than the minimum | upgrade Hermes (or install an older VSHermes) |
| ahead | Hermes advertises features the plugin doesn't know | informational — plugin still works |
| unknown | server unreachable / bad key | fix connection |

Shown as a banner in the chat panel + status bar warning; re-checkable via the `VSHermes: Check Hermes Sync` command, the banner button, or `npm run check-sync` from a terminal:

```
node scripts/check-sync.mjs
```

## Slash commands

| Category | Commands | Behaviour |
|---|---|---|
| action | `/new /clear /model /stop /history /sessions /resume /skills /fork /help` | executed client-side against the API (new session, model lock, run stop, …) |
| informational | `/compact /retry /personality /prompt` | sent to Hermes as plain text (the API server does not interpret slash text) |
| unsupported | `/undo /yolo /export /doctor /memory /snapshot /mcp /plugins` | shown with a TUI-only notice; never sent as literal text |

Unknown commands are not sent as text — the picker only offers the catalog.

## Slash command catalogue — why client-side

The API server is OpenAI-compatible and does **not** interpret `/` text (verified against 0.20.0 — session `/model` overrides exist as an endpoint; nothing else). VSHermes therefore maps commands to endpoints and keeps the TUI-only remainder visible but marked. If Hermes later exposes a slash-command RPC over the API, the catalog's `kind` flags switch it to `action` without UI changes.

## Contract verification (diagnosis table)

Every endpoint the plugin uses was probed against the live Hermes **0.20.0** gateway before the client was written:

| Hop | Endpoint | Verified |
|---|---|---|
| 1 | GET /health | ✅ 200 {status, version} |
| 2 | GET /v1/capabilities | ✅ features + endpoints map |
| 3 | GET /api/sessions?limit=&order= | ✅ list + usage fields |
| 4 | POST /api/sessions | ✅ 201; 400 `invalid_title` on duplicates (titles unique) |
| 5 | POST /api/sessions/{id}/chat {message} | ✅ completion + usage + runtime |
| 6 | POST /api/sessions/{id}/chat/stream | ✅ SSE: run.started → message.started → assistant.delta → tool.started → tool.progress (_thinking) → tool.completed → assistant.completed → run.completed → done |
| 7 | GET /api/sessions/{id}/messages | ✅ {data, pagination} |
| 8 | POST /api/sessions/{id}/model | ✅ model_lock accepted |
| 9 | POST /api/sessions/{id}/fork | ✅ 201, auto-suffixed title |
| 10 | POST /v1/runs {model, input} | ✅ 202 {run_id} |
| 11 | GET /v1/runs/{id} | ✅ status |
| 12 | POST /v1/runs/{id}/stop | ✅ |
| 13 | POST /v1/runs/{id}/approval | ✅ endpoint responds; exact event name inferred from `approval_events` capability — **❓** not observed live (this deployment's terminal path did not require approval) |
| 14 | multimodal image parts (data: URLs) | ✅ accepted + routed to vision auxiliary (test image deliberately minimal) |
| 15 | /v1/models, /v1/skills, /v1/toolsets, /api/model/options | ✅ |

## Tests

```bash
npm test                 # unit + contract-mock tests (no gateway needed)
npm run test:live        # live integration against a real API server
                         # (VSHERMES_LIVE=1; key auto-read from $HERMES_HOME/.env)
```

## Roadmap

- Diff/checkpoint review for file changes (Hermes `checkpoints` integration)
- `@file` workspace mentions with AGENTS.md context injection per workspace
- Runs/SSE activity feed for standalone `/v1/runs` submissions
- Webview terminal output rendering for tool results

## License

MIT
