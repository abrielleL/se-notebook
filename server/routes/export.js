const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { contactsForAccount } = require('../lib/contactStore');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'accounts');
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function accountFiles(accountId) {
  return db.prepare(
    'SELECT * FROM account_files WHERE account_id = ? AND deleted_at IS NULL ORDER BY category, uploaded_at DESC'
  ).all(accountId);
}

// Resolve the POV to export: a specific draft when pov_id is given, else the
// account's most recent one (back-compat with account-level export).
function getPov(accountId, povId) {
  if (povId) {
    return db.prepare('SELECT * FROM pov_drafts WHERE id = ? AND account_id = ? AND deleted_at IS NULL').get(povId, accountId);
  }
  return db.prepare('SELECT * FROM pov_drafts WHERE account_id = ? AND deleted_at IS NULL ORDER BY generated_at DESC LIMIT 1').get(accountId);
}

// Lightweight PNG/JPEG dimension reader so embedded images keep aspect ratio.
function imageDims(buf) {
  try {
    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let o = 2;
      while (o < buf.length - 8) {
        if (buf[o] !== 0xFF) { o++; continue; }
        const marker = buf[o + 1];
        if (marker >= 0xC0 && marker <= 0xC3) {
          return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
        }
        o += 2 + buf.readUInt16BE(o + 2);
      }
    }
  } catch {}
  return null;
}

const QUAL_LABELS = {
  success_metrics: 'Success metrics',
  decision_maker: 'Decision maker',
  evaluation_criteria: 'Evaluation criteria',
  buying_process: 'Buying process',
  paper_process: 'Paper process',
  business_pain: 'Business pain',
  internal_champion: 'Internal champion',
  competitive_landscape: 'Competitive landscape'
};

const SECTION_TITLES = {
  summary: 'AI Summary',
  drivers: 'Technical Drivers',
  environment: 'Environment',
  next_steps: 'Next Steps',
  contacts: 'Contacts',
  qualification: 'Account Qualification',
  notes: 'Note History',
  crm_snapshot: 'CRM Snapshot',
  active_pov: 'Active POV',
  se_prep_notes: 'SE Prep Notes',
  attachments: 'Attachments'
};

const INTERNAL_LABEL = 'INTERNAL - NOT FOR DISTRIBUTION';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Build a normalized model for the requested sections.
// Each item: { key, title, internal, paragraphs?, table?, subsections?, sources? }
// `includeNonCustomer` controls whether partner / analyst / internal contacts
// appear in the Contacts section. Defaults to false so a partner's name never
// lands in a customer-facing document unless it was asked for explicitly.
function assemble(account, sectionKeys, povId, includeNonCustomer = false) {
  const id = account.id;
  const items = [];

  for (const key of sectionKeys) {
    const title = SECTION_TITLES[key] || key;
    if (key === 'summary') {
      items.push({ key, title, paragraphs: [account.ai_summary || '(none)'] });
    } else if (key === 'drivers') {
      items.push({ key, title, paragraphs: [account.ai_technical_drivers || '(none)'] });
    } else if (key === 'environment') {
      items.push({ key, title, paragraphs: [account.ai_environment || '(none)'] });
    } else if (key === 'next_steps') {
      const steps = db.prepare('SELECT text, completed FROM next_steps WHERE account_id = ? ORDER BY created_at').all(id);
      items.push({ key, title, paragraphs: steps.length ? steps.map(s => `${s.completed ? '[x]' : '[ ]'} ${s.text}`) : ['(none)'] });
    } else if (key === 'contacts') {
      const rows = contactsForAccount(db, id, { customerOnly: !includeNonCustomer });
      // The Organization column only earns its place when non-customer
      // contacts are in play -- for customer-only exports every row would
      // just repeat the account name.
      const headers = includeNonCustomer
        ? ['Name', 'Title', 'Organization', 'Role', 'Email']
        : ['Name', 'Title', 'Role', 'Email'];
      items.push({
        key, title,
        table: {
          headers,
          rows: rows.map(c => includeNonCustomer
            ? [c.name || '', c.title || '', c.org_name || (c.contact_type === 'customer' ? account.account_name : ''), c.meddpicc_role || '', c.email || '']
            : [c.name || '', c.title || '', c.meddpicc_role || '', c.email || ''])
        }
      });
    } else if (key === 'qualification') {
      const di = {};
      db.prepare('SELECT field, value FROM deal_intelligence WHERE account_id = ?').all(id).forEach(r => { di[r.field] = r.value; });
      items.push({
        key, title,
        table: {
          headers: ['Field', 'Content'],
          rows: Object.keys(QUAL_LABELS).map(f => [QUAL_LABELS[f], di[f] || ''])
        }
      });
    } else if (key === 'notes') {
      const notes = db.prepare('SELECT date, note_type, raw_notes FROM notes WHERE account_id = ? AND deleted_at IS NULL ORDER BY date DESC').all(id);
      items.push({
        key, title,
        subsections: notes.map(n => ({ heading: `${n.date}${n.note_type ? ` — ${n.note_type}` : ''}`, paragraphs: [(n.raw_notes || '').trim() || '(empty)'] }))
      });
    } else if (key === 'crm_snapshot') {
      const snap = db.prepare('SELECT snapshot_text FROM crm_snapshots WHERE account_id = ? AND deleted_at IS NULL ORDER BY generated_at DESC LIMIT 1').get(id);
      items.push({ key, title, paragraphs: [snap ? snap.snapshot_text : '(none)'] });
    } else if (key === 'active_pov') {
      const pov = getPov(id, povId);
      let sections = {};
      let sources = [];
      if (pov) {
        try { sections = pov.section_texts ? JSON.parse(pov.section_texts) : {}; } catch {}
        try { sources = pov.sources ? JSON.parse(pov.sources) : []; } catch {}
      }
      items.push({
        key, title,
        subsections: Object.entries(sections).map(([h, t]) => ({ heading: h, paragraphs: [t] })),
        sources
      });
    } else if (key === 'se_prep_notes') {
      const pov = getPov(id, povId);
      items.push({ key, title: `${title} — ${INTERNAL_LABEL}`, internal: true, paragraphs: [pov && pov.se_prep_notes ? pov.se_prep_notes : '(none)'] });
    } else if (key === 'attachments') {
      const files = accountFiles(id);
      items.push({
        key, title,
        table: {
          headers: ['Filename', 'Category', 'Description', 'Date'],
          rows: files.map(f => [f.original_name, f.category, f.description || '', (f.uploaded_at || '').slice(0, 10)])
        },
        images: files.filter(f => IMG_EXT.has((f.file_type || '').toLowerCase())).map(f => ({ id: f.id, name: f.original_name }))
      });
    }
  }
  return items;
}

function povFilename(account) {
  const safe = (account.account_name || 'Account').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  const date = new Date().toISOString().slice(0, 10);
  return `POV_${safe}_${date}.docx`;
}

function accountFilename(account) {
  const safe = (account.account_name || 'Account').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  const date = new Date().toISOString().slice(0, 10);
  return `Account_${safe}_${date}.docx`;
}

// --- Branded OPSWAT POV docx rendering ---
// Every typography / color / spacing value below is extracted from pov-template.docx
// (word/styles.xml, word/document.xml, word/theme/theme1.xml) so the exported POV
// matches the template. See `unpacked-template/` for the source values.
const FONT = 'Simplon Norm'; // Normal style rFonts (ascii/hAnsi); 'Simplon Norm Medium' is used for headings/emphasis in the template

// Theme palette (theme1.xml clrScheme) + style colors (styles.xml).
const C = {
  navy: '111F42',     // accent1 — heading1 text + cover hero fill
  navyDk: '0C1731',   // Heading1 base color (accent1 shade BF)
  blue: '2672FB',     // accent4 — heading rule, section numbers, heading2 text
  blueLink: '1F56BC', // Hyperlink color
  white: 'FFFFFF',    // background1/2 (lt1 / lt2)
  ink: '000000',      // pBody text color
  dark: '000000',     // alias for body runs (was 1A1A1A)
  heading3: '191918', // heading3 (headings) color
  emphasis: '282828', // Emphasis color
  lightBlue: '86A7E8',// accent2 tint used for cover sub-labels
  // The template defines no tables; these are brand-consistent choices:
  headerFill: '111F42', // table header row — navy, matches heading color
  greyRow: 'EEF2FB',    // zebra row — light tint of accent blue
  border: '000000',     // TableGrid border (single, sz 4, color auto -> black)
  green: '1F7A1F', greenScope: '1F7A1F', redScope: '791F1F', redUrgent: 'E24B4A',
  muted: '6B6B6B', lightGrey: 'BFBFBF', internal: 'C00000'
};

// Font sizes in points, taken from styles.xml / document.xml sz values (sz / 2 = pt).
const PT = {
  body: 11,        // pBody (sz 22)
  small: 9.5,      // p3_small (sz 19)
  bullet: 10.5,    // bullet1 (sz 21)
  h1: 20,          // heading1headings (sz 40)
  h2: 12.5,        // heading2 (sz 25)
  h3: 11.5,        // heading3 (sz 23)
  coverTitle: 48,  // cover title (sz 96)
  coverSub: 28,    // cover subtitle (sz 56)
  coverDate: 16,   // cover date (sz 32)
  provided: 18,    // "Provided for/by" (sz 36)
  caption: 9,      // Caption (sz 18)
  footer: 8        // Footer (sz 16)
};

const TABLE_W = 9360;
const half = (pt) => Math.round(pt * 2); // docx sizes are half-points

const POV_SECTION_ORDER = [
  [1, 'Purpose'], [2, 'Products in scope'], [3, 'Customer environment'],
  [4, 'Objectives & success criteria'], [5, 'Scope'], [6, 'Use cases'],
  [7, 'Plan & timeline'], [8, 'Technical prerequisites'], [9, 'Roles & contacts'],
  [10, 'Assumptions & risks'], [11, 'Sign-off & next steps']
];

async function renderDocx(account, pov, selectedKeys) {
  const docx = require('docx');
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    WidthType, BorderStyle, ShadingType, VerticalAlign, ImageRun,
    AlignmentType, LineRuleType, PageBreak
  } = docx;

  const run = (text, o = {}) => new TextRun({ text: String(text == null ? '' : text), size: o.size || half(PT.body), bold: !!o.bold, color: o.color || C.ink, font: o.font, allCaps: !!o.allCaps });

  // **bold** inline parsing
  const inlineRuns = (text, base = {}) =>
    String(text == null ? '' : text).split(/(\*\*[^*]+\*\*)/g).filter(p => p !== '').map(p => {
      const m = /^\*\*([^*]+)\*\*$/.exec(p);
      return run(m ? m[1] : p, { ...base, bold: m ? true : base.bold });
    });

  // pBody: before 160, after 22, line 260 atLeast, 11pt.
  const bodyPara = (text) => new Paragraph({
    spacing: { before: 160, after: 22, line: 260, lineRule: LineRuleType.AT_LEAST },
    children: inlineRuns(text, { size: half(PT.body) })
  });
  // bullet1: before 40, after 0, line 270 atLeast, 10.5pt.
  const bulletPara = (text, char = '•', color = C.ink) => new Paragraph({
    spacing: { before: 40, after: 0, line: 270, lineRule: LineRuleType.AT_LEAST }, indent: { left: 360, hanging: 270 },
    children: [run(`${char} `, { size: half(PT.bullet), color }), ...inlineRuns(text, { size: half(PT.bullet) })]
  });

  // TableGrid: single border, sz 4, color auto (-> black).
  const gridBorders = () => {
    const b = { style: BorderStyle.SINGLE, size: 4, color: C.border };
    return { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b };
  };
  const noBorders = () => {
    const n = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    return { top: n, bottom: n, left: n, right: n, insideHorizontal: n, insideVertical: n };
  };
  // TableNormal cell margins: left/right 108, top/bottom 0 (dxa).
  const cellMargins = { top: 0, bottom: 0, left: 108, right: 108 };
  // Inner padding paragraph spacing so 0 top/bottom cell margins stay readable.
  const cellPara = (kids) => new Paragraph({ spacing: { before: 40, after: 40, line: 260, lineRule: LineRuleType.AT_LEAST }, children: kids });

  const dataCell = (text, fill) => new TableCell({
    shading: { fill, type: ShadingType.CLEAR, color: 'auto' },
    margins: cellMargins, verticalAlign: VerticalAlign.TOP,
    children: [cellPara(inlineRuns(String(text).replace(/\[ \]/g, '☐').replace(/\[x\]/gi, '☑'), { size: half(PT.body) }))]
  });
  const headerCell = (text) => new TableCell({
    shading: { fill: C.headerFill, type: ShadingType.CLEAR, color: 'auto' },
    margins: cellMargins, verticalAlign: VerticalAlign.TOP,
    children: [cellPara([run(text, { size: half(PT.body), bold: true, color: C.white })])]
  });

  const brandedTable = (headers, rows) => new Table({
    width: { size: TABLE_W, type: WidthType.DXA }, borders: gridBorders(),
    rows: [
      new TableRow({ tableHeader: true, children: headers.map(h => headerCell(h)) }),
      ...rows.map((r, i) => new TableRow({ children: r.map(c => dataCell(c, i % 2 ? C.greyRow : C.white)) }))
    ]
  });

  // heading1headings: Simplon Norm 20pt navy, blue (accent4) bottom rule sz 8/space 8, after 360.
  const sectionHeading = (num, title) => new Paragraph({
    spacing: { before: 240, after: 360, line: 252, lineRule: LineRuleType.AUTO },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, space: 8, color: C.blue } },
    children: [
      ...(num !== '' && num != null ? [run(`${num}  `, { bold: true, color: C.blue, size: half(PT.h1) })] : []),
      run(title, { bold: true, color: C.navy, size: half(PT.h1) })
    ]
  });

  // Markdown '#'-heading rendered inside a section body (used by the fallback
  // path when a POV was stored as one un-split blob). Level scales the size.
  const mdHeadingPara = (text, level) => new Paragraph({
    spacing: { before: level <= 2 ? 200 : 140, after: 60, line: 252, lineRule: LineRuleType.AUTO },
    children: [run(text, { bold: true, color: level <= 2 ? C.navy : C.heading3, size: half(level <= 2 ? PT.h2 : PT.h3) })]
  });

  // Parse a markdown section body into docx blocks (headings, tables, bullets, paragraphs).
  function parseBody(text, opts = {}) {
    const out = [];
    const lines = String(text || '').split('\n');
    let i = 0;
    while (i < lines.length) {
      if (lines[i].includes('|')) {
        const block = [];
        while (i < lines.length && lines[i].includes('|')) { block.push(lines[i]); i++; }
        const t = mdTable(block);
        if (t) { out.push(t); continue; }
      }
      const trimmed = lines[i].trim();
      if (!trimmed) { i++; continue; }
      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { i++; continue; } // skip horizontal rules
      else if (heading) out.push(mdHeadingPara(heading[2].replace(/\*\*/g, ''), heading[1].length));
      else if (/^[-•*]\s+/.test(trimmed)) out.push(bulletPara(trimmed.replace(/^[-•*]\s+/, ''), opts.bulletChar || '•', opts.bulletColor));
      else out.push(bodyPara(trimmed));
      i++;
    }
    return out.length ? out : [bodyPara('(no content)')];
  }

  function splitRow(line) {
    let cells = line.split('|').map(c => c.trim());
    if (cells.length && cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    return cells;
  }
  function isSeparator(cells) { return cells.length && cells.every(c => /^:?-{2,}:?$/.test(c) || c === ''); }
  function mdTable(block) {
    const rows = block.map(splitRow).filter(r => r.length && !isSeparator(r));
    if (rows.length < 1) return null;
    const headers = rows[0];
    const data = rows.slice(1);
    return brandedTable(headers, data.length ? data : [headers.map(() => '')]);
  }

  // Section 5: two-column In Scope / Out of Scope
  function renderScope(text) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf('out of scope');
    const bulletsOf = (s) => (s.match(/^[\t ]*[-•*]\s+.+$/gm) || []).map(l => l.replace(/^[\t ]*[-•*]\s+/, '').trim());
    let inItems = [], outItems = [];
    if (idx !== -1) { inItems = bulletsOf(text.slice(0, idx)); outItems = bulletsOf(text.slice(idx)); }
    else { inItems = bulletsOf(text); }
    if (!inItems.length && !outItems.length) return parseBody(text);
    const colCell = (items, mark, markColor) => new TableCell({
      width: { size: 4680, type: WidthType.DXA }, margins: cellMargins, verticalAlign: VerticalAlign.TOP,
      children: items.length ? items.map(it => new Paragraph({ spacing: { before: 40, after: 40, line: 260, lineRule: LineRuleType.AT_LEAST }, children: [run(`${mark} `, { bold: true, color: markColor, size: half(PT.body) }), ...inlineRuns(it, { size: half(PT.body) })] }))
        : [cellPara(inlineRuns('—', { size: half(PT.body) }))]
    });
    return new Table({
      width: { size: TABLE_W, type: WidthType.DXA }, borders: gridBorders(),
      rows: [
        new TableRow({ tableHeader: true, children: [headerCell('In Scope'), headerCell('Out of Scope')] }),
        new TableRow({ children: [colCell(inItems, '✓', C.green), colCell(outItems, '✗', C.redScope)] })
      ]
    });
  }

  // Section 11: fixed sign-off table
  function signoffTable() {
    const lineLabel = (label) => new Paragraph({ spacing: { after: 120 }, children: [run(`${label}: `, { color: C.muted, size: half(PT.body) }), run('________________________________', { color: C.lightGrey, size: half(PT.body) })] });
    const col = (heading) => new TableCell({
      width: { size: 4680, type: WidthType.DXA }, margins: cellMargins, verticalAlign: VerticalAlign.TOP,
      children: [
        new Paragraph({ spacing: { before: 40, after: 120 }, children: [run(heading, { bold: true, color: C.navy, size: half(PT.body) })] }),
        lineLabel('Name'), lineLabel('Title'), lineLabel('Signature'), lineLabel('Date')
      ]
    });
    return new Table({
      width: { size: TABLE_W, type: WidthType.DXA }, borders: gridBorders(),
      rows: [new TableRow({ children: [col('OPSWAT Representative'), col('Customer Representative')] })]
    });
  }

  // --- assemble document body ---
  const children = [];

  // COVER BLOCK — mirrors the template's hero: centered title / subtitle / date,
  // then left-aligned "Provided for / by" lines (document.xml cover sdtContent).
  // The template's full-bleed background image can't be reproduced from style
  // values, so the hero uses a navy (accent1) fill to keep the white text legible.
  const fmtDate = (d) => d ? d : 'TBD';
  const duration = (pov && (pov.start_date || pov.end_date)) ? `${fmtDate(pov && pov.start_date)} – ${fmtDate(pov && pov.end_date)}` : 'TBD';
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const heroPara = (text, pt, o = {}) => new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: o.after == null ? 200 : o.after, line: 240, lineRule: LineRuleType.AUTO },
    children: [run(text, { color: C.white, bold: o.bold !== false, size: half(pt) })]
  });
  const heroCell = new TableCell({
    shading: { fill: C.navy, type: ShadingType.CLEAR, color: 'auto' },
    margins: { top: 720, bottom: 720, left: 360, right: 360 }, verticalAlign: VerticalAlign.CENTER,
    children: [
      heroPara(account.account_name || 'OPSWAT MetaDefender', PT.coverTitle, { after: 240 }),
      heroPara('Proof of Value Document', PT.coverSub, { after: 240 }),
      heroPara(today, PT.coverDate, { bold: false, after: 0 })
    ]
  });
  children.push(new Table({
    width: { size: TABLE_W, type: WidthType.DXA }, borders: noBorders(),
    rows: [new TableRow({ children: [heroCell] })]
  }));

  // "Provided for / by" lines (template sz 36 = 18pt).
  const providedLine = (label, value) => new Paragraph({
    spacing: { before: 120, after: 40 },
    children: [run(label, { size: half(PT.provided) }), run(value, { size: half(PT.provided), bold: true })]
  });
  children.push(providedLine('Provided for: ', account.account_name || 'TBD'));
  children.push(providedLine('Provided by: ', account.ae_name || account.account_executive || 'TBD'));

  // Supporting engagement metadata (not on the template cover) at small body size.
  const metaLine = (label, value) => new Paragraph({ spacing: { after: 20 }, children: [run(`${label}: `, { size: half(PT.small), color: C.muted }), run(value, { size: half(PT.small) })] });
  children.push(metaLine('Engagement type', 'Proof of Value (PoV)'));
  children.push(metaLine('Solutions Engineer', 'SE Name'));
  children.push(metaLine('PoV duration', duration));
  children.push(metaLine('Classification', 'Confidential'));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // SECTION CARDS from pov.section_texts
  let sectionTexts = {};
  if (pov) { try { sectionTexts = pov.section_texts ? JSON.parse(pov.section_texts) : {}; } catch {} }
  const findSection = (num) => {
    const re = new RegExp(`^SECTION\\s*${num}\\b`, 'i');
    const key = Object.keys(sectionTexts).find(k => re.test(k));
    return key ? sectionTexts[key] : null;
  };

  const anyNumbered = POV_SECTION_ORDER.some(([num]) => findSection(num) != null);

  if (!pov || !Object.keys(sectionTexts).length) {
    children.push(bodyPara('No POV draft is available to export for this account. Generate a POV first.'));
  } else if (anyNumbered) {
    for (const [num, title] of POV_SECTION_ORDER) {
      const body = findSection(num);
      if (body == null) continue;
      children.push(sectionHeading(num, title));
      if (num === 5) children.push(renderScope(body));
      else if (num === 11) {
        for (const line of String(body).split('\n')) {
          const t = line.trim();
          if (t && !line.includes('|')) children.push(bodyPara(t));
        }
        children.push(signoffTable());
      } else if (num === 8) {
        children.push(...parseBody(body, { bulletChar: '☐', bulletColor: C.muted }));
      } else {
        children.push(...parseBody(body));
      }
    }
  } else {
    // Fallback: the POV wasn't split into numbered sections (e.g. stored as a
    // single 'Document' blob). Render every entry's content generically so the
    // full document still exports instead of just the cover page. Drop any
    // decorative title preamble before 'SECTION 1' (redundant with the cover).
    for (const [heading, body] of Object.entries(sectionTexts)) {
      if (heading && !/^document$/i.test(heading)) children.push(sectionHeading('', heading));
      const trimmed = String(body || '').replace(/^[\s\S]*?(?=^\s*#{0,6}\s*\**\s*SECTION\s+1\b)/im, '');
      children.push(...parseBody(trimmed || body));
    }
  }

  // SE PREP NOTES (only if explicitly selected) — internal label.
  if (Array.isArray(selectedKeys) && selectedKeys.includes('se_prep_notes') && pov && pov.se_prep_notes) {
    children.push(new Paragraph({ spacing: { before: 280, after: 60 }, children: [run('INTERNAL — NOT FOR DISTRIBUTION', { bold: true, color: C.internal, size: half(PT.body) })] }));
    children.push(sectionHeading('', 'SE Prep Notes'));
    children.push(...parseBody(pov.se_prep_notes));
  }

  // ATTACHMENTS (only if explicitly selected): table + inline images.
  if (Array.isArray(selectedKeys) && selectedKeys.includes('attachments')) {
    const files = accountFiles(account.id);
    children.push(sectionHeading('', 'Attachments'));
    if (!files.length) {
      children.push(bodyPara('No files attached.'));
    } else {
      children.push(brandedTable(
        ['Filename', 'Category', 'Description', 'Date'],
        files.map(f => [f.original_name, f.category, f.description || '', (f.uploaded_at || '').slice(0, 10)])
      ));
      for (const f of files) {
        if (!IMG_EXT.has((f.file_type || '').toLowerCase())) continue;
        try {
          const buf = fs.readFileSync(path.join(UPLOAD_ROOT, f.account_id, f.filename));
          const dims = imageDims(buf);
          let width = 450, height = 300;
          if (dims && dims.w && dims.h) {
            width = Math.min(450, dims.w);
            height = Math.round((dims.h / dims.w) * width);
          }
          children.push(new Paragraph({ spacing: { before: 120, after: 20 }, children: [new ImageRun({ data: buf, transformation: { width, height } })] }));
          children.push(new Paragraph({ children: [run(f.original_name, { size: half(PT.caption), color: C.muted })] }));
        } catch (e) {
          console.warn('[export] could not embed image', f.original_name, e.message);
        }
      }
    }
  }

  const doc = new Document({
    // docDefaults: Simplon Norm 11pt, paragraph spacing after 22 / line 260 atLeast (pBody).
    styles: {
      default: {
        document: {
          run: { font: FONT, size: half(PT.body), color: C.ink },
          paragraph: { spacing: { after: 22, line: 260, lineRule: LineRuleType.AT_LEAST } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // US Letter (pgSz)
          // pgMar: top 1800, right 1080, bottom 1166, left 1080, header 720, footer 403.
          margin: { top: 1800, right: 1080, bottom: 1166, left: 1080, header: 720, footer: 403 }
        }
      },
      children
    }]
  });
  return Packer.toBuffer(doc);
}

// --- Account summary docx ---
// Renders the normalized `assemble()` model (the SAME model the account PDF uses)
// into a branded docx. This is the ACCOUNT export — selectable sections, not the
// fixed POV document. `renderDocx` above stays reserved for the POV export.
async function renderAccountDocx(account, items) {
  const docx = require('docx');
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    WidthType, BorderStyle, ShadingType, VerticalAlign, ImageRun, LineRuleType
  } = docx;

  const run = (text, o = {}) => new TextRun({ text: String(text == null ? '' : text), size: o.size || half(PT.body), bold: !!o.bold, color: o.color || C.ink, font: o.font });
  const inlineRuns = (text, base = {}) =>
    String(text == null ? '' : text).split(/(\*\*[^*]+\*\*)/g).filter(p => p !== '').map(p => {
      const m = /^\*\*([^*]+)\*\*$/.exec(p);
      return run(m ? m[1] : p, { ...base, bold: m ? true : base.bold });
    });
  const glyphs = (s) => String(s).replace(/\[ \]/g, '☐').replace(/\[x\]/gi, '☑');
  const bodyPara = (text) => new Paragraph({
    spacing: { before: 80, after: 40, line: 260, lineRule: LineRuleType.AT_LEAST },
    children: inlineRuns(glyphs(text), { size: half(PT.body) })
  });

  const gridBorders = () => {
    const b = { style: BorderStyle.SINGLE, size: 4, color: C.border };
    return { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b };
  };
  const cellMargins = { top: 40, bottom: 40, left: 108, right: 108 };
  const cellPara = (kids) => new Paragraph({ spacing: { before: 40, after: 40, line: 260, lineRule: LineRuleType.AT_LEAST }, children: kids });
  const dataCell = (text, fill) => new TableCell({
    shading: { fill, type: ShadingType.CLEAR, color: 'auto' }, margins: cellMargins, verticalAlign: VerticalAlign.TOP,
    children: [cellPara(inlineRuns(glyphs(String(text == null ? '' : text)), { size: half(PT.body) }))]
  });
  const headerCell = (text) => new TableCell({
    shading: { fill: C.headerFill, type: ShadingType.CLEAR, color: 'auto' }, margins: cellMargins, verticalAlign: VerticalAlign.TOP,
    children: [cellPara([run(text, { size: half(PT.body), bold: true, color: C.white })])]
  });
  const brandedTable = (headers, rows) => new Table({
    width: { size: TABLE_W, type: WidthType.DXA }, borders: gridBorders(),
    rows: [
      new TableRow({ tableHeader: true, children: headers.map(h => headerCell(h)) }),
      ...rows.map((r, i) => new TableRow({ children: r.map(c => dataCell(c, i % 2 ? C.greyRow : C.white)) }))
    ]
  });

  const sectionHeading = (title, internal) => new Paragraph({
    spacing: { before: 280, after: 200, line: 252, lineRule: LineRuleType.AUTO },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, space: 8, color: C.blue } },
    children: [run(title, { bold: true, color: internal ? C.internal : C.navy, size: half(PT.h2) })]
  });
  const subHeading = (title) => new Paragraph({
    spacing: { before: 160, after: 40 }, children: [run(title, { bold: true, color: C.heading3, size: half(PT.h3) })]
  });
  const pushLines = (children, text) => {
    for (const ln of String(text == null ? '' : text).split('\n')) if (ln.trim()) children.push(bodyPara(ln));
  };

  const children = [];
  // Title + engagement metadata.
  children.push(new Paragraph({ spacing: { after: 40 }, children: [run(`${account.account_name || 'Account'} — Account Export`, { bold: true, color: C.navy, size: half(PT.h1) })] }));
  const meta = [
    account.account_executive ? `AE: ${account.account_executive}` : null,
    account.industry ? `Industry: ${account.industry}` : null,
    (account.presales_stage || account.opportunity_stage) ? `Stage: ${account.presales_stage || account.opportunity_stage}` : null
  ].filter(Boolean).join('  ·  ');
  if (meta) children.push(new Paragraph({ spacing: { after: 20 }, children: [run(meta, { size: half(PT.small), color: C.muted })] }));
  children.push(new Paragraph({ spacing: { after: 120 }, children: [run(`Generated ${new Date().toISOString().slice(0, 10)}`, { size: half(PT.small), color: C.muted })] }));

  for (const item of items) {
    if (item.internal) {
      children.push(new Paragraph({ spacing: { before: 280, after: 60 }, children: [run(INTERNAL_LABEL, { bold: true, color: C.internal, size: half(PT.body) })] }));
    }
    children.push(sectionHeading(item.title, item.internal));
    if (item.paragraphs) for (const p of item.paragraphs) pushLines(children, p);
    if (item.table) children.push(brandedTable(item.table.headers, item.table.rows.length ? item.table.rows : [item.table.headers.map(() => '')]));
    if (item.subsections) {
      if (!item.subsections.length) children.push(bodyPara('(none)'));
      for (const sub of item.subsections) {
        children.push(subHeading(sub.heading));
        for (const p of sub.paragraphs) pushLines(children, p);
      }
    }
    if (item.sources && item.sources.length) {
      children.push(subHeading('Sources'));
      for (const u of item.sources) children.push(bodyPara(u));
    }
    if (item.images && item.images.length) {
      for (const f of accountFiles(account.id)) {
        if (!IMG_EXT.has((f.file_type || '').toLowerCase())) continue;
        try {
          const buf = fs.readFileSync(path.join(UPLOAD_ROOT, f.account_id, f.filename));
          const dims = imageDims(buf);
          let width = 450, height = 300;
          if (dims && dims.w && dims.h) { width = Math.min(450, dims.w); height = Math.round((dims.h / dims.w) * width); }
          children.push(new Paragraph({ spacing: { before: 120, after: 20 }, children: [new ImageRun({ data: buf, transformation: { width, height } })] }));
          children.push(new Paragraph({ children: [run(f.original_name, { size: half(PT.caption), color: C.muted })] }));
        } catch (e) {
          console.warn('[export] could not embed image', f.original_name, e.message);
        }
      }
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: half(PT.body), color: C.ink },
          paragraph: { spacing: { after: 22, line: 260, lineRule: LineRuleType.AT_LEAST } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1080, bottom: 1166, left: 1080, header: 720, footer: 403 }
        }
      },
      children
    }]
  });
  return Packer.toBuffer(doc);
}

// --- PDF (HTML for client-side print) ---
function renderHtml(account, items) {
  const parts = [];
  for (const item of items) {
    parts.push(`<h2${item.internal ? ' class="internal"' : ''}>${escapeHtml(item.title)}</h2>`);
    if (item.paragraphs) parts.push(item.paragraphs.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''));
    if (item.table) {
      parts.push('<table><thead><tr>' + item.table.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>' +
        item.table.rows.map(r => '<tr>' + r.map(c => `<td>${escapeHtml(c).replace(/\n/g, '<br>')}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
    }
    if (item.subsections) {
      for (const sub of item.subsections) {
        parts.push(`<h3>${escapeHtml(sub.heading)}</h3>`);
        parts.push(sub.paragraphs.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''));
      }
    }
    if (item.sources && item.sources.length) {
      parts.push('<p class="sources"><strong>Sources:</strong><br>' +
        item.sources.map(u => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`).join('<br>') + '</p>');
    }
    if (item.images && item.images.length) {
      for (const img of item.images) {
        parts.push(`<div style="margin:8px 0;"><img src="/api/files/${img.id}/download" style="max-width:100%; border:1px solid #ccc;" /><div style="font-size:10px;color:#666;">${escapeHtml(img.name)}</div></div>`);
      }
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(account.account_name)} — Export</title>
<style>
@page { size: letter; margin: 1in; }
body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; line-height: 1.5; }
h1 { font-size: 20px; } h2 { font-size: 15px; border-bottom: 1px solid #ccc; padding-bottom: 3px; margin-top: 20px; }
h2.internal { color: #b00000; } h3 { font-size: 13px; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid #999; padding: 5px 7px; text-align: left; vertical-align: top; font-size: 11px; }
th { background: #f0f0f0; }
.sources a { color: #0645ad; word-break: break-all; }
footer { margin-top: 30px; text-align: center; color: #888; font-size: 10px; }
</style></head><body>
<h1>${escapeHtml(account.account_name)} — Account Export</h1>
<p><em>Generated ${new Date().toISOString().slice(0, 10)}</em></p>
${parts.join('\n')}
<footer>© ${new Date().getFullYear()} OPSWAT, Inc. All rights reserved.</footer>
</body></html>`;
}

router.post('/accounts/:id/export', async (req, res, next) => {
  try {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { format, sections, pov_id, kind, include_non_customer_contacts } = req.body || {};
    const sectionKeys = Array.isArray(sections) && sections.length ? sections : Object.keys(SECTION_TITLES);
    const includeNonCustomer = Boolean(include_non_customer_contacts);

    // Two export kinds share this endpoint:
    //   'pov'     — the fixed, branded POV document (no section picker)
    //   'account' — the full account summary across the selected sections
    // Older clients send neither; infer 'pov' only when a pov_id is targeted.
    const isPov = kind === 'pov' || (kind == null && !!pov_id);

    if (format === 'docx') {
      if (isPov) {
        // Branded POV document. pov_id targets a specific draft; else most recent.
        const pov = getPov(account.id, pov_id);
        const buffer = await renderDocx(account, pov, sectionKeys);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${povFilename(account)}"`);
        return res.send(buffer);
      }
      // Full account summary across the selected sections.
      const items = assemble(account, sectionKeys, pov_id, includeNonCustomer);
      const buffer = await renderAccountDocx(account, items);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${accountFilename(account)}"`);
      return res.send(buffer);
    }
    // default: pdf -> HTML for client-side print (section model, both kinds)
    const items = assemble(account, sectionKeys, pov_id, includeNonCustomer);
    return res.json({ html: renderHtml(account, items) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
