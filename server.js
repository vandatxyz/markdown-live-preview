const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// --- Database setup ---
const dbPath = path.join(__dirname, 'data', 'markdown.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Seed a default document if table is empty
const count = db.prepare('SELECT COUNT(*) AS cnt FROM documents').get();
if (count.cnt === 0) {
  const defaultMarkdown = `# Welcome to Markdown Live Preview

Start typing on the left to see the preview on the right.

## Features
- **Live preview** as you type
- **Multiple documents** — create, rename, delete
- **Export to PDF**
- **Syntax highlighting** & Mermaid diagrams

---

Happy writing! ✨
`;
  const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  db.prepare('INSERT INTO documents (id, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'Welcome', defaultMarkdown, Date.now(), Date.now());
}

// --- API Routes ---

// List all documents
app.get('/api/documents', (req, res) => {
  try {
    const docs = db.prepare('SELECT id, name, created_at, updated_at FROM documents ORDER BY updated_at DESC').all();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single document (with content)
app.get('/api/documents/:id', (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new document
app.post('/api/documents', (req, res) => {
  try {
    const { name, content } = req.body;
    if (!name && name !== '') return res.status(400).json({ error: 'name is required' });
    const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    db.prepare('INSERT INTO documents (id, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name || 'Untitled', content || '', now, now);
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(201).json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update document (full save)
app.put('/api/documents/:id', (req, res) => {
  try {
    const { name, content } = req.body;
    const existing = db.prepare('SELECT id FROM documents WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (content !== undefined) { updates.push('content = ?'); params.push(content); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    updates.push('updated_at = ?');
    params.push(Date.now());
    params.push(req.params.id);

    db.prepare(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete document
app.delete('/api/documents/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Static files (serve built frontend) ---
app.use(express.static(path.join(__dirname, 'dist'), { maxAge: 0 }));

// SPA fallback — catch all non-API, non-static requests
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.includes('.')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Markdown Live Preview running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});
