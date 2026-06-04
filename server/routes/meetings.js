const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db/database');
const { graphFetch, hasToken, isConfigured } = require('../lib/msGraph');

const router = express.Router();

router.get('/:accountId', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM meetings WHERE account_id = ? ORDER BY start_time DESC
  `).all(req.params.accountId);
  res.json(rows);
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Meeting not found' });
  const fields = ['title', 'start_time', 'end_time', 'attendees', 'meeting_url', 'has_note'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in req.body) {
      updates.push(`${f} = ?`);
      values.push(f === 'has_note' ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  }
  if (!updates.length) return res.json(existing);
  values.push(req.params.id);
  db.prepare(`UPDATE meetings SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id));
});

router.post('/sync/:accountId', async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(400).json({ error: 'Microsoft credentials not configured in .env' });
    }
    if (!hasToken()) {
      return res.status(401).json({ error: 'Outlook not connected. Visit /api/auth/microsoft first.' });
    }

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const lookBackDays = 90;
    const lookForwardDays = 30;
    const startDate = new Date(Date.now() - lookBackDays * 86400000).toISOString();
    const endDate = new Date(Date.now() + lookForwardDays * 86400000).toISOString();

    const accountTerm = account.account_name.replace(/'/g, "''");
    const filter = `start/dateTime ge '${startDate}' and end/dateTime le '${endDate}'`;
    const select = 'id,subject,start,end,attendees,onlineMeeting,webLink,bodyPreview';
    const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startDate)}&endDateTime=${encodeURIComponent(endDate)}&$select=${encodeURIComponent(select)}&$top=200`;

    const data = await graphFetch(url);
    const events = data.value || [];
    const needle = account.account_name.toLowerCase();

    const matched = events.filter(ev => {
      const subj = (ev.subject || '').toLowerCase();
      if (subj.includes(needle)) return true;
      const atts = ev.attendees || [];
      for (const a of atts) {
        const name = (a?.emailAddress?.name || '').toLowerCase();
        const addr = (a?.emailAddress?.address || '').toLowerCase();
        if (name.includes(needle) || addr.includes(needle)) return true;
      }
      return false;
    });

    const upsertExisting = db.prepare('SELECT id FROM meetings WHERE outlook_event_id = ?');
    const insert = db.prepare(`
      INSERT INTO meetings (id, account_id, outlook_event_id, title, start_time, end_time, attendees, meeting_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE meetings SET title = ?, start_time = ?, end_time = ?, attendees = ?, meeting_url = ?, account_id = ?
      WHERE outlook_event_id = ?
    `);

    const tx = db.transaction(items => {
      for (const ev of items) {
        const title = ev.subject || '(no title)';
        const start = ev.start?.dateTime || null;
        const end = ev.end?.dateTime || null;
        const attendees = (ev.attendees || []).map(a => a?.emailAddress?.name || a?.emailAddress?.address).filter(Boolean).join(', ');
        const meetingUrl = ev.onlineMeeting?.joinUrl || ev.webLink || null;
        const existing = upsertExisting.get(ev.id);
        if (existing) {
          update.run(title, start, end, attendees, meetingUrl, account.id, ev.id);
        } else {
          insert.run(uuid(), account.id, ev.id, title, start, end, attendees, meetingUrl);
        }
      }
    });
    tx(matched);

    const meetings = db.prepare('SELECT * FROM meetings WHERE account_id = ? ORDER BY start_time DESC').all(account.id);
    res.json({ count: matched.length, meetings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
