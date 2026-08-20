require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

require('./db/database');

const app = express();

// Restrict CORS to same-origin / localhost only. In production the client is
// served same-origin by this server, and in dev Vite proxies same-origin — so
// no external site should ever be able to read the API cross-origin (which,
// with no app auth, would otherwise expose all data to any page you visit).
const LOCAL_ORIGIN = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || LOCAL_ORIGIN.some(re => re.test(origin)))
}));

// Security headers, incl. a Content-Security-Policy. Allows: same-origin assets,
// Google Fonts (JetBrains Mono), direct browser→Anthropic API calls, and inline
// styles (React style props / charts). No inline scripts are used by the app.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://api.anthropic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/notes', require('./routes/notes'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/next-steps', require('./routes/nextSteps'));
app.use('/api/todos', require('./routes/todos'));
app.use('/api/transcripts', require('./routes/transcripts'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/meetings', require('./routes/meetings'));
app.use('/api/search', require('./routes/search'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api', require('./routes/crmSnapshots'));
app.use('/api', require('./routes/dealIntelligence'));
app.use('/api', require('./routes/stageGate'));
app.use('/api', require('./routes/povConfig'));
app.use('/api', require('./routes/tags'));
app.use('/api', require('./routes/ai'));
app.use('/api', require('./routes/pov'));
app.use('/api', require('./routes/export'));
app.use('/api', require('./routes/files'));
app.use('/api/auth/microsoft', require('./routes/auth'));

// Lazily-initialized sentence-embedding pipeline (Xenova/all-MiniLM-L6-v2),
// shared via app.locals so POV retrieval routes can embed search queries.
// The model (~80MB) downloads on first use and is cached for the process
// lifetime. We require the package lazily so a missing/heavy dependency can
// never block server startup or break existing, non-AI features.
let _embeddingPipeline = null;
async function getEmbeddingPipeline() {
  if (!_embeddingPipeline) {
    const { pipeline } = require('@xenova/transformers');
    _embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return _embeddingPipeline;
}
app.locals.getEmbeddingPipeline = getEmbeddingPipeline;

// ChromaDB endpoint: inside Docker the service is reachable as `chromadb`;
// on a developer host it's localhost. Overridable via CHROMA_URL.
app.locals.chromaUrl = process.env.CHROMA_URL || 'http://chromadb:8000';

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Startup check: is the host embed server reachable from inside the container?
const { EMBED_URL } = require('./lib/embed');
async function checkEmbedServer() {
  try {
    const res = await fetch(`${EMBED_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) console.log('[embed] ✓ Embed server reachable');
    else console.warn('[embed] ✗ Embed server returned', res.status);
  } catch (err) {
    console.warn('[embed] ✗ Embed server NOT reachable:', err.message);
    console.warn('[embed] Fix: run node embed-server.js on host machine before generating POVs');
  }
}
checkEmbedServer();

// Serve the production client build, if present. Vite dev runs separately.
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  // SPA fallback: anything that isn't /api/* serves index.html
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  const mode = fs.existsSync(CLIENT_DIST) ? 'production (serving client/dist)' : 'api-only (run vite separately)';
  console.log(`[se-notebook] ${mode} — http://localhost:${PORT}`);
});
