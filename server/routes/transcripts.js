const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const { v4: uuid } = require('uuid');
const db = require('../db/database');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    const { account_id, title, call_date, duration_minutes, source } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });

    let content = req.body.content || '';
    let resolvedTitle = title || '';

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.docx') {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        content = result.value;
      } else if (ext === '.txt' || ext === '.md') {
        content = req.file.buffer.toString('utf8');
      } else if (ext === '.pdf') {
        // pdf-parse is required lazily so a missing optional dependency never
        // blocks server startup or the .txt/.md/.docx paths.
        try {
          const pdfParse = require('pdf-parse');
          const parsed = await pdfParse(req.file.buffer);
          content = parsed.text || '';
        } catch (e) {
          return res.status(400).json({ error: 'PDF parsing unavailable: ' + e.message });
        }
      } else {
        return res.status(400).json({ error: 'Unsupported file type. Use .txt, .md, .pdf or .docx' });
      }
      if (!resolvedTitle) resolvedTitle = path.basename(req.file.originalname, ext);
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'No transcript content provided' });
    }

    const id = uuid();
    db.prepare(`
      INSERT INTO transcripts (id, account_id, title, source, content, duration_minutes, call_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      account_id,
      resolvedTitle || 'Untitled transcript',
      source || 'clari_copilot',
      content,
      duration_minutes ? parseInt(duration_minutes, 10) : null,
      call_date || new Date().toISOString().slice(0, 10)
    );

    res.status(201).json(db.prepare('SELECT * FROM transcripts WHERE id = ?').get(id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM transcripts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
