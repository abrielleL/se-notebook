// Word export of one deal's QUANtum deal review: the same 13 sections and
// questions as the tab, each with its check state, answer, and supporting
// quote. Built to be sent to the AE ahead of a deal review meeting, so
// unanswered questions are kept in (an empty box is the point) and red flags
// are pulled up into the summary.

const { FONT, C, PT, half } = require('./docBrand');

const STATUS = {
  answered:   { box: '☑', color: C.green },
  clear:      { box: '☑', color: C.green, label: 'Clear' },
  partial:    { box: '◐', color: 'B35C00', label: 'Partial' },
  na:         { box: '–', color: C.muted, label: 'N/A' },
  flagged:    { box: '☒', color: C.redUrgent, label: 'Red flag present' },
  unanswered: { box: '☐', color: C.muted }
};
const VOICE_LABEL = { customer: 'Customer’s words', team: 'Team’s read', inferred: 'Inferred', app: 'From records' };
const SOURCE_LABEL = { note: 'Note', transcript: 'Transcript', internal_call: 'Internal call', manual: 'Added by hand', app: 'Notebook records' };

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Same wording the tab shows for the facts the app works out itself.
function computedText(kind, f) {
  if (!f) return null;
  if (kind === 'age') return f.age_days == null ? null : `${f.age_days} days (opened ${fmtDate(f.created_at)})`;
  if (kind === 'days_in_stage') {
    if (f.days_in_stage == null) return null;
    return `${f.presales_stage || 'No stage'} for ${f.days_in_stage_is_floor ? 'at least ' : ''}${f.days_in_stage} day${f.days_in_stage === 1 ? '' : 's'}`;
  }
  if (kind === 'slips') {
    const pushes = f.close_date_pushes || [];
    if (!pushes.length) return 'No close-date pushes recorded';
    return `${f.quarter_slips} quarter slip${f.quarter_slips === 1 ? '' : 's'} · ${pushes.length} push${pushes.length === 1 ? '' : 'es'} (${pushes.map(p => `${fmtDate(p.from)} → ${fmtDate(p.to)}`).join(', ')})`;
  }
  return null;
}

function sourceLine(a) {
  const parts = [];
  if (a.voice) parts.push(VOICE_LABEL[a.voice]);
  const label = a.source_type === 'internal_call'
    ? `Internal call${a.source_label ? `: ${a.source_label}` : ''}`
    : (a.source_label || SOURCE_LABEL[a.source_type]);
  if (label) parts.push(label.trim());
  if (a.source_date) parts.push(fmtDate(a.source_date));
  // Lets two exports of the same deal (local trial vs. Claude) be told apart.
  if (a.updated_by === 'ai' && a.ai_model && a.ai_model !== 'app') parts.push(`AI: ${a.ai_model.startsWith('local:') ? 'Local model' : 'Claude'}`);
  return parts.join(' · ');
}

async function renderDealReviewDocx({ account, opportunity, sections, answers, forecast, showOpportunity }) {
  const {
    Document, Packer, Paragraph, TextRun, BorderStyle, LineRuleType, Footer, AlignmentType, PageNumber
  } = require('docx');

  const run = (text, o = {}) => new TextRun({
    text: String(text == null ? '' : text), size: o.size || half(PT.body), bold: !!o.bold,
    italics: !!o.italics, color: o.color || C.ink, font: o.font
  });
  // **bold** inline, matching the other exports; answers are plain sentences
  // but the occasional emphasis survives.
  const inlineRuns = (text, base = {}) =>
    String(text == null ? '' : text).split(/(\*\*[^*]+\*\*)/g).filter(p => p !== '').map(p => {
      const m = /^\*\*([^*]+)\*\*$/.exec(p);
      return run(m ? m[1] : p, { ...base, bold: m ? true : base.bold });
    });
  // keepNext holds a heading or question on the same page as what follows it.
  const para = (children, spacing = {}, indent, keepNext = false) => new Paragraph({
    spacing: { before: 0, after: 0, line: 260, lineRule: LineRuleType.AT_LEAST, ...spacing },
    indent, keepNext, children
  });

  const statusOf = (q) => (answers[q.key] && answers[q.key].status) || 'unanswered';
  const all = sections.flatMap(s => s.questions.map(q => ({ q, s })));
  const count = (pred) => all.filter(({ q }) => pred(statusOf(q))).length;
  const resolved = count(st => st === 'answered' || st === 'clear' || st === 'na');
  const partial = count(st => st === 'partial');
  const flags = all.filter(({ q }) => statusOf(q) === 'flagged');

  const children = [];

  // Title block, in the doc's own words.
  children.push(para([run('QUANtum Deal Review', { bold: true, color: C.navy, size: half(PT.h1 + 4) })], { after: 80 }));
  children.push(para([
    run(account.account_name, { bold: true, color: C.blue, size: half(PT.h2) }),
    ...(showOpportunity ? [run(`  ·  ${opportunity.name}`, { color: C.navy, size: half(PT.h2) })] : [])
  ], { after: 60 }));
  const facts = [
    account.ae_name || account.account_executive ? `AE: ${account.ae_name || account.account_executive}` : null,
    opportunity.presales_stage ? `Stage: ${opportunity.presales_stage}` : null,
    opportunity.close_date ? `Close: ${fmtDate(opportunity.close_date)}` : null,
    opportunity.opportunity_value != null ? `$${Number(opportunity.opportunity_value).toLocaleString()}` : null,
    `Generated ${fmtDate(new Date().toISOString().slice(0, 10))}`
  ].filter(Boolean);
  children.push(para([run(facts.join('   ·   '), { color: C.muted, size: half(PT.small) })], { after: 240 }));

  // Summary.
  const sectionHeading = (text) => para([run(text, { bold: true, color: C.navy, size: half(PT.h2 + 2) })], { before: 360, after: 160 }, undefined, true);
  children.push(new Paragraph({
    spacing: { before: 120, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, space: 6, color: C.blue } },
    children: [run('SUMMARY', { bold: true, color: C.navy, size: half(PT.h2) })]
  }));
  children.push(para([
    run(`${resolved} of ${all.length} questions resolved`, { bold: true }),
    run(`   ·   ${partial} partial   ·   `),
    run(`${flags.length} red flag${flags.length === 1 ? '' : 's'}`, { bold: !!flags.length, color: flags.length ? C.redUrgent : C.ink })
  ], { after: 80 }));
  for (const { q } of flags) {
    const a = answers[q.key];
    children.push(para([
      run('☒  ', { color: C.redUrgent }),
      run(q.text, { bold: true }),
      ...(a && a.answer ? [run(` — ${a.answer}`)] : [])
    ], { before: 40 }, { left: 360, hanging: 300 }));
  }
  children.push(para([run(
    `Key: ☑ answered or clear   ◐ partial   ☐ not yet answered   – N/A   ☒ red flag present`,
    { color: C.muted, size: half(PT.caption) }
  )], { before: 160 }));

  // Sections.
  const questionBlock = (q) => {
    const a = answers[q.key];
    const st = STATUS[statusOf(q)] || STATUS.unanswered;
    const out = [];
    const labelRuns = st.label
      ? [run(`   ${st.label}`, { bold: true, color: st.color, size: half(PT.small) })]
      : [];
    out.push(para([
      run(`${st.box}  `, { color: st.color, size: half(PT.body + 1) }),
      ...inlineRuns(q.text, { bold: q.headline, color: q.headline ? C.navy : C.ink }),
      ...labelRuns
    ], { before: q.headline ? 120 : 100 }, { left: 360, hanging: 360 }, !!(a && (a.answer || a.evidence)) || !!q.computed));

    const computed = q.computed ? computedText(q.computed, forecast) : null;
    if (computed) {
      out.push(para([run(computed, { color: C.blue })], { before: 40 }, { left: 360 }));
    }
    if (a && a.answer) {
      for (const line of String(a.answer).split('\n').filter(l => l.trim())) {
        out.push(para(inlineRuns(line.replace(/^[-•*]\s+/, '• ')), { before: 40 }, { left: 360 }, !!a.evidence));
      }
    }
    if (a && a.evidence) {
      out.push(para([run(`“${a.evidence}”`, { italics: true, color: C.emphasis, size: half(PT.small) })], { before: 40 }, { left: 540 }));
    }
    if (a && (a.answer || a.evidence) && sourceLine(a)) {
      out.push(para([run(`— ${sourceLine(a)}`, { color: C.muted, size: half(PT.caption) })], { before: 20 }, { left: 540 }));
    }
    return out;
  };

  for (const s of sections) {
    children.push(sectionHeading(`${s.number}. ${s.title}`));
    const [head, ...deeper] = s.questions;
    children.push(...questionBlock(head));
    if (deeper.length) {
      children.push(para([run('GO DEEPER', { bold: true, color: C.blue, size: half(PT.caption) })], { before: 200, after: 20 }, { left: 360 }, true));
      for (const q of deeper) children.push(...questionBlock(q));
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
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 720, footer: 403 }
        }
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              run(`${account.account_name} — Deal review — Page `, { color: C.muted, size: half(PT.footer) }),
              new TextRun({ children: [PageNumber.CURRENT], color: C.muted, size: half(PT.footer), font: FONT })
            ]
          })]
        })
      },
      children
    }]
  });
  return Packer.toBuffer(doc);
}

function dealReviewFilename(account, opportunity, showOpportunity) {
  const safe = (s) => String(s || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  const date = new Date().toISOString().slice(0, 10);
  const name = showOpportunity ? `${safe(account.account_name)}_${safe(opportunity.name)}` : safe(account.account_name);
  return `DealReview_${name || 'Account'}_${date}.docx`;
}

module.exports = { renderDealReviewDocx, dealReviewFilename };
