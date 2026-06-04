const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/database');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'accounts');
const INLINE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);

// Disk storage scoped per account. Directory is created on demand.
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(UPLOAD_ROOT, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase());
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

function fileOut(f) {
  return {
    id: f.id,
    filename: f.filename,
    original_name: f.original_name,
    file_type: f.file_type,
    file_size: f.file_size,
    mime_type: f.mime_type,
    category: f.category,
    description: f.description,
    uploaded_at: f.uploaded_at,
    url: `/api/files/${f.id}/download`
  };
}

// GET all non-deleted files for an account.
router.get('/accounts/:id/files', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM account_files WHERE account_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC'
  ).all(req.params.id);
  res.json(rows.map(fileOut));
});

// POST upload (multer applied only here, via a wrapper so size/type errors -> 400).
router.post('/accounts/:id/files', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const id = crypto.randomUUID();
  const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
  const category = (req.body && req.body.category) || 'other';
  const description = (req.body && req.body.description) || null;

  db.prepare(`
    INSERT INTO account_files
      (id, account_id, filename, original_name, file_type, file_size, mime_type, category, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, req.file.filename, req.file.originalname, ext, req.file.size, req.file.mimetype, category, description);

  res.status(201).json(fileOut(db.prepare('SELECT * FROM account_files WHERE id = ?').get(id)));
});

// GET stream a file (inline for images, attachment otherwise).
router.get('/files/:id/download', (req, res) => {
  const f = db.prepare('SELECT * FROM account_files WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(UPLOAD_ROOT, f.account_id, f.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });

  const ext = path.extname(f.filename).toLowerCase();
  const disposition = INLINE_EXT.has(ext) ? 'inline' : 'attachment';
  const safeName = String(f.original_name || 'file').replace(/"/g, '');
  res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// DELETE soft-delete (file stays on disk).
router.delete('/files/:id', (req, res) => {
  const f = db.prepare('SELECT id FROM account_files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'File not found' });
  db.prepare('UPDATE account_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
