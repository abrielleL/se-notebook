// ============================================================
// sync-docs-rag.js — Refresh the opswat_docs ChromaDB collection from
// docs-rag. Thin CLI wrapper; the implementation lives in
// server/lib/docsSync.js so the scheduled run and the Settings button
// cannot drift apart.
//
// Usage:
//   node scripts/sync-docs-rag.js
//   node scripts/sync-docs-rag.js --product mdcore
//
// Env:
//   DOCS_RAG_URL  default http://192.168.100.61:8080
//   CHROMA_URL    default http://localhost:8000   (the server uses
//                 http://chromadb:8000 from inside Docker)
// ============================================================

const docsSync = require('../server/lib/docsSync');

const args    = process.argv.slice(2);
const prodIdx = args.indexOf('--product');
const product = prodIdx !== -1 ? args[prodIdx + 1] : null;

docsSync.run({
  chromaUrl: process.env.CHROMA_URL || 'http://localhost:8000',
  docsRagUrl: process.env.DOCS_RAG_URL,
  product,
  onProgress: (m) => console.log(`[sync] ${m}`)
}).then(s => {
  console.log(`[sync] ok — ${s.chunks.toLocaleString()} chunk(s), ${s.products} product(s)`);
}).catch(e => {
  console.error(`[sync] ERROR: ${e.message}`);
  process.exit(1);
});
