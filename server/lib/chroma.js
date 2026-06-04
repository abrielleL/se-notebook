// Thin ChromaDB query helper. chromadb is required lazily so a missing or
// unreachable vector store never crashes unrelated routes.

const COLLECTION_NAME = 'opswat_docs';

async function getCollection(chromaUrl) {
  const { ChromaClient } = require('chromadb');
  const client = new ChromaClient({ path: chromaUrl });
  return client.getOrCreateCollection({ name: COLLECTION_NAME });
}

// Query top-N chunks using a precomputed query embedding (from the host embed
// server). Returns a normalized array of { document, metadata, distance }.
async function queryDocs({ chromaUrl, embedding, nResults = 15, where }) {
  const collection = await getCollection(chromaUrl);
  const res = await collection.query({
    queryEmbeddings: [embedding],
    nResults,
    where: where || undefined
  });

  const docs = (res.documents && res.documents[0]) || [];
  const metas = (res.metadatas && res.metadatas[0]) || [];
  const dists = (res.distances && res.distances[0]) || [];
  return docs.map((document, i) => ({
    document,
    metadata: metas[i] || {},
    distance: typeof dists[i] === 'number' ? dists[i] : null
  }));
}

module.exports = { queryDocs, getCollection, COLLECTION_NAME };
