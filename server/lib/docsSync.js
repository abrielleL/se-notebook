// ============================================================
// docsSync.js — Refresh the opswat_docs collection from docs-rag.
//
// docs-rag (on the lab box) scrapes docs.opswat.com weekly, keeps only
// current product versions, and emits 384-dim all-MiniLM vectors — the same
// dimensionality this collection uses. So a sync copies finished vectors
// rather than re-embedding 34k chunks locally.
//
// This module is the single implementation. The server calls it for the
// on-demand button; scripts/sync-docs-rag.js calls it for the scheduled run.
// The two differ only in how they reach ChromaDB (service name inside Docker,
// localhost from the host), which is why the URLs are arguments.
// ============================================================

const { ChromaClient } = require('chromadb');
const db = require('../db/database');

const STATE_KEY = 'docs_sync_state';
const LIVE      = 'opswat_docs';
const STAGING   = 'opswat_docs_staging';
const BATCH     = 500;

const DEFAULT_DOCS_RAG = process.env.DOCS_RAG_URL || 'http://192.168.100.61:8080';

// One sync at a time, process-wide. Two concurrent runs would race on the
// staging collection and could delete the live one out from under each other.
let running = false;

function readState() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(STATE_KEY);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function writeState(state) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(STATE_KEY, JSON.stringify(state));
}

// NDJSON: one JSON object per line, streamed. Parsing line by line keeps peak
// memory at one batch instead of the ~90 MB whole body.
async function* readNdjson(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim());
}

/** Reachability + freshness of the upstream corpus. Never throws. */
async function sourceStatus(docsRagUrl = DEFAULT_DOCS_RAG) {
  const out = { url: docsRagUrl, reachable: false };
  try {
    const [exp, stats] = await Promise.all([
      fetch(`${docsRagUrl}/export/status`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${docsRagUrl}/stats`, { signal: AbortSignal.timeout(8000) })
    ]);
    if (!exp.ok) throw new Error(`/export/status HTTP ${exp.status}`);
    const e = await exp.json();
    out.reachable = true;
    out.exportable = e.exportable;
    out.missing_vectors = e.missing_vectors;
    out.ready = e.ready;
    if (stats.ok) {
      const s = await stats.json();
      out.corpus_last_fetch = s.totals?.last_fetch || null;
      out.documents = s.totals?.documents ?? null;
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

async function status(docsRagUrl) {
  return { running, local: readState(), source: await sourceStatus(docsRagUrl) };
}

/**
 * Full refresh. Resolves with a summary; rejects on any condition that would
 * leave the collection worse than it was.
 */
async function run({ chromaUrl, docsRagUrl = DEFAULT_DOCS_RAG, product = null, onProgress } = {}) {
  if (running) throw new Error('a sync is already running');
  running = true;
  const started = new Date().toISOString();
  const note = (m) => { if (onProgress) onProgress(m); };

  try {
    const src = await sourceStatus(docsRagUrl);
    if (!src.reachable) throw new Error(`cannot reach docs-rag at ${docsRagUrl}: ${src.error}`);
    // A partial export would silently shrink the collection.
    if (!src.ready) {
      throw new Error(`docs-rag export is not ready — ${src.missing_vectors} chunk(s) ` +
                      `still awaiting vectors. Let its embedding pass finish.`);
    }

    const client = new ChromaClient({ path: chromaUrl });
    await client.heartbeat();

    // Never resume into staging left behind by a failed run.
    try { await client.deleteCollection({ name: STAGING }); } catch { /* absent */ }

    const url = new URL(`${docsRagUrl}/export`);
    if (product) url.searchParams.set('product', product);
    note(`fetching ${url}`);

    const res = await fetch(url, { signal: AbortSignal.timeout(900000) });
    if (!res.ok) throw new Error(`/export returned HTTP ${res.status}`);

    const staging = await client.createCollection({ name: STAGING });
    let batch = [], total = 0;
    const dims = new Set(), products = new Set();

    const flush = async () => {
      if (!batch.length) return;
      await staging.add({
        ids:        batch.map(r => String(r.id)),
        embeddings: batch.map(r => r.embedding),
        metadatas:  batch.map(r => r.metadata),
        documents:  batch.map(r => r.document)
      });
      total += batch.length;
      if (total % 5000 < BATCH) note(`${total.toLocaleString()} chunk(s)`);
      batch = [];
    };

    for await (const row of readNdjson(res)) {
      dims.add(row.embedding.length);
      if (row.metadata?.product) products.add(row.metadata.product);
      batch.push(row);
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    if (dims.size !== 1) throw new Error(`mixed embedding dimensions: ${[...dims]}`);
    const dim = [...dims][0];
    if (dim !== 384) throw new Error(`export is ${dim}-dimensional; this collection is 384`);
    // A truncated stream would otherwise look like a successful refresh.
    if (!product && total < src.exportable * 0.95) {
      throw new Error(`only ${total} of ${src.exportable} chunk(s) arrived; refusing to swap`);
    }

    // Swap. The gap where neither collection is named opswat_docs is a single
    // rename, so a POV generated mid-sync sees the old corpus or the new one.
    try { await client.deleteCollection({ name: LIVE }); } catch { /* first run */ }
    await staging.modify({ name: LIVE });

    const summary = {
      ok: true, started_at: started, finished_at: new Date().toISOString(),
      chunks: total, products: products.size, dim,
      product: product || null, source_url: docsRagUrl,
      corpus_last_fetch: src.corpus_last_fetch || null, error: null
    };
    writeState(summary);
    note(`done — ${total.toLocaleString()} chunk(s)`);
    return summary;
  } catch (err) {
    // Recorded so the UI can show a failed attempt rather than an unchanged
    // "last synced" timestamp that implies nothing went wrong.
    const prev = readState() || {};
    writeState({
      ...prev, ok: false, started_at: started,
      finished_at: new Date().toISOString(), error: err.message
    });
    throw err;
  } finally {
    running = false;
    try { const c = new ChromaClient({ path: chromaUrl }); await c.deleteCollection({ name: STAGING }); }
    catch { /* already swapped or never created */ }
  }
}

module.exports = { run, status, sourceStatus, readState, STATE_KEY, LIVE };
