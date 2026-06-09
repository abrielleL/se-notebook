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

> POV **document generation** additionally needs the local embedding server running and a populated ChromaDB (see `scripts/schedule-embed-server.js` and `ingest.js`). Everything else — notes, AI summaries, calendar, exports — works without it.

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
4. Save. Your key lives in `localStorage` and is sent only to `api.anthropic.com` — it never touches this server.

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

## Architecture notes

- **Local-only, single-user.** No app login. As guardrails, CORS is restricted to localhost origins, the containers bind to `127.0.0.1` only, and a Content-Security-Policy + security headers are sent on every response.
- **AI split.** Summaries, CRM snapshots, and section regeneration call `https://api.anthropic.com/v1/messages` **from the browser** (`x-api-key` from localStorage; the `anthropic-dangerous-direct-browser-access: true` header is required because Anthropic blocks browser calls by default). POV **document generation** runs **server-side** (Anthropic + retrieval over a local ChromaDB).
- **Schema lives in `server/db/schema.sql`** (`CREATE TABLE IF NOT EXISTS`-only, safe to re-run); runtime column/table migrations live in `server/db/database.js`.
- **FTS5** virtual table `search_index` covers notes, transcripts, accounts, contacts, deal intelligence, files, and tags — kept in sync via triggers plus a startup backfill. `GET /api/search?q=` returns ranked matches with `<mark>` snippet highlighting.
- **Microsoft Graph token** is persisted in `server/db/token.json` (gitignored). Refresh happens silently via MSAL.

## Project layout

```
se-notebook/
├── client/                  # React + Vite app
│   └── src/
│       ├── components/      # Layout, Card, Icons, StageBadge
│       ├── lib/             # api.js, ai.js, exportPdf.js, stage.js
│       └── pages/           # Dashboard, Accounts, AccountDetail, NewNote, AddNote, Settings, Shortcuts
├── server/                  # Express API
│   ├── db/                  # schema.sql, database.js, se-notebook.db, token.json
│   ├── lib/                 # msGraph.js
│   ├── routes/              # one file per resource
│   └── uploads/             # multer destination for attachments
├── scripts/
│   └── import-onenote.js
└── package.json             # root, runs server+client via concurrently
```

## Troubleshooting

- **`better-sqlite3` install fails** — needs a working C++ toolchain. On macOS, `xcode-select --install`. Then re-run `npm install --prefix server`.
- **`anthropic_api_key` not set banner won't go away** — open Settings, paste a key starting with `sk-ant-`, click Save.
- **Outlook says "not connected"** — make sure `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID` are set in `.env`, restart the app, then click Connect Outlook. After it shows "Outlook connected," close the tab manually and hit Sync.
- **Port 3001 in use** — change `PORT` in `.env` and update the Vite proxy target in `client/vite.config.js`.
