# SE/notebook

A local-first technical fieldbook for solutions engineers. Drop in notes, transcripts, and meetings; Claude auto-extracts summary, technical drivers, environment, and next steps. Everything stays on your machine.

- React + Vite + Tailwind frontend
- Node.js + Express backend
- SQLite via better-sqlite3
- Claude for AI — summaries/snapshots run in the browser; POV generation runs server-side (RAG over a local ChromaDB)
- Microsoft Graph for Outlook/Teams meeting sync
- Runs locally via Docker Compose (app + ChromaDB)

See **[OVERVIEW.md](OVERVIEW.md)** for the full feature list — POV generator & library, calendar, tags, drafts, attachment library, global search, exports, and more.

## Prerequisites

- Node.js 18+ (20+ recommended)
- npm 9+

## Installation

```bash
git clone <this repo>          # or unzip
cd se-notebook
npm run install:all            # installs root, server, client deps
cp .env.example .env           # fill in the Microsoft values if you want calendar sync
```

The first `npm run dev` will create `server/db/se-notebook.db` automatically.

## Running

### Docker (recommended)

The app and its ChromaDB vector store run as containers, both bound to **localhost only**:

```bash
cp .env.example .env            # optional: fill in Microsoft values for calendar sync
docker compose up -d --build
```

Open **http://localhost:3001**. After changing code, re-run `docker compose up -d --build` to rebuild and restart.

> POV **document generation** additionally needs the local embedding server running and a populated ChromaDB — see [Enabling POV document generation](#enabling-pov-document-generation-retrieval-setup). Everything else — notes, AI summaries, calendar, exports — works without it.

The non-Docker options below are for hacking on the app or running it as a native macOS service.

### Always-on (macOS LaunchAgent)

Installs a macOS LaunchAgent that starts the app at login, restarts it if it crashes, and serves the prebuilt React app from a single Express process on port **3001**:

```bash
npm run build              # produces client/dist
npm run service:install    # writes ~/Library/LaunchAgents/com.senotebook.plist and starts it
```

Then bookmark **http://localhost:3001** and forget it exists.

Service commands:

| Command | What it does |
|---|---|
| `npm run service:install` | Write the plist and load+start the service |
| `npm run service:start` | Start (if loaded) |
| `npm run service:stop` | Stop |
| `npm run service:restart` | Stop + start |
| `npm run service:status` | Show launchd state and recent exits |
| `npm run service:logs` | Tail stdout/stderr (`server/logs/`) |
| `npm run service:uninstall` | Stop and remove the plist |

After editing code, `npm run build && npm run service:restart` picks up the new client; for server changes, just restart.

### Dev mode (for hacking on the app)

```bash
npm run dev
```

Express on `:3001`, Vite on `:5173` (with HMR), proxying `/api/*` between them. Open **http://localhost:5173**. Stop the service first (`npm run service:stop`) so it doesn't fight for port 3001.

## First run

1. Open the app
2. Click the gear (Settings) in the sidebar
3. Paste your Anthropic API key (get one at https://console.anthropic.com)
4. Save, then create your first account and add a note — AI extraction runs automatically on save.

**Where your key goes.** It's stored in the browser's `localStorage` — never written to
this repo, the database, or a config file. Browser-side features (summary, CRM snapshot,
section regeneration) send it straight to `api.anthropic.com`. POV **document generation**
runs server-side, so for those requests the browser forwards the key to the local server in
an `x-anthropic-key` header; the server uses it for that one call and never persists it.

## Daily use, in the order you'd actually use it

1. **Create an account** (Accounts → New) and set its presales stage.
2. **Add notes as you go** — typed notes, or drop a call transcript (`.docx`/`.txt`) on the
   Transcripts drop zone. Every save triggers AI extraction, which fills in the account
   summary, technical drivers, environment, contacts, and next steps.
3. **Grab a CRM update** from the account page when you need to paste status into the CRM.
4. **Generate a POV** once the deal is far enough along: open the account → POV → fill the
   preflight form → generate. Requires the retrieval setup below.
5. **Export** to PDF or branded DOCX from the account or the POV Library.

`?` anywhere in the app lists the keyboard shortcuts.

## Enabling POV document generation (retrieval setup)

Everything above works out of the box. POV generation additionally needs product docs
embedded into ChromaDB, plus a host-side embedding server the container can reach. One-time
setup:

```bash
# 1. ChromaDB is already running if you used Docker Compose. Confirm it:
curl -s localhost:8000/api/v2/heartbeat     # -> {"nanosecond heartbeat":...}

# 2. Point the ingest script at your product-docs folder and load it.
#    Default is a sibling `se-knowledge/` directory next to this project.
export SE_KNOWLEDGE_DIR=/path/to/se-knowledge
node ingest.js --dry-run     # estimate chunks first
node ingest.js               # embed (skips files already embedded)

# 3. Start the embedding server on the host — NOT in Docker. The container
#    reaches it at host.docker.internal:8001.
node embed-server.js                          # foreground, for a quick test
node scripts/schedule-embed-server.js         # or install it as a login service
node scripts/schedule-embed-server.js --status   # check / --remove to uninstall
```

The docs corpus is deliberately **not** in this repo — it isn't ours to redistribute.
Point `SE_KNOWLEDGE_DIR` at your own copy.

Check it worked: the server logs `[embed] ✓ Embed server reachable` on startup. If you see
`✗ Embed server NOT reachable`, the host process isn't running and POV generation will fail
while every other feature keeps working.

Useful `ingest.js` flags: `--force-full` (re-embed everything), `--changed-only` (only files
from the last sync report), `--product=mdcore` (one product folder).

## Connecting Outlook (optional but recommended)

1. Go to **https://portal.azure.com → App registrations → New registration**
2. Set redirect URI (Web): `http://localhost:3001/api/auth/microsoft/callback`
3. Under **API permissions**, add **Microsoft Graph → Delegated → Calendars.Read** (and grant admin consent if needed)
4. Under **Certificates & secrets**, create a client secret — copy the Value immediately
5. Copy the Application (client) ID and Directory (tenant) ID
6. Drop them into `.env`:

```
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT_ID=...
MICROSOFT_REDIRECT_URI=http://localhost:3001/api/auth/microsoft/callback
```

7. Restart `npm run dev`
8. On any account, click **Connect Outlook** in the Meetings card. After consent, hit **Sync** to pull calendar events whose subject or attendees match the account name (90 days back, 30 days forward).

## Importing Clari Copilot transcripts

1. In Clari Copilot, export the call as **Word (.docx)** or **plain text (.txt)**
2. Open the account in SE/notebook
3. Drop the file onto the **Transcripts** drop zone, or click **paste transcript text** to paste raw
4. AI extraction runs automatically once the transcript is saved

## Importing existing OneNote pages

1. On Mac OneNote: open the page → **File → Export → Word (.docx)** (or save as `.html`). Do this for each page or section.
2. Put all exports in one folder (subfolders OK)
3. From the project root:

```bash
node scripts/import-onenote.js /path/to/exported-folder
```

The filename becomes the account name. The script detects a date in the content (falls back to today), and stores the full text in the running note log. Run AI Extract on each account after import to populate summary/drivers/environment/next-steps.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus global search |
| `N` | New Note |
| `Q` | Quick capture |
| `S` (or ⌘/Ctrl+S) | Save current form |
| `?` | Shortcuts page |

## Your data, and what must never be committed

Your notes are **customer data**. They live only on your machine, and the repo is set up to
keep them there — but if you contribute back, know what the boundary is.

| Stays local (gitignored) | Where |
|---|---|
| The database — accounts, notes, transcripts, contacts, POVs | `server/db/se-notebook.db` (+ `-wal`/`-shm`) |
| Nightly database snapshots | `backups/` |
| Uploaded attachments | `server/uploads/` |
| Anthropic API key | browser `localStorage` only — never on disk in this repo |
| Microsoft Graph OAuth tokens | `server/db/token.json` |
| Microsoft app credentials | `.env` (only `.env.example` is committed) |
| Exported POV documents | any `*.docx` except `pov-template.docx` |
| Per-machine tooling state | `.claude/settings.local.json`, `hydrate.progress`, `__pycache__/` |

Before pushing, confirm you're not about to commit any of it:

```bash
git status --short                     # nothing from the table above should appear
git diff --cached --stat               # review what's actually staged
```

The committed `pov-template.docx` and `unpacked-template/` are the **blank** branded
template — no customer content. If you ever regenerate the template from a real POV,
scrub it before committing.

## Architecture notes

- **Local-only, single-user.** No app login. As guardrails, CORS is restricted to localhost origins, the containers bind to `127.0.0.1` only, and a Content-Security-Policy + security headers are sent on every response.
- **AI split.** Summaries, CRM snapshots, and section regeneration call `https://api.anthropic.com/v1/messages` **from the browser** (`x-api-key` from localStorage; the `anthropic-dangerous-direct-browser-access: true` header is required because Anthropic blocks browser calls by default). POV **document generation** runs **server-side** (Anthropic + retrieval over a local ChromaDB); the browser forwards the same key per-request in an `x-anthropic-key` header, used transiently and never stored. An `ANTHROPIC_API_KEY` env var is honored as a fallback for headless use.
- **Schema lives in `server/db/schema.sql`** (`CREATE TABLE IF NOT EXISTS`-only, safe to re-run); runtime column/table migrations live in `server/db/database.js`.
- **FTS5** virtual table `search_index` covers notes, transcripts, accounts, contacts, deal intelligence, files, and tags — kept in sync via triggers plus a startup backfill. `GET /api/search?q=` returns ranked matches with `<mark>` snippet highlighting.
- **Microsoft Graph token** is persisted in `server/db/token.json` (gitignored). Refresh happens silently via MSAL.

## Project layout

```
se-notebook/
├── client/                       # React + Vite app (built into the image — rebuild to deploy)
│   └── src/
│       ├── components/           # Layout, Markdown, Drawer/Modal, GlobalSearch, QuickCapture, export modals
│       ├── lib/                  # api.js, ai.js (browser-side Claude), povJob.js, exportPdf.js, stages.js
│       └── pages/                # Dashboard, Accounts, AccountDetail, PovGenerator, PovLibrary,
│                                 #   CalendarPage, FileLibrary, StatsPage, Drafts, Settings, Shortcuts
├── server/                       # Express API — also serves client/dist in production
│   ├── index.js                  # entry: CORS + CSP, route mounting, embed-server health check
│   ├── db/                       # schema.sql, database.js (runtime migrations), se-notebook.db*, token.json*
│   ├── lib/                      # anthropic.js (server-side Claude), chroma.js, embed.js, msGraph.js, stages.js
│   ├── routes/                   # one file per resource (accounts, notes, pov, export, search, …)
│   └── uploads/*                 # multer destination for attachments
├── scripts/
│   ├── import-onenote.js         # bulk-import exported OneNote pages
│   ├── backup-db.js              # nightly snapshot into backups/ (keeps 30)
│   ├── schedule-backup.js        # install backup as a LaunchAgent
│   ├── schedule-embed-server.js  # install embed-server.js as a LaunchAgent
│   └── service.sh                # install/start/stop the app LaunchAgent
├── ingest.js                     # embed product docs into ChromaDB (host-side)
├── embed-server.js               # query-embedding service on :8001 (host-side, NOT in Docker)
├── pov-template.docx             # blank branded POV template
├── docx-scripts/, unpacked-template/   # DOCX generation helpers + unpacked template parts
├── docker-compose.yml            # se-notebook :3001 + chromadb :8000, both localhost-only
└── package.json                  # root: runs server+client via concurrently

* = gitignored (contains your data or credentials)
```

## Troubleshooting

- **`better-sqlite3` install fails** — needs a working C++ toolchain. On macOS, `xcode-select --install`. Then re-run `npm install --prefix server`.
- **`anthropic_api_key` not set banner won't go away** — open Settings, paste a key starting with `sk-ant-`, click Save.
- **Outlook says "not connected"** — make sure `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID` are set in `.env`, restart the app, then click Connect Outlook. After it shows "Outlook connected," close the tab manually and hit Sync.
- **Port 3001 in use** — change `PORT` in `.env` and update the Vite proxy target in `client/vite.config.js`.
- **POV generation fails but everything else works** — the host embed server isn't running. Check the app log for `[embed] ✗ Embed server NOT reachable`, then `node embed-server.js` (or `node scripts/schedule-embed-server.js --status`). See [Enabling POV document generation](#enabling-pov-document-generation-retrieval-setup).
- **POV generation returns thin / irrelevant content** — ChromaDB has no embedded docs. Run `node ingest.js --dry-run` to check the corpus is found, then `node ingest.js`. Confirm Chroma is up with `curl -s localhost:8000/api/v2/heartbeat`.
- **Code changes don't show up in the running app** — the client is baked into the Docker image at build time. Re-run `docker compose up -d --build se-notebook`, then hard-refresh (⌘⇧R) to clear the cached JS bundle.
