const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const db = require('../db/database');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

router.post('/', upload.single('file'), (req, res) => {
  const { account_id } = req.body;
  if (!account_id) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'account_id required' });
  }
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO attachments (id, account_id, filename, original_name, mimetype, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, account_id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);

  res.status(201).json(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });
  const fp = path.join(UPLOAD_DIR, a.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/:id/download', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });
  const fp = path.join(UPLOAD_DIR, a.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing on disk' });
  res.download(fp, a.original_name);
});

router.get('/:id/view', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });
  const fp = path.join(UPLOAD_DIR, a.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing on disk' });
  if (a.mimetype) res.type(a.mimetype);
  res.sendFile(fp);
});

module.exports = router;
