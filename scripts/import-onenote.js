#!/usr/bin/env node
/**
 * OneNote import script.
 * Usage: node scripts/import-onenote.js <folder>
 *
 * Reads .docx and .html files recursively from <folder>.
 * Each file becomes one account (filename = account name) with a single note
 * containing all extracted text. If the content contains a recognizable date,
 * that date is used; otherwise today's date.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');

const cheerio = require(path.join(__dirname, '..', 'server', 'node_modules', 'cheerio'));
const mammoth = require(path.join(__dirname, '..', 'server', 'node_modules', 'mammoth'));
const db = require(path.join(__dirname, '..', 'server', 'db', 'database.js'));

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.(docx|html?)$/i.test(entry.name)) acc.push(p);
  }
  return acc;
}

function detectDate(text) {
  const patterns = [
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let d;
    if (re === patterns[0]) d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
    else if (re === patterns[1]) d = new Date(`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`);
    else d = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

async function extract(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ path: file });
    return r.value || '';
  }
  if (ext === '.html' || ext === '.htm') {
    const html = fs.readFileSync(file, 'utf8');
    const $ = cheerio.load(html);
    $('script,style').remove();
    return $('body').text().replace(/\n{3,}/g, '\n\n').trim();
  }
  return '';
}

(async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Usage: node scripts/import-onenote.js <folder>');
    process.exit(1);
  }
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.error(`Folder not found: ${folder}`);
    process.exit(1);
  }

  const files = walk(folder);
  console.log(`Found ${files.length} files.`);

  const findAccount = db.prepare('SELECT id FROM accounts WHERE LOWER(account_name) = ?');
  const insertAccount = db.prepare('INSERT INTO accounts (id, account_name) VALUES (?, ?)');
  const insertNote = db.prepare('INSERT INTO notes (id, account_id, date, raw_notes) VALUES (?, ?, ?, ?)');

  let imported = 0, accountsCreated = 0;
  const failures = [];

  for (const file of files) {
    try {
      const baseName = path.basename(file, path.extname(file));
      const accountName = baseName.trim();
      const content = (await extract(file)).trim();
      if (!content) { failures.push({ file, reason: 'no content' }); continue; }

      let existing = findAccount.get(accountName.toLowerCase());
      let accountId;
      if (existing) accountId = existing.id;
      else {
        accountId = uuid();
        insertAccount.run(accountId, accountName);
        accountsCreated++;
      }

      const date = detectDate(content);
      insertNote.run(uuid(), accountId, date, content);
      imported++;
      console.log(`  ✓ ${accountName} — ${path.relative(folder, file)} (${content.length.toLocaleString()} chars, ${date})`);
    } catch (e) {
      failures.push({ file, reason: e.message });
      console.error(`  ✗ ${file} — ${e.message}`);
    }
  }

  console.log(`\nSummary: processed ${files.length} files · imported ${imported} notes · created ${accountsCreated} accounts`);
  if (failures.length) {
    console.log(`Failures: ${failures.length}`);
    failures.forEach(f => console.log(`  - ${f.file}: ${f.reason}`));
  }
})();
