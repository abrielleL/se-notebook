// ============================================================
// sync-docs-rag.js — Refresh the opswat_docs ChromaDB collection from the
// docs-rag service on the lab box.
//
// Usage:
//   node scripts/sync-docs-rag.js            <- full refresh
//   node scripts/sync-docs-rag.js --dry-run  <- fetch and count, write nothing
//   node scripts/sync-docs-rag.js --product mdcore
//
// Env:
//   DOCS_RAG_URL  default http://192.168.100.61:8080
//   CHROMA_URL    default http://localhost:8000
//
// Why this exists
//   The collection used to be built by ingest.js, which embedded a local
//   docs/ tree with Xenova/all-MiniLM-L6-v2 on this machine. docs-rag now
//   scrapes weekly, tracks per-product coverage, and keeps only current
//   product versions — and it emits 384-dimensional all-MiniLM vectors, the
//   same dimensionality this collection already uses. So this pulls finished
//   vectors instead of recomputing 34k embeddings on a laptop.
//
//   Documents are replaced wholesale rather than upserted. An upsert leaves
//   behind anything the source has since dropped — and the source *did* just
//   drop 477 superseded version-tree pages, which are exactly the documents
//   a POV must not cite. Loading into a staging collection and swapping at
//   the end means a failed or interrupted sync leaves the live collection
//   untouched rather than half-rebuilt.
// ============================================================

const { ChromaClient } = require('chromadb');

const DOCS_RAG_URL = process.env.DOCS_RAG_URL || 'http://192.168.100.61:8080';
const CHROMA_URL   = process.env.CHROMA_URL   || 'http://localhost:8000';
const LIVE    = 'opswat_docs';
const STAGING = 'opswat_docs_staging';
const BATCH   = 500;

const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const prodIdx = args.indexOf('--product');
const product = prodIdx !== -1 ? args[prodIdx + 1] : null;

function log(msg) { console.log(`[sync] ${msg}`); }
function fail(msg) { console.error(`[sync] ERROR: ${msg}`); process.exit(1); }

async function preflight() {
  let res;
  try {
    res = await fetch(`${DOCS_RAG_URL}/export/status`, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    fail(`cannot reach docs-rag at ${DOCS_RAG_URL} (${e.message}). Is the lab box up?`);
  }
  if (!res.ok) fail(`/export/status returned HTTP ${res.status}`);
  const s = await res.json();
  log(`docs-rag: ${s.exportable.toLocaleString()} chunk(s) exportable, ` +
      `${s.missing_vectors.toLocaleString()} still awaiting vectors`);
  // A partial export would silently shrink the collection, so refuse it
  // rather than swap in an incomplete corpus.
  if (!s.ready) {
    fail(`export is not ready — ${s.missing_vectors} chunk(s) have no vector yet. ` +
         `Let the scraper finish its embedding pass and re-run.`);
  }
  return s;
}

// The export is NDJSON: one JSON object per line, streamed. Parsing line by
// line keeps peak memory at one batch rather than the ~90 MB whole body.
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

async function main() {
  const status = await preflight();

  const client = new ChromaClient({ path: CHROMA_URL });
  try {
    await client.heartbeat();
  } catch (e) {
    fail(`cannot reach ChromaDB at ${CHROMA_URL} (${e.message}). Is the container up?`);
  }

  // Never resume into a staging collection left by a previous failed run.
  try { await client.deleteCollection({ name: STAGING }); } catch { /* absent */ }

  const url = new URL(`${DOCS_RAG_URL}/export`);
  if (product) url.searchParams.set('product', product);
  log(`fetching ${url}`);

  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) fail(`/export returned HTTP ${res.status}`);

  const staging = dryRun ? null : await client.createCollection({ name: STAGING });

  let batch = [];
  let total = 0, dims = new Set(), products = new Set();

  const flush = async () => {
    if (!batch.length) return;
    if (!dryRun) {
      await staging.add({
        ids:        batch.map(r => String(r.id)),
        embeddings: batch.map(r => r.embedding),
        metadatas:  batch.map(r => r.metadata),
        documents:  batch.map(r => r.document),
      });
    }
    total += batch.length;
    if (total % 5000 < BATCH) log(`  ${total.toLocaleString()} chunk(s)`);
    batch = [];
  };

  for await (const row of readNdjson(res)) {
    dims.add(row.embedding.length);
    if (row.metadata?.product) products.add(row.metadata.product);
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  if (dims.size !== 1) fail(`mixed embedding dimensions in the export: ${[...dims]}`);
  const dim = [...dims][0];
  if (dim !== 384) fail(`export is ${dim}-dimensional; this collection is 384`);

  log(`received ${total.toLocaleString()} chunk(s), ${dim}-dim, ${products.size} product(s)`);

  // Guard against swapping in a corpus that is implausibly smaller than the
  // one it replaces — a truncated stream would otherwise look like success.
  if (!product && total < status.exportable * 0.95) {
    fail(`only ${total} of ${status.exportable} chunk(s) arrived; refusing to swap`);
  }

  if (dryRun) {
    log('dry run — nothing written');
    try { await client.deleteCollection({ name: STAGING }); } catch { /* none */ }
    return;
  }

  // Swap. The window where neither collection is named opswat_docs is a
  // single rename, so a POV generated mid-sync sees the old corpus or the
  // new one, not an empty one.
  try { await client.deleteCollection({ name: LIVE }); } catch { /* first run */ }
  await staging.modify({ name: LIVE });

  const live = await client.getCollection({ name: LIVE });
  log(`done — ${LIVE} now holds ${(await live.count()).toLocaleString()} chunk(s)`);
}

main().catch(e => fail(e.stack || e.message));
