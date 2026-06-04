// Query-embedding via the host embed server (embed-server.js on the Mac),
// reachable from inside Docker at host.docker.internal:8001. This must use the
// SAME model as ingest.js (Xenova/all-MiniLM-L6-v2) so query and document
// vectors live in the same space.
const EMBED_URL = process.env.EMBED_SERVER_URL || 'http://host.docker.internal:8001';

async function getEmbedding(text) {
  const response = await fetch(`${EMBED_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`Embed server error: ${response.status}`);
  }
  const data = await response.json();
  if (!data.embedding || !data.embedding.length) {
    throw new Error('Embed server returned no embedding');
  }
  return data.embedding;
}

module.exports = { getEmbedding, EMBED_URL };
