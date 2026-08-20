const express = require('express');
const db = require('../db/database');
const { callAnthropic, getKey, extractJson, DEFAULT_MODEL } = require('../lib/anthropic');
const { contactsForAccount } = require('../lib/contactStore');

const router = express.Router();

const EMAIL_INSTRUCTIONS = {
  'pov-followup': 'Write a follow-up email after a POV check-in. Summarize progress against success criteria, confirm next steps, and keep momentum toward a technical win.',
  'pre-kickoff': 'Write a pre-kickoff preparation email. Confirm the kickoff date, list prerequisites the customer must complete, and set expectations for week 1.',
  'technical-escalation': 'Write a concise internal/technical escalation email flagging a blocker, its impact on the timeline, and the specific help or decision needed.',
  'closeout-summary': 'Write a POV close-out summary email. Recap which success criteria were met, the key technical differentiation demonstrated, and the recommended commercial next step.',
  'custom': 'Write a professional email per the custom instructions provided.'
};

// POST /api/accounts/:id/email-draft  Body: { email_type, custom_prompt? }
router.post('/accounts/:id/email-draft', async (req, res, next) => {
  try {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const key = getKey(req);
    if (!key) return res.status(400).json({ error: 'Anthropic API key required. Add it in Settings.' });

    const { email_type, custom_prompt } = req.body || {};
    const instruction = EMAIL_INSTRUCTIONS[email_type] || EMAIL_INSTRUCTIONS.custom;

    const recentNote = db.prepare(
      'SELECT * FROM notes WHERE account_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC LIMIT 1'
    ).get(req.params.id);
    // Customer-side only: a drafted customer email must not name our partners
    // or internal staff.
    const contacts = contactsForAccount(db, req.params.id, { customerOnly: true });

    const system = `You are an OPSWAT Solutions Engineer drafting a professional, consultative customer email. Be concise and specific to the account context. Return ONLY JSON: { "subject": "...", "body": "..." } with no markdown or extra text. The body should be ready to send, with greeting and sign-off placeholders like [Name].`;

    const userContent =
`${instruction}
${email_type === 'custom' && custom_prompt ? `Custom instructions: ${custom_prompt}\n` : ''}
ACCOUNT: ${account.account_name} | Industry: ${account.industry || 'n/a'} | Stage: ${account.presales_stage || 'n/a'}
Contacts: ${contacts.map(c => `${c.name}${c.title ? ` (${c.title})` : ''}`).join(', ') || 'n/a'}

MOST RECENT NOTE (${recentNote ? recentNote.date : 'none'}):
${recentNote ? (recentNote.raw_notes || '').slice(0, 2500) : '(no notes yet)'}`;

    const text = await callAnthropic({
      key, model: DEFAULT_MODEL, max_tokens: 1200, system,
      messages: [{ role: 'user', content: userContent }]
    });

    let parsed;
    try { parsed = extractJson(text); }
    catch { parsed = { subject: `${account.account_name} — follow-up`, body: text }; }

    res.json({ subject: parsed.subject || '', body: parsed.body || '' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
