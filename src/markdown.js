// Just enough Markdown to read an agent's reply.
//
// The reply is model output, so it is untrusted: everything is escaped before
// any tag is inserted, and the only tags that can appear are ones written here.
// Links keep their label and lose their href — the panel lives inside T3 Code's
// renderer, where an anchor is a navigation the app did not ask for.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Inline spans inside one line of text. Escaped first, formatted second. */
function inline(text) {
  let s = esc(text);
  // Inline code first, held aside: its contents must not be read as emphasis.
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (m, code) => `\u0000${codes.push(code) - 1}\u0000`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // Bold is gone by now, so a remaining pair of asterisks is emphasis.
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    /^https?:\/\//i.test(url) ? `<span class="md-link" title="${url}">${label}</span>` : label);
  // The other way model output writes a link: `<https://…>`, which markdown
  // reads as an autolink. Rendered bare it would keep its angle brackets.
  s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<span class="md-link" title="$1">$1</span>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code class="md-ic">${codes[Number(i)] ?? ''}</code>`);
  return s;
}

/**
 * The reply as HTML: escaped, then paragraphs, lists, headings, quotes and
 * fenced code. Unknown syntax stays as the text the model wrote.
 */
export function markdownMarkup(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    out.push(`<div class="md-p">${inline(para.join('\n')).replace(/\n/g, '<br>')}</div>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const code = [];
      for (i += 1; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i += 1) code.push(lines[i]);
      out.push(`<pre class="md-code">${esc(code.join('\n'))}</pre>`);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = Math.min(3, heading[1].length);
      out.push(`<div class="md-h md-h${level}">${inline(heading[2])}</div>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      // Ordered lists keep their numbers; bullets are bullets.
      const tag = /^\s*\d+[.)]\s+/.test(line) ? 'ol' : 'ul';
      const items = [];
      const marker = tag === 'ol' ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      for (; i < lines.length && marker.test(lines[i]); i += 1) {
        items.push(`<li>${inline(lines[i].replace(marker, ''))}</li>`);
      }
      i -= 1;
      out.push(`<${tag} class="md-list">${items.join('')}</${tag}>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i += 1) rows.push(lines[i]);
      i -= 1;
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const separator = rows.findIndex((row) => cells(row).every((cell) => /^:?-{2,}:?$/.test(cell)));
      const head = separator > 0 ? cells(rows[0]) : null;
      const body = rows
        .filter((row, at) => at !== separator && !(separator > 0 && at === 0))
        .map(cells);
      const headMarkup = head
        ? `<thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`
        : '';
      const bodyMarkup = body
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table class="md-table">${headMarkup}<tbody>${bodyMarkup}</tbody></table>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      out.push(`<div class="md-quote">${inline(line.replace(/^\s*>\s?/, ''))}</div>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      out.push('<div class="md-rule"></div>');
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('');
}

/** The same text as one readable line — for row summaries, where markup is noise. */
export function plainText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/<(https?:\/\/[^\s>]+)>/g, '$1')
    .replace(/^\s*(#{1,6}|[-*+]|>|\d+[.)])\s+/gm, '')
    // A pair cut in half by the preview's own truncation, or emphasis the model
    // opened and never closed: the markers are noise in a one-line summary.
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
