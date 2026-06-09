# Changelog

All notable changes to SE/notebook. Dates are YYYY-MM-DD.

## 2026-06-08

### Added
- **Global search** — full-text search across accounts, notes, transcripts, contacts, deal intelligence, files, and tags, with a live results dropdown.
- **Accounts-by-stage dashboard** — a board with one column per presales stage (counts on top); replaces the old metrics dashboard.
- **Account tags** — a managed, color-coded tag catalog (Settings); searchable and filterable, with an "inactive" tag that drops accounts from the dashboard's active views.
- **Attachment Library** — a sidebar view of every file across all accounts.
- **Drafts** — unsaved New Note / Quick Capture entries autosave to a Drafts area you can resume or discard.
- **POV versioning** — POVs are numbered per account (v1, v2…), with a preview drawer, "edit inputs" (reopen the preflight form), and delete from both the account page and POV Library.
- **POV calendar meetings** — schedule Scoping Call / Kick Off / Check In / Wrap Up events on a POV; shown by type on the calendar (month + list views).
- **Transcript drop on New Note** — attach a transcript file while creating a note.
- `OVERVIEW.md` executive summary.

### Changed
- **Exports split** — the account Export is a selectable, full-account export (notes, contacts, qualification, etc.); the POV Export is a fixed two-button (PDF/DOCX) POV-document export, scoped to the specific POV.
- **CRM snapshot** rewritten to focus on technical-validation status + next step, ≤255 chars ending on a complete sentence, with a copy button.
- Note entry simplified — removed the prefilled template and the note-type/category picker.

### Security
- CORS restricted to localhost origins; app and ChromaDB bound to `127.0.0.1` only.
- Content-Security-Policy and security headers (`X-Content-Type-Options`, `Referrer-Policy`) on every response.
- Fixed a stored-XSS vector in the search dropdown; SVG uploads now download as attachments instead of rendering inline.
- Upload path-traversal guard (account id must be a UUID).
- Removed customer/private content (notes, SE prep notes, request bodies) from server logs.
- Hardened `.gitignore` so the database, backups, `.env`, and exported customer docs are never committed.

### Fixed
- Win/loss casing mismatch that broke the POV Library outcome filter and win-rate.
- POV documents now load on first click (no refresh needed).
- Deleting a POV also removes its scheduled meetings.
