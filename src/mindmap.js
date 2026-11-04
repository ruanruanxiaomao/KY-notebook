/* 思维导图：把 AI 给的大纲（缩进列表 / markdown / JSON）变成一棵可折叠的 SVG 树
   数据模型对齐 mind-elixir：{ topic, children: [] }
   布局是自己写的左→右 tidy tree（和 markmap 的阅读方向一致）：先排子树，父节点取子节点中线
   不依赖任何第三方库，导出 PNG 走 SVG → canvas
*/

const FS = 13;            /* 节点字号 */
const NODE_H = 34;
const V_GAP = 12;
const H_GAP = 52;

/* ---------------- 解析 ---------------- */

const mk = (topic, children) => ({ topic: String(topic).trim(), children: children || [] });

/** 文本 → 树。认三种输入：缩进列表（- / * / 1.）、markdown 标题、JSON */
export function parseOutline(text, fallbackTopic) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^[[{]/.test(raw)) {
    try {
      const t = fromJson(JSON.parse(raw));
      if (t) return t;
    } catch (e) { /* 不是合法 JSON，退回大纲解析 */ }
  }
  return fromOutlineText(raw, fallbackTopic);
}

function fromJson(j) {
  const one = (o) => {
    if (!o || typeof o !== 'object') return null;
    const topic = o.topic || o.name || o.title || o.text || o.label;
    if (topic === undefined || topic === null || String(topic).trim() === '') return null;
    const kids = o.children || o.child || o.nodes || o.items || [];
    return mk(topic, Array.isArray(kids) ? kids.map(one).filter(Boolean) : []);
  };
  if (Array.isArray(j)) {
    const kids = j.map(one).filter(Boolean);
    if (!kids.length) return null;
    return kids.length === 1 ? kids[0] : mk('思维导图', kids);
  }
  return one(j);
}

function cleanLine(s) {
  return String(s)
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')       /* 复选框 */
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

function fromOutlineText(text, fallbackTopic) {
  const items = [];
  let fence = false;
  text.split(/\r?\n/).forEach((ln) => {
    if (/^\s*```/.test(ln)) { fence = !fence; return; }
    if (fence) return;
    const s = ln.replace(/\t/g, '  ');
    if (!s.trim()) return;
    const h = s.match(/^\s*(#{1,6})\s+(.+)$/);
    if (h) { items.push({ lvl: h[1].length - 1, text: cleanLine(h[2]) }); return; }
    const b = s.match(/^(\s*)(?:[-*+•]|\d+[.)])\s+(.+)$/);
    if (b) { items.push({ lvl: Math.floor(b[1].length / 2), text: cleanLine(b[2]) }); return; }
    items.push({ lvl: 0, text: cleanLine(s) });
  });
  const list = items.filter((it) => it.text);
  if (!list.length) return null;

  /* 缩进偶尔会跳级（只缩进 1 个空格），把出现过的层级压成连续整数 */
  const uniq = Array.from(new Set(list.map((i) => i.lvl))).sort((a, b) => a - b);
  const norm = (v) => uniq.indexOf(v);

  const holder = mk('', []);
  const stack = [{ n: holder, lvl: -1 }];
  list.forEach((it) => {
    const lvl = norm(it.lvl);
    while (stack.length > 1 && stack[stack.length - 1].lvl >= lvl) stack.pop();
    const n = mk(it.text, []);
    stack[stack.length - 1].n.children.push(n);
    stack.push({ n, lvl });
  });

  const top = holder.children;
  if (!top.length) return null;
  if (top.length === 1) return top[0];                       /* 第一行就是中心主题 */
  return mk(fallbackTopic || '思维导图', top);
}

/** 树 → markdown 大纲（- 缩进两格），导出/复制用 */
export function toOutline(root, lvl) {
  const out = [];
  const walk = (n, d) => {
    out.push('  '.repeat(d) + '- ' + n.topic);
    (n.children || []).forEach((k) => walk(k, d + 1));
  };
  if (root) walk(root, lvl || 0);
  return out.join('\n');
}

/* ---------------- 布局 ---------------- */

function textWidth(s, fs) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c > 0x2e7f && c < 0xa000) || (c >= 0xff00 && c <= 0xffef) ? fs : fs * 0.56;
  }
  return w;
}

/** 左→右 tidy 布局；折叠的节点不展开子树 */
export function layoutTree(root) {
  const nodes = [];
  const links = [];
  let cursor = 0;

  const walk = (n, depth, parent) => {
    const kids = n.collapsed ? [] : (n.children || []);
    const w = Math.max(46, Math.round(textWidth(n.topic, FS)) + 24);
    /* 先把自己登记好再排子树，否则子节点拿不到父的位置，连线会全丢 */
    const item = {
      topic: n.topic, depth, y: 0, w, h: NODE_H, ref: n,
      kids: (n.children || []).length, folded: !!n.collapsed,
    };
    n._item = item;
    nodes.push(item);
    if (parent && parent._item) links.push({ from: parent._item, to: item });

    if (!kids.length) {
      item.y = cursor + NODE_H / 2;
      cursor += NODE_H + V_GAP;
    } else {
      const ys = kids.map((k) => walk(k, depth + 1, n));
      item.y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    return item.y;
  };
  walk(root, 0, null);

  const colW = [];
  nodes.forEach((o) => { colW[o.depth] = Math.max(colW[o.depth] || 0, o.w); });
  const xs = [0];
  for (let i = 1; i < colW.length; i++) xs[i] = xs[i - 1] + colW[i - 1] + H_GAP;
  let maxX = 0;
  nodes.forEach((o) => {
    o.x = xs[o.depth] || 0;
    maxX = Math.max(maxX, o.x + o.w);
  });
  return { nodes, links, w: maxX + 24, h: Math.max(cursor, NODE_H + 24) + 12 };
}

/* ---------------- 渲染 ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const FILL = ['#8b2f2f', '#f3e9db', '#fdfaf3', '#fdfaf3', '#fdfaf3'];
const TEXT = ['#fff', '#3d342b', '#3d342b', '#3d342b', '#3d342b'];

function el(name, attrs) {
  const n = document.createElementNS(SVG_NS, name);
  Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
  return n;
}

/**
 * 把树画进 host（会被清空重建）。
 * 返回 { setRoot, exportSvg, exportPng, fit, outline }
 */
export function renderMap(host, root, opts) {
  const o = Object.assign({ onToggle: null }, opts || {});
  let tree = root;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let svg = null;
  let gRoot = null;
  let size = { w: 0, h: 0 };

  function applyTransform() {
    if (gRoot) gRoot.setAttribute('transform', `translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${scale.toFixed(3)})`);
  }

  function draw() {
    host.innerHTML = '';
    const L = layoutTree(tree);
    size = { w: L.w, h: L.h };
    svg = el('svg', {
      class: 'mm-svg', xmlns: SVG_NS,
      viewBox: `0 0 ${Math.max(1, L.w)} ${Math.max(1, L.h)}`,
      preserveAspectRatio: 'xMidYMid meet',
    });
    gRoot = el('g', {});
    svg.appendChild(gRoot);

    /* 连线先画，压在节点下面 */
    L.links.forEach((lk) => {
      const x1 = lk.from.x + lk.from.w;
      const y1 = lk.from.y;
      const x2 = lk.to.x;
      const y2 = lk.to.y;
      const dx = Math.max(18, (x2 - x1) * 0.55);
      gRoot.appendChild(el('path', {
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        fill: 'none', stroke: '#cbb79a', 'stroke-width': 1.6, 'stroke-linecap': 'round',
      }));
    });

    L.nodes.forEach((n) => {
      const g = el('g', { class: 'mm-node', 'data-depth': n.depth, style: 'cursor:pointer' });
      const fill = FILL[Math.min(n.depth, FILL.length - 1)];
      const color = TEXT[Math.min(n.depth, TEXT.length - 1)];
      g.appendChild(el('rect', {
        x: n.x, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 9,
        fill, stroke: n.depth === 0 ? '#6f2424' : '#e3d8c6', 'stroke-width': 1,
      }));
      const t = el('text', {
        x: n.x + 12, y: n.y + FS * 0.36, 'font-size': FS,
        fill: color, 'font-family': 'inherit',
      });
      t.textContent = n.topic;
      g.appendChild(t);
      if (n.kids) {
        const cx = n.x + n.w + 9;
        g.appendChild(el('circle', {
          cx, cy: n.y, r: 7.5, fill: n.folded ? '#8b2f2f' : '#fff',
          stroke: n.folded ? '#6f2424' : '#c9b89f', 'stroke-width': 1.2,
        }));
        const sign = el('text', {
          x: cx, y: n.y + 3.6, 'font-size': 10, 'text-anchor': 'middle',
          fill: n.folded ? '#fff' : '#8a7c69', 'font-family': 'inherit',
        });
        sign.textContent = n.folded ? String(n.kids) : '−';
        g.appendChild(sign);
      }
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!n.kids) return;
        n.ref.collapsed = !n.ref.collapsed;
        draw();
        applyTransform();
        if (o.onToggle) o.onToggle(n.ref);
      });
      gRoot.appendChild(g);
    });

    host.appendChild(svg);
    applyTransform();
  }

  /* 滚轮缩放（以指针为中心）+ 拖动平移 */
  host.addEventListener('wheel', (e) => {
    if (!svg) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * size.w;
    const py = (e.clientY - r.top) / r.height * size.h;
    const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(3, Math.max(0.35, scale * k));
    tx = px - (px - tx) * (next / scale);
    ty = py - (py - ty) * (next / scale);
    scale = next;
    applyTransform();
  }, { passive: false });

  let drag = null;
  host.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mm-node')) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    host.setPointerCapture(e.pointerId);
  });
  host.addEventListener('pointermove', (e) => {
    if (!drag || !svg) return;
    const r = svg.getBoundingClientRect();
    tx = drag.tx + (e.clientX - drag.x) / r.width * size.w;
    ty = drag.ty + (e.clientY - drag.y) / r.height * size.h;
    applyTransform();
  });
  host.addEventListener('pointerup', () => { drag = null; });

  function fit() { scale = 1; tx = 0; ty = 0; applyTransform(); }

  function exportSvg() {
    const clone = svg.cloneNode(true);
    clone.setAttribute('width', Math.ceil(size.w));
    clone.setAttribute('height', Math.ceil(size.h));
    clone.setAttribute('viewBox', `0 0 ${Math.ceil(size.w)} ${Math.ceil(size.h)}`);
    const g = clone.querySelector('g');
    if (g) g.removeAttribute('transform');
    clone.querySelectorAll('.mm-node').forEach((n) => n.removeAttribute('style'));
    /* 白底，避免导出透明 */
    const bg = el('rect', { x: 0, y: 0, width: Math.ceil(size.w), height: Math.ceil(size.h), fill: '#fffdf8' });
    clone.insertBefore(bg, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  async function exportPng(k) {
    const ratio = k || 2;
    const text = exportSvg();
    const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('导图转图片失败'));
        im.src = url;
      });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(size.w * ratio));
      c.height = Math.max(1, Math.round(size.h * ratio));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fffdf8';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  }

  draw();
  return {
    setRoot(next) { tree = next; scale = 1; tx = 0; ty = 0; draw(); },
    getRoot: () => tree,
    fit, exportSvg, exportPng,
    get size() { return { w: size.w, h: size.h, scale }; },
  };
}
