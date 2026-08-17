#!/usr/bin/env node
/**
 * OPSWAT docs -> ChromaDB ingest (runs on the HOST, outside Docker).
 *
 * Usage:
 *   node ingest.js                  <- full ingest (skips already-embedded files)
 *   node ingest.js --force-full     <- re-embed everything
 *   node ingest.js --changed-only   <- only files from the last sync reports
 *   node ingest.js --product=mdcore <- only one product folder
 *   node ingest.js --dry-run        <- estimate chunks only, no writes
 *
 * Requires (installed in the project root):
 *   @xenova/transformers@2.17.2   (import ONLY as: const { pipeline } = require('@xenova/transformers'))
 *   chromadb
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('@xenova/transformers');
const { ChromaClient } = require('chromadb');

// ---- settings ----
// The product-docs corpus lives OUTSIDE this repo (it isn't ours to ship). Point
// SE_KNOWLEDGE_DIR at your own checkout; the default is a sibling `se-knowledge`
// folder next to this project.
const KNOWLEDGE_DIR = process.env.SE_KNOWLEDGE_DIR
  || path.resolve(__dirname, '..', 'se-knowledge');
const DOCS_DIR = path.join(KNOWLEDGE_DIR, 'docs');
const MANIFEST_PATH = path.join(KNOWLEDGE_DIR, 'manifest.json');
const SYNC_REPORT_PATH = path.join(KNOWLEDGE_DIR, 'sync-report.json');
const SYNC_PDFS_REPORT_PATH = path.join(KNOWLEDGE_DIR, 'sync-pdfs-report.json');
const CHROMA_URL = 'http://localhost:8000';
const COLLECTION_NAME = 'opswat_docs';
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const CHUNK_SIZE = 500;      // tokens
const BATCH_SIZE = 50;
const CHARS_PER_TOKEN = 4;   // 1 token ~= 4 chars
const MAX_CHARS = CHUNK_SIZE * CHARS_PER_TOKEN;

// ---- flags ----
const args = process.argv.slice(2);
const flags = {
  changedOnly: args.includes('--changed-only'),
  dryRun: args.includes('--dry-run'),
  forceFull: args.includes('--force-full'),
  product: (args.find(a => a.startsWith('--product=')) || '').split('=')[1] || null
};

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

// Normalize a sync-report entry into a relative path string.
function toRelPath(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return entry.path || entry.file || entry.relPath || entry.rel || null;
  return null;
}

// ---- chunking ----
function splitByParagraph(text, maxChars) {
  const paras = text.split(/\n\n+/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    const candidate = cur ? `${cur}\n\n${p}` : p;
    if (candidate.length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = p;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

// Split a .md document by `## ` headings first, then by paragraph if a
// section still exceeds CHUNK_SIZE tokens.
function chunkMarkdown(content) {
  const lines = content.split('\n');
  const sections = [];
  let heading = '';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) { flush(); heading = m[1].trim(); }
    else buf.push(line);
  }
  flush();

  const out = [];
  for (const s of sections) {
    if (s.text.length > MAX_CHARS) {
      for (const part of splitByParagraph(s.text, MAX_CHARS)) out.push({ heading: s.heading, text: part });
    } else {
      out.push({ heading: s.heading, text: s.text });
    }
  }
  return out;
}

function chunkId(relPath, idx) {
  return `${relPath.replace(/[/.\-]/g, '_')}_${idx}`;
}

// ---- select files ----
function selectFiles(manifest) {
  const files = manifest.files || {};
  const allMd = Object.keys(files).filter(k => k.toLowerCase().endsWith('.md'));

  let candidates;
  if (flags.changedOnly) {
    const syncReport = readJsonSafe(SYNC_REPORT_PATH, {});
    const pdfReport = readJsonSafe(SYNC_PDFS_REPORT_PATH, {});
    const changed = (syncReport.changed_files || []).map(toRelPath);
    const added = (pdfReport.new_files || []).map(toRelPath);
    const set = new Set([...changed, ...added].filter(Boolean));
    candidates = allMd.filter(k => set.has(k));
  } else {
    candidates = allMd.slice();
  }

  if (flags.product) {
    const p = flags.product;
    candidates = candidates.filter(k => (files[k].product === p) || k.startsWith(`${p}/`));
  }

  // Plain full/product runs skip files already embedded; --force-full and
  // --changed-only always (re)process their candidates.
  if (!flags.forceFull && !flags.changedOnly) {
    candidates = candidates.filter(k => files[k].chroma_embedded !== true);
  }

  return candidates;
}

async function main() {
  const started = Date.now();
  const manifest = readJsonSafe(MANIFEST_PATH, null);
  if (!manifest || !manifest.files) {
    console.error(`Could not read manifest at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const fileKeys = selectFiles(manifest);
  console.log(`Mode: ${flags.forceFull ? 'force-full' : flags.changedOnly ? 'changed-only' : 'full'}` +
    `${flags.product ? ` | product=${flags.product}` : ''}${flags.dryRun ? ' | dry-run' : ''}`);
  console.log(`Files selected: ${fileKeys.length}`);

  // Build all chunks (with metadata) up front.
  const chunks = [];
  const processedFiles = [];
  for (const rel of fileKeys) {
    const abs = path.join(DOCS_DIR, rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); }
    catch { continue; } // file in manifest but missing on disk
    const meta = manifest.files[rel] || {};
    const product = meta.product || rel.split('/')[0];
    const url = meta.url || '';
    const filename = path.basename(rel);

    const parts = chunkMarkdown(content);
    parts.forEach((part, i) => {
      chunks.push({
        id: chunkId(rel, i),
        document: part.heading ? `${part.heading}\n\n${part.text}` : part.text,
        metadata: { product, filename, url, heading: part.heading || '', chunk_index: i }
      });
    });
    processedFiles.push(rel);
  }

  const total = chunks.length;
  console.log(`Chunks to embed: ${total}`);

  if (flags.dryRun) {
    const est = (total / 100).toFixed(1);
    console.log(`[dry-run] Would embed ${total} chunks from ${processedFiles.length} files (~${est} batches). No writes performed.`);
    return;
  }

  if (total === 0) {
    console.log('Nothing to embed.');
    return;
  }

  console.log('Downloading embedding model (first run, ~80MB)...');
  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL);

  const client = new ChromaClient({ path: CHROMA_URL });
  const collection = await client.getOrCreateCollection({ name: COLLECTION_NAME });

  let done = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const embeddings = [];
    for (const c of batch) {
      const output = await extractor(c.document, { pooling: 'mean', normalize: true });
      embeddings.push(Array.from(output.data));
    }
    await collection.upsert({
      ids: batch.map(c => c.id),
      embeddings,
      metadatas: batch.map(c => c.metadata),
      documents: batch.map(c => c.document)
    });
    done += batch.length;
    const product = batch[batch.length - 1].metadata.product;
    console.log(`Embedded ${done} / ${total} (${product})`);
  }

  // Mark processed files as embedded in the manifest.
  for (const rel of processedFiles) {
    if (manifest.files[rel]) manifest.files[rel].chroma_embedded = true;
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n--- Ingest complete ---');
  console.log(`Files processed: ${processedFiles.length}`);
  console.log(`Chunks embedded: ${total}`);
  console.log(`Time elapsed: ${elapsed}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
