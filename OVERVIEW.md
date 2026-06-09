# SE Notebook — Executive Summary

A self-hosted **technical fieldbook for presales / solutions engineering**. It centralizes
everything an SE tracks across a deal — accounts, meeting notes, call transcripts, contacts,
proof-of-value (POV) documents, and timelines — and layers AI on top to turn raw notes into
structured deal intelligence, customer-ready POV documents, and CRM-ready status updates.

It runs entirely on your machine; nothing leaves it except the AI calls you choose to make.

---

## What it can do

### Accounts & pipeline
- Track each account through presales stages (Discovery → Demo → Workshop → Planning →
  Deployment → In Progress → Technical Win/Loss, plus Not Required / Stalled / Canceled),
  with risk, escalation, AE, industry, opportunity value, and close date.
- **Custom, searchable tags** (e.g. "renewal only") — an "inactive" tag can drop an account
  out of the dashboard's active views so it stops cluttering current tracking.
- Per-stage **gate checklists** to keep evaluations disciplined.

### Notes, transcripts & AI extraction
- Capture typed notes (Demo, Discovery, Check-in, etc.) and paste/upload call transcripts.
- AI automatically extracts **deal intelligence**, **contacts**, an **account summary**,
  **technical drivers**, and **environment** details from that raw content.

### POV generator (the centerpiece)
- A preflight form captures products, deployment, OS, use cases, technologies, compliance,
  duration, and timeline.
- It retrieves relevant OPSWAT product documentation and generates a **structured, branded
  POV document** (Purpose, Scope, Success Criteria, etc.).
- POVs are **versioned** (v1, v2…). You can reopen the inputs to regenerate a new version,
  regenerate individual sections, keep private SE prep notes, and **export to PDF or branded
  DOCX**.

### POV Library
- Every POV across all accounts as a card grid with a read-only preview drawer, filters
  (product / industry / outcome), win/loss stats, export, and delete.

### POV Calendar
- POV timelines render as bars across their full date range, with scheduled **meeting events**
  (Scoping Call, Kick Off, Check In, Wrap Up) shown by type. Month and list views.

### CRM snapshot
- Generates a ≤255-character, technical-validation-focused status update written for pasting
  straight into the CRM, with a one-click copy button.

### Dashboard
- Active POVs, pipeline value, POVs closing soon, plus a track record (POVs conducted,
  technical wins/losses, demos) and your week ahead.

### Supporting tools
- Global full-text search across everything, an attachment library, AI-drafted kickoff agendas
  and follow-up emails, Microsoft 365 calendar sync, and scheduled local backups.

---

## How it works

| Layer | Technology |
| --- | --- |
| Frontend | React single-page app (Vite + Tailwind) |
| Backend | Node / Express API |
| Data | Local SQLite database (with full-text search) |
| AI | Anthropic **Claude** models |
| POV grounding (RAG) | Local **ChromaDB** vector store of product documentation |
| Deployment | Docker (app + ChromaDB), running locally |

- **AI key stays local.** Your Anthropic API key lives only in your browser and is sent
  directly to Anthropic — the server never stores it. It powers summaries, extraction, CRM
  snapshots, and POV section work.
- **POVs are grounded in real docs.** During generation, a local ChromaDB vector store of
  product documentation is searched so POVs draw on actual OPSWAT material, not just the
  model's memory.
- **Everything is searchable.** SQLite full-text indexing keeps accounts, notes, transcripts,
  contacts, deal fields, files, and tags instantly searchable.
- **It's all local.** Runs as Docker containers on your machine, with your database and
  uploads persisted on disk.

---

**In one line:** your presales command center — notes and calls go in, and structured deal
intelligence, customer-ready POV documents, and CRM updates come out, all kept local and
grounded in real product docs.
