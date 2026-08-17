# SE Notebook — Project Guide

Presales SE notebook: a React (Vite) client + Node server, backed by SQLite and ChromaDB, with Claude-powered summaries/POV generation. Runs in Docker.

## Architecture at a glance
- **client/** — React + Vite + Tailwind. Built to `client/dist` and served statically by the server.
- **server/** — Node/Express. Serves the client, the API, SQLite (`server/db`), and uploads (`server/uploads`). Entry: `server/index.js`.
- **chromadb** — vector store for retrieval/ingest, on `127.0.0.1:8000`.
- Anthropic/Claude calls live in `server/lib/anthropic.js` and `client/src/lib/ai.js`.

## Running the app
The deployed instance is the **Docker container**, not `npm run dev`.
- **Local live-reload dev:** `npm run dev` (Vite + server via concurrently).
- **Deployed:** `docker compose up -d` — `se-notebook` serves on `127.0.0.1:3001`, `chromadb` on `127.0.0.1:8000`.

### ⚠️ The client is baked into the image at build time
`Dockerfile` runs `npm run build --prefix client` → `client/dist`, and there is **no source volume mount** (only `server/db` and `server/uploads` are mounted). So **editing `client/src/**` or server source does nothing to the running app until you rebuild.**

## Release checklist — run this every time a change is "done"
1. **Build check:** `npm run build --prefix client` (catch compile errors first).
2. **Rebuild + restart:** `docker compose up -d --build se-notebook`. Verify: `docker ps` shows fresh "Up …", and `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001` → `200`. Leave `chromadb` alone.
3. Tell the user to **hard-refresh** (Cmd+Shift+R) to clear the cached JS bundle.
4. **Commit** to `main` with a conventional-commit message.
5. **Push** to `origin/main`.

## Conventions
- **Never** put the term "MEDDPICC" in any user-visible text.
- **AI-output display:** render markdown via `client/src/components/Markdown.jsx` (dependency-free, XSS-safe). Use `stripMarkdown()` for line-clamped previews. Don't render raw markdown symbols to users. Editors (textareas), diff views, export previews, FTS search highlighting, and user-typed notes stay raw.
