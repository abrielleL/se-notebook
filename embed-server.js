#!/usr/bin/env node
// ============================================================
// embed-server.js — host-side embedding service for POV retrieval.
//
// Runs on the Mac (NOT in Docker). The Dockerized app reaches it at
// http://host.docker.internal:8001/embed. Uses the SAME model as ingest.js
// (Xenova/all-MiniLM-L6-v2, 384-dim) so query vectors match the ingested docs.
//
// Usage:  node embed-server.js
//
// Requires @xenova/transformers (already a project-root dependency).
// Binds 0.0.0.0 so Docker can reach it via host.docker.internal.
// ============================================================

const http = require('http');
const { pipeline } = require('@xenova/transformers');

const PORT = process.env.EMBED_PORT || 8001;
const MODEL = 'Xenova/all-MiniLM-L6-v2';

let _extractor = null;
async function getExtractor() {
  if (!_extractor) _extractor = await pipeline('feature-extraction', MODEL);
  return _extractor;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/embed') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body || '{}');
        if (!text || !String(text).trim()) return sendJson(res, 400, { error: 'text required' });
        const extractor = await getExtractor();
        const output = await extractor(String(text), { pooling: 'mean', normalize: true });
        sendJson(res, 200, { embedding: Array.from(output.data) });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[embed-server] Running on port ${PORT}`);
  try {
    console.log('[embed-server] Loading model (first run downloads ~80MB)…');
    await getExtractor();
    console.log('[embed-server] Model ready');
  } catch (err) {
    console.error('[embed-server] Model load failed:', err.message);
  }
});
