const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const opportunities = require('../lib/opportunityStore');
const { extractUploadText } = require('../lib/extractText');

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
      let extracted;
      try { extracted = await extractUploadText(req.file); }
      catch (e) { if (e.status === 400) return res.status(400).json({ error: e.message }); throw e; }
      content = extracted.content;
      if (!resolvedTitle) resolvedTitle = extracted.title;
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'No transcript content provided' });
    }

    const id = uuid();
    db.prepare(`
      INSERT INTO transcripts (id, account_id, opportunity_id, title, source, content, duration_minutes, call_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      account_id,
      opportunities.resolveId(db, account_id, req.body.opportunity_id),
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
