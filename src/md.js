/* 轻量 Markdown → HTML（够用就好），再交给 MathJax 排公式 */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return t;
}

function tableToHtml(rows) {
  const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((x) => x.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  let h = '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
  body.forEach((r) => {
    h += '<tr>' + head.map((_, i) => `<td>${inline(r[i] || '')}</td>`).join('') + '</tr>';
  });
  return h + '</tbody></table>';
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let list = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      closeList();
      const rows = [line];
      i++;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
      out.push(tableToHtml(rows));
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list && list !== want) closeList();
      if (!list) { list = want; out.push(`<${want}>`); }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>');
      i++;
      continue;
    }
    closeList();
    out.push('<p>' + inline(line) + '</p>');
    i++;
  }
  closeList();
  return out.join('\n');
}

/** 把 Markdown 渲染进容器，并让 MathJax 排版 */
export function mdInto(el, md) {
  if (!el) return Promise.resolve();
  el.innerHTML = renderMarkdown(md) || '<div class="ph">（空）</div>';
  return typeset(el);
}

export function typeset(el) {
  const MJ = window.MathJax;
  if (!MJ || !MJ.typesetPromise) return Promise.resolve();
  return MJ.typesetPromise(el ? [el] : undefined).catch(() => {});
}

/** 数学区段之外裸写的 LaTeX 间距命令（模型常写 \quad 分隔选项），换成普通空格 */
function stripBareLatex(text) {
  return String(text || '').split(/(\$\$[\s\S]*?\$\$|\$[^$\n]*\$)/).map((seg, i) => {
    if (i % 2 === 1) return seg; // 交替：数学区段原样保留
    return seg.replace(/\\(quad|qquad|;|,|!|:)(?![a-zA-Z])/g, ' ');
  }).join('');
}

/** 把流式文本里的常见噪声清掉 */
export function tidyAI(text) {
  const clean = String(text || '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/^\s*```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim();
  return stripBareLatex(clean);
}
