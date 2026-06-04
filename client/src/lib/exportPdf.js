function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function exportAccountPdf(account) {
  const w = window.open('', '_blank', 'width=820,height=1000');
  if (!w) {
    alert('Pop-up blocked. Allow pop-ups to export.');
    return;
  }
  const contacts = (account.contacts || []).map(c =>
    `<li>${escapeHtml(c.name)}${c.title ? ` — <span class="muted">${escapeHtml(c.title)}</span>` : ''}</li>`
  ).join('');

  const nextSteps = (account.next_steps || []).map(s =>
    `<li class="${s.completed ? 'done' : ''}">${escapeHtml(s.text)} <span class="tag">${escapeHtml(s.source)}</span></li>`
  ).join('');

  const notes = [...(account.notes || [])]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map(n => `
      <div class="note">
        <h3>${escapeHtml(formatDate(n.date))}</h3>
        <pre>${escapeHtml(n.raw_notes || '')}</pre>
      </div>
    `).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>${escapeHtml(account.account_name)} — SE Notebook Export</title>
<style>
  @page { margin: 0.6in; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #111; background: #fff; line-height: 1.5; font-size: 11pt; }
  h1 { font-size: 22pt; margin: 0 0 4px; }
  h2 { font-size: 13pt; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd; color: #2d5a9e; }
  h3 { font-size: 11pt; margin: 14px 0 4px; color: #333; }
  .subtitle { color: #666; font-size: 10pt; margin-bottom: 12px; }
  .muted { color: #777; }
  ul { margin: 0 0 8px; padding-left: 18px; }
  li { margin: 2px 0; }
  li.done { text-decoration: line-through; color: #888; }
  .tag { font-size: 8pt; background: #eee; color: #555; padding: 1px 5px; border-radius: 3px; margin-left: 4px; }
  pre { white-space: pre-wrap; font-family: inherit; background: #f7f7f7; padding: 8px 10px; border-radius: 4px; border: 1px solid #eee; margin: 0; }
  .note { margin-bottom: 14px; page-break-inside: avoid; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .summary-box { background: #f4f7fc; border-left: 3px solid #2d5a9e; padding: 10px 12px; border-radius: 0 4px 4px 0; margin-top: 6px; white-space: pre-wrap; }
</style></head>
<body>
  <h1>${escapeHtml(account.account_name)}</h1>
  <div class="subtitle">
    ${account.account_executive ? `AE: ${escapeHtml(account.account_executive)}` : ''}
    ${account.industry ? ` · Industry: ${escapeHtml(account.industry)}` : ''}
    ${(account.presales_stage || account.opportunity_stage) ? ` · Stage: ${escapeHtml(account.presales_stage || account.opportunity_stage)}` : ''}
  </div>

  ${account.ai_summary ? `<h2>AI Summary</h2><div class="summary-box">${escapeHtml(account.ai_summary)}</div>` : ''}

  ${(account.ai_technical_drivers || account.ai_environment) ? `
    <div class="grid">
      ${account.ai_technical_drivers ? `<div><h3>Technical Drivers</h3><pre>${escapeHtml(account.ai_technical_drivers)}</pre></div>` : ''}
      ${account.ai_environment ? `<div><h3>Environment</h3><pre>${escapeHtml(account.ai_environment)}</pre></div>` : ''}
    </div>` : ''}

  ${nextSteps ? `<h2>Next Steps</h2><ul>${nextSteps}</ul>` : ''}
  ${contacts ? `<h2>Contacts</h2><ul>${contacts}</ul>` : ''}

  ${notes ? `<h2>Note Log</h2>${notes}` : ''}
</body></html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
  // Wait for layout, then trigger print
  w.onload = () => { w.focus(); w.print(); };
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 500);
}
