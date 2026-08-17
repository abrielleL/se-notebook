import React from 'react';

// Lightweight, dependency-free markdown renderer.
// Turns AI/markdown text into clean styled JSX so raw symbols
// (**bold**, ##, -, `code`, links) never show through to the user.
// Display-only: emits React nodes, no dangerouslySetInnerHTML.

// ─── inline: bold, italic, code, links ───────────────────────────────────────
const INLINE_RE = /(\*\*|__)(.+?)\1|(\*|_)(?=\S)(.+?)(?<=\S)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/;

function renderInline(text, keyBase) {
  const nodes = [];
  let rest = String(text);
  let i = 0;
  while (rest.length) {
    const m = rest.match(INLINE_RE);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[2] != null) {
      nodes.push(<strong key={key} className="font-semibold text-text-primary">{renderInline(m[2], key)}</strong>);
    } else if (m[4] != null) {
      nodes.push(<em key={key} className="italic">{renderInline(m[4], key)}</em>);
    } else if (m[5] != null) {
      nodes.push(<code key={key} className="font-mono text-[0.9em] px-1 py-0.5 rounded bg-ai-inset border border-border-inset text-accent-blue">{m[5]}</code>);
    } else if (m[6] != null) {
      nodes.push(
        <a key={key} href={m[7]} target="_blank" rel="noreferrer" className="text-accent-blue hover:underline break-words">{m[6]}</a>
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return nodes;
}

// Strip markdown to clean plaintext — for clamped previews/snippets
// where full block rendering would break line-clamp.
export function stripMarkdown(src) {
  return String(src == null ? '' : src)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => a || b)
    .replace(/\*(.+?)\*|_(.+?)_/g, (_, a, b) => a || b)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    // drop table separator rows and horizontal rules entirely
    .replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/gm, '')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    // flatten remaining table rows to " · "-separated text
    .replace(/^\s*\|(.+)\|\s*$/gm, (_, inner) => inner.split('|').map(s => s.trim()).join(' · '))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*(\d+)[.)]\s+/gm, '$1. ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HEADING_SIZES = ['text-[15px]', 'text-[14px]', 'text-[13px]', 'text-[12px]', 'text-[12px]', 'text-[12px]'];

// ─── table helpers ────────────────────────────────────────────────────────────
// Split a pipe-delimited row into trimmed cells, tolerating optional
// leading/trailing pipes.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}
// A GitHub table separator row: cells of dashes with optional alignment colons,
// e.g. `| --- | :--: |`. Must contain a pipe so a bare `---` stays a rule.
function isTableSeparator(line) {
  const s = line.trim();
  return s.includes('|') && /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(s);
}

// ─── block parsing ────────────────────────────────────────────────────────────
function parseBlocks(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null; // { ordered, items: [] }

  const flushPara = () => {
    if (para.length) { blocks.push({ type: 'p', lines: para }); para = []; }
  };
  const flushList = () => {
    if (list) { blocks.push({ type: 'list', ordered: list.ordered, items: list.items }); list = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const isHr = /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed);
    const isTableHeader = trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]);

    if (isTableHeader) {
      flushPara(); flushList();
      const header = splitRow(line);
      const rows = [];
      i += 2; // consume header + separator
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--; // step back so the for-loop's i++ lands on the next unprocessed line
      blocks.push({ type: 'table', header, rows });
    } else if (isHr) {
      flushPara(); flushList();
      blocks.push({ type: 'hr' });
    } else if (heading) {
      flushPara(); flushList();
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] });
    } else if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      const item = (bullet ? bullet[1] : numbered[1]);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(item);
    } else if (trimmed === '') {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return blocks;
}

export default function Markdown({ children, className = '' }) {
  const text = (children == null ? '' : String(children)).trim();
  if (!text) return null;
  const blocks = parseBlocks(text);

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {blocks.map((b, bi) => {
        if (b.type === 'hr') {
          return <hr key={bi} className="border-0 border-t border-border my-1" />;
        }
        if (b.type === 'table') {
          const cols = b.header.length;
          return (
            <div key={bi} className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr>
                    {b.header.map((c, ci) => (
                      <th key={ci} className="border border-border bg-ai-inset px-2 py-1 font-semibold text-text-primary align-top break-words">
                        {renderInline(c, `th${bi}-${ci}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={ri}>
                      {Array.from({ length: cols }).map((_, ci) => (
                        <td key={ci} className="border border-border px-2 py-1 align-top break-words">
                          {renderInline(r[ci] || '', `td${bi}-${ri}-${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.type === 'h') {
          return (
            <div key={bi} className={`font-semibold text-text-primary ${HEADING_SIZES[b.level - 1]} ${bi === 0 ? '' : 'mt-1'}`}>
              {renderInline(b.text, `h${bi}`)}
            </div>
          );
        }
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={bi} className={`flex flex-col gap-1 pl-1 ${b.ordered ? '' : ''}`}>
              {b.items.map((it, ii) => (
                <li key={ii} className="flex gap-2">
                  <span className="text-text-dim select-none shrink-0">{b.ordered ? `${ii + 1}.` : '•'}</span>
                  <span className="min-w-0 break-words">{renderInline(it, `l${bi}-${ii}`)}</span>
                </li>
              ))}
            </Tag>
          );
        }
        // paragraph — preserve intra-block line breaks
        return (
          <p key={bi} className="break-words leading-relaxed">
            {b.lines.map((ln, li) => (
              <React.Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(ln, `p${bi}-${li}`)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
