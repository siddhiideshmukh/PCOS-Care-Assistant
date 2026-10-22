// Retrieval-Augmented Generation pipeline:
// every PDF in data/ -> per-page text -> overlapping chunks -> OpenAI embeddings -> cosine-similarity search.
// Embeddings are cached per document, so adding a PDF only embeds that new file.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const OpenAI = require("openai");

const DOCS_DIR = path.join(__dirname, "..", "data");
const INDEX_PATH = path.join(__dirname, "data", "vector_index.json");
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;

const openai = new OpenAI();
let index = null; // { model, builtAt, docs: [{ file, title, size, pages }], chunks: [{ id, doc, page, text, embedding }] }

async function extractPages(buffer) {
  const pages = [];
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      let text = "";
      let lastY;
      for (const item of content.items) {
        text += lastY === undefined || lastY === item.transform[5] ? item.str : "\n" + item.str;
        lastY = item.transform[5];
      }
      pages[pageData.pageIndex] = text;
      return text;
    },
  });
  return pages;
}

function chunkPage(text, page) {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    // Prefer to break at a sentence or line boundary.
    if (end < clean.length) {
      const boundary = Math.max(clean.lastIndexOf(". ", end), clean.lastIndexOf("\n", end));
      if (boundary > start + CHUNK_SIZE * 0.5) end = boundary + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece.length > 80) chunks.push({ page, text: piece });
    if (end >= clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts.slice(i, i + 100) });
    out.push(...res.data.map((d) => d.embedding));
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// "pcos_medical_book.pdf" -> "Pcos Medical Book"; known files get a proper title.
const KNOWN_TITLES = {
  "pcos_medical_book.pdf": "International PCOS Guideline 2023 (Summary)",
  "Evidence-Based-Guidelines-2023.pdf": "International PMOS (formerly PCOS) Guideline, full, updated 2026",
  "Updated-PMOS-Guideline-12-June26.pdf": "International PMOS (formerly PCOS) Guideline, full, updated 2026",
  "Polycystic ovary syndrome.pdf": "WHO Fact Sheet: PCOS (Jan 2026)",
  "final_pcos_fact_sheet_digital_version.pdf": "FDA Fact Sheet: PCOS",
};
function titleFor(file) {
  return KNOWN_TITLES[file] || file.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function buildIndex() {
  const cached = fs.existsSync(INDEX_PATH) ? JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) : null;
  const reusable = cached?.model === EMBED_MODEL && cached.docs ? cached : null;
  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();

  const docs = [];
  const chunks = [];
  let changed = !reusable;

  const seenHashes = new Map();
  for (const file of files) {
    const size = fs.statSync(path.join(DOCS_DIR, file)).size;
    const hash = crypto.createHash("md5").update(fs.readFileSync(path.join(DOCS_DIR, file))).digest("hex");
    if (seenHashes.has(hash)) {
      console.log(`[rag] Skipping ${file}: identical to ${seenHashes.get(hash)}`);
      continue;
    }
    seenHashes.set(hash, file);
    const prev = reusable?.docs.find((d) => d.file === file && d.size === size);
    let docChunks;
    let pages;
    if (prev) {
      docChunks = reusable.chunks.filter((c) => c.doc === file);
      pages = prev.pages;
    } else {
      changed = true;
      console.log(`[rag] Embedding ${file}...`);
      const pageTexts = await extractPages(fs.readFileSync(path.join(DOCS_DIR, file)));
      pages = pageTexts.length;
      const raw = pageTexts.flatMap((text, i) => chunkPage(text || "", i + 1));
      const embeddings = await embed(raw.map((c) => c.text));
      docChunks = raw.map((c, i) => ({ doc: file, ...c, embedding: embeddings[i] }));
    }
    docs.push({ file, title: titleFor(file), size, pages, chunks: docChunks.length });
    chunks.push(...docChunks);
  }
  if (reusable && reusable.docs.map((d) => d.file).join() !== docs.map((d) => d.file).join()) changed = true;

  index = {
    model: EMBED_MODEL,
    builtAt: changed ? new Date().toISOString() : reusable.builtAt,
    docs,
    chunks: chunks.map((c, i) => ({ ...c, id: i })),
  };
  if (changed) {
    fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  }
  console.log(`[rag] Index ready: ${index.chunks.length} chunks from ${docs.length} document(s)`);
  return index;
}

async function search(query, k = 4) {
  const [q] = await embed([query]);
  const titles = Object.fromEntries(index.docs.map((d) => [d.file, d.title]));
  return index.chunks
    .map((c) => ({ id: c.id, doc: titles[c.doc], page: c.page, text: c.text, score: cosine(q, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function formatContext(sources) {
  return sources.map((s, i) => `[S${i + 1}] (${s.doc}, page ${s.page})\n${s.text}`).join("\n\n");
}

function stats() {
  return index
    ? {
        docs: index.docs.map(({ title, pages, chunks }) => ({ title, pages, chunks })),
        pages: index.docs.reduce((n, d) => n + d.pages, 0),
        chunks: index.chunks.length,
        embedModel: index.model,
        dims: index.chunks[0]?.embedding.length,
        builtAt: index.builtAt,
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
      }
    : null;
}

module.exports = { buildIndex, search, formatContext, stats };
