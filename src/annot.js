/* 图片 / PDF 批注：导入 → 在页面上写字 → 导出 / 让 AI 解析本页
   M2 新增：
   - PDF 文字层：page.getTextContent() 抽字，按 y 聚行、按行距聚段，点段落 → 原页对应位置画高亮矩形
   - 每段可「AI 解析这段」「翻译这段」（复用 prompts.js + ai.js）
   - 「存为笔记」把当前页（含笔迹）存进笔记本，并带上来源 note.src
*/
import { InkBoard, PAGE_W, PAGE_H, imageToDataUrl, loadImageFile } from './inkboard.js';
import { chat, cfgOk } from './ai.js';
import { getPrompts, composePrompt, promptById } from './prompts.js';
import { mdInto, tidyAI } from './md.js';
import { noteSink } from './notebook.js';

export function initAnnot() {
  const $ = (id) => document.getElementById(id);
  const board = new InkBoard($('annotCv'), $('annotPaper'), $('annotStage'));
  const hl = $('annotHl');
  const st = { pages: [], idx: 0, zoom: 1, kind: '', name: '', sel: -1 };
  $('annotBg').hidden = true;

  board.onChange = () => { if (st.pages[st.idx]) st.pages[st.idx].strokes = board.getStrokes(); };

  /* ---------- 提示词下拉 ---------- */
  function fillPrompts() {
    const list = getPrompts();
    const sel = $('annotPrompt');
    sel.innerHTML = '';
    list.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    const last = localStorage.getItem('kynb_annot_prompt');
    if (last && list.some((p) => p.id === last)) sel.value = last;
  }
  fillPrompts();
  $('annotPrompt').onchange = () => localStorage.setItem('kynb_annot_prompt', $('annotPrompt').value);
  window.__kynbFillAnnotPrompts = fillPrompts;

  /* ---------- 载入 ---------- */
  function setPages(pages, kind, name) {
    st.pages = pages;
    st.idx = 0;
    st.kind = kind;
    st.name = name || '';
    showPage(0);
  }

  function showPage(i) {
    if (!st.pages.length) return;
    st.idx = Math.max(0, Math.min(st.pages.length - 1, i));
    const p = st.pages[st.idx];
    board.setZoom(st.zoom);
    board.loadPage({ template: 'blank', bg: p.bg, strokes: p.strokes || [] });
    board.zoom = st.zoom;
    board.layout();
    $('annotPageInfo').textContent = `${st.idx + 1} / ${st.pages.length}`;
    st.sel = -1;
    hl.hidden = true;
    renderText();
  }

  async function pickImage(file) {
    try {
      const img = await loadImageFile(file);
      setPages([{
        bg: imageToDataUrl(img, 1800, 0.88), strokes: [],
        iw: img.naturalWidth, ih: img.naturalHeight, paras: [], chars: 0,
      }], 'image', file.name);
      $('annotStatus').textContent = '已载入图片，可以直接写';
    } catch (e) { $('annotStatus').textContent = e.message || String(e); }
  }

  async function pickPdf(file) {
    const lib = window.pdfjsLib;
    if (!lib) { $('annotStatus').textContent = 'pdf.js 还没加载好（需要联网一次）'; return; }
    $('annotStatus').textContent = '正在解析 PDF…';
    try {
      const buf = await file.arrayBuffer();
      lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
      const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      const pages = [];
      let withText = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min(2.2, 1800 / vp0.width);
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        /* 文字层：抽不出来（扫描件）也不报错，按空处理 */
        let paras = [];
        let chars = 0;
        try {
          const tc = await page.getTextContent();
          const r = itemsToParas(tc.items || [], vp0);
          paras = r.paras;
          chars = r.chars;
          if (chars >= 50) withText++;
        } catch (e) { /* 没有文字层就当扫描件 */ }

        pages.push({
          bg: c.toDataURL('image/jpeg', 0.85), strokes: [],
          iw: vp.width, ih: vp.height, paras, chars,
        });
        $('annotStatus').textContent = `正在解析 PDF… ${i}/${pdf.numPages}`;
      }
      setPages(pages, 'pdf', file.name);
      $('annotStatus').textContent = `已载入 ${pages.length} 页（${withText} 页有文字层），可以直接写`;
    } catch (e) {
      $('annotStatus').textContent = 'PDF 打开失败：' + (e.message || e);
    }
  }

  $('annotPickImg').onclick = () => { $('annotFileImg').value = ''; $('annotFileImg').click(); };
  $('annotFileImg').onchange = () => pickImage($('annotFileImg').files && $('annotFileImg').files[0]);
  $('annotPickPdf').onclick = () => { $('annotFilePdf').value = ''; $('annotFilePdf').click(); };
  $('annotFilePdf').onchange = () => pickPdf($('annotFilePdf').files && $('annotFilePdf').files[0]);

  /* ---------- 翻页 / 缩放 ---------- */
  $('annotPrev').onclick = () => { if (st.idx > 0) showPage(st.idx - 1); };
  $('annotNext').onclick = () => { if (st.idx < st.pages.length - 1) showPage(st.idx + 1); };
  $('annotZoomIn').onclick = () => { st.zoom = Math.min(3, st.zoom + 0.15); board.setZoom(st.zoom); $('annotZoomInfo').textContent = Math.round(st.zoom * 100) + '%'; };
  $('annotZoomOut').onclick = () => { st.zoom = Math.max(0.4, st.zoom - 0.15); board.setZoom(st.zoom); $('annotZoomInfo').textContent = Math.round(st.zoom * 100) + '%'; };

  /* ---------- 本页文字 ---------- */
  function renderText() {
    const box = $('annotText');
    const cnt = $('annotTextCount');
    const p = st.pages[st.idx];
    box.innerHTML = '';
    cnt.textContent = '';
    if (!p) {
      box.innerHTML = '<div class="ph">导入 PDF 后，这里会显示本页文字。</div>';
      return;
    }
    if (st.kind !== 'pdf') {
      box.innerHTML = '<div class="ann-note">图片没有文字层，可以只用笔迹批注。</div>';
      return;
    }
    if (!p.paras || !p.paras.length || (p.chars || 0) < 50) {
      box.innerHTML = '<div class="ann-note">这一页没有文字层（扫描件），可以只用笔迹批注。</div>';
      return;
    }
    cnt.textContent = `${p.paras.length} 段 · ${p.chars} 字`;
    p.paras.forEach((para, i) => {
      const d = document.createElement('div');
      d.className = 'ann-para';
      d.dataset.i = String(i);
      const head = document.createElement('div');
      head.className = 'ann-head';
      const t = document.createElement('div');
      t.className = 'txt';
      t.textContent = para.text;
      const acts = document.createElement('div');
      acts.className = 'ann-acts';
      acts.innerHTML = '<button class="btn mini" data-act="ai">AI 解析这段</button>'
        + '<button class="btn mini" data-act="trans">翻译这段</button>';
      head.append(t, acts);
      const out = document.createElement('div');
      out.className = 'ann-out';
      out.hidden = true;
      d.append(head, out);
      d.onclick = (e) => { if (!e.target.closest('.ann-acts')) pickPara(i); };
      acts.querySelector('[data-act="ai"]').onclick = (e) => { e.stopPropagation(); runParaAI(i, 'ai', d); };
      acts.querySelector('[data-act="trans"]').onclick = (e) => { e.stopPropagation(); runParaAI(i, 'trans', d); };
      box.appendChild(d);
    });
  }

  /** 点段落 → 在纸面上盖一个半透明矩形（纸面按 contain 铺底，先算 contain 的偏移与缩放） */
  function pickPara(i) {
    const p = st.pages[st.idx];
    if (!p || !p.paras || !p.paras[i]) return;
    st.sel = i;
    document.querySelectorAll('#annotText .ann-para').forEach((el) => {
      el.classList.toggle('on', Number(el.dataset.i) === i);
    });
    const b = p.paras[i].box;
    const iw = p.iw || PAGE_W;
    const ih = p.ih || PAGE_H;
    const k = Math.min(PAGE_W / iw, PAGE_H / ih);
    const dw = iw * k;
    const dh = ih * k;
    const ox = (PAGE_W - dw) / 2;
    const oy = (PAGE_H - dh) / 2;
    hl.style.left = ((ox + b.x * dw) / PAGE_W * 100) + '%';
    hl.style.top = ((oy + b.y * dh) / PAGE_H * 100) + '%';
    hl.style.width = Math.max(0.8, (b.w * dw) / PAGE_W * 100) + '%';
    hl.style.height = Math.max(1.4, (b.h * dh) / PAGE_H * 100) + '%';
    hl.hidden = false;
  }

  /** 翻译用哪条提示词：优先内置「整页翻译」，用户删了就找名字带「译」的 */
  function transPreset() {
    const list = getPrompts();
    return list.find((p) => p.id === 'p_trans')
      || list.find((p) => /译/.test(p.name || ''))
      || { name: '翻译', system: '', body: '' };
  }

  async function runParaAI(i, mode, card) {
    const p = st.pages[st.idx];
    const para = p && p.paras && p.paras[i];
    if (!para) return;
    const out = card.querySelector('.ann-out');
    out.hidden = false;
    if (!cfgOk()) { out.innerHTML = '<div class="ph">还没配置 AI 接口（右上角「设置」）</div>'; return; }

    const preset = mode === 'trans'
      ? transPreset()
      : (promptById($('annotPrompt').value) || getPrompts()[0] || {});
    const prompt = mode === 'trans'
      ? `把下面这段文字翻译成简体中文，公式与变量保留原样，只输出译文：\n\n${para.text}`
      : composePrompt(preset, `只处理下面这一段文字，不要重复整页内容：\n\n${para.text}`);

    const btns = card.querySelectorAll('.ann-acts .btn');
    btns.forEach((b) => { b.disabled = true; });
    out.innerHTML = `<div class="ph">${mode === 'trans' ? '翻译中…' : '解析中…'}</div>`;
    try {
      const text = await chat({
        system: preset.system || '你是一个严谨的助手，只根据给定文字作答。',
        prompt,
        temperature: 0.2,
        maxTokens: 1500,
      });
      await mdInto(out, tidyAI(text));
    } catch (e) {
      out.innerHTML = `<div class="ph">出错了：${escapeHtml(e.message || e)}</div>`;
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  /* ---------- AI 解析本页 ---------- */
  $('annotAsk').onclick = async () => {
    if (!st.pages.length) { $('annotStatus').textContent = '先导入图片或 PDF'; return; }
    if (!cfgOk()) { $('annotStatus').textContent = '还没配置 AI 接口（右上角「设置」）'; return; }
    const p = promptById($('annotPrompt').value) || { name: '', system: '', body: '' };
    const prompt = composePrompt(p, '');
    if (!prompt.trim()) { $('annotStatus').textContent = '这条提示词是空的'; return; }
    const img = st.pages[st.idx].bg;
    $('annotAsk').disabled = true;
    $('annotStatus').textContent = 'AI 解析中…（' + p.name + '）';
    $('annotOut').innerHTML = '<div class="ph">正在解析…</div>';
    const t0 = Date.now();
    try {
      const text = await chat({
        system: p.system || '你是一个严谨的助手，只根据图片内容作答。',
        prompt,
        image: img,
        maxTokens: 3000,
      });
      await mdInto($('annotOut'), tidyAI(text));
      $('annotStatus').textContent = `完成 · ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    } catch (e) {
      $('annotOut').innerHTML = `<div class="ph">出错了：${escapeHtml(e.message || e)}</div>`;
      $('annotStatus').textContent = '失败';
    } finally {
      $('annotAsk').disabled = false;
    }
  };

  /* ---------- 导出 ---------- */
  $('annotExportPng').onclick = async () => {
    if (!st.pages.length) return;
    const url = await board.exportPng(2);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annot-p${st.idx + 1}.png`;
    a.click();
  };

  $('annotExportJson').onclick = () => {
    if (!st.pages.length) return;
    const data = {
      app: 'KY-notebook', version: 1, kind: st.kind,
      pages: st.pages.map((p, i) => ({ no: i, w: 1414, h: 1000, strokes: p.strokes || [] })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'annot.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  /* ---------- 存为笔记（带来源锚定） ---------- */
  $('annotToNote').onclick = async () => {
    if (!st.pages.length) { $('annotStatus').textContent = '先导入图片或 PDF'; return; }
    const p = st.pages[st.idx];
    p.strokes = board.getStrokes();
    const sink = noteSink();
    if (!sink) { $('annotStatus').textContent = '笔记本还没准备好'; return; }
    const kind = st.kind === 'pdf' ? 'pdf' : 'img';
    const name = st.name || (kind === 'pdf' ? 'PDF' : '图片');
    const page = st.idx + 1;
    const base = name.replace(/\.[^.]+$/, '') || (kind === 'pdf' ? 'PDF 批注' : '图片批注');
    const title = st.pages.length > 1 ? `${base} p${page}` : base;
    await sink.addBgPage(p.bg, title, { kind, name, page }, p.strokes);
    document.querySelector('.tab[data-tab="ink"]').click();
    if (sink.toast) sink.toast(`已存为笔记「${title}」`);
    $('annotStatus').textContent = '已存进笔记本（带来源）';
  };

  window.addEventListener('resize', () => board.layout());

  return { fillPrompts, state: st };
}

/* ---------- PDF 文字层：text item → 段落（坐标归一化到 0..1，跟渲染比例无关） ---------- */

/** 估算字号：pdf.js 的 transform = [a,b,c,d,e,f]，字号 ≈ √(b²+d²) */
function fontHeight(it, tr) {
  const h = Math.abs(it.height || 0);
  if (h > 0.5) return h;
  const guess = Math.hypot(tr[2] || 0, tr[3] || 0);
  return guess > 0.5 ? guess : 10;
}

/** items: page.getTextContent().items；vp0: page.getViewport({scale:1})
    排版感知：XY-cut —— 每次只切最宽的一条缝（先竖切分栏，切不动再横切分带），
    递归到切不动为止，再在每块内聚行、聚段。单栏页面结果与旧版一致；双栏 / 三栏正文不再串行。 */
export function itemsToParas(items, vp0) {
  const W = vp0.width || 1;
  const H = vp0.height || 1;
  const raw = [];
  items.forEach((it) => {
    const s = it.str || '';
    if (!s.trim()) return;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const h = fontHeight(it, tr);
    const x = tr[4];
    const yTop = H - tr[5] - h;                       /* PDF 原点在左下，换成左上 */
    const w = it.width || (s.trim().length * h * 0.5);
    raw.push({ s, x: x / W, y: Math.max(0, yTop / H), w: Math.max(0, w) / W, h: h / H });
  });
  if (!raw.length) return { paras: [], chars: 0 };

  const forceOneLine = looksLikeToc(raw);
  const paras = [];
  const blocks = forceOneLine ? [raw] : walk(raw, 0);
  blocks.forEach((block) => {
    collectColumn(block, forceOneLine).forEach((p) => paras.push(p));
  });
  const chars = paras.reduce((n, p) => n + p.text.length, 0);
  return { paras, chars };
}

/* 目录 / 索引页：行内「条目 ⇢ 页码」那种大空档，一行一段才合理 */
function looksLikeToc(raw) {
  const rows = buildRows(raw);
  if (rows.length < 5) return false;
  let leader = 0;
  rows.forEach((r) => {
    if (r.gap < 0.06) return;
    const tail = r.tail || '';
    const digits = (tail.match(/\d/g) || []).length;
    if (tail.length <= 6 && digits >= Math.max(1, Math.floor(tail.length / 2))) leader += 1;
  });
  return leader / rows.length >= 0.4;
}

/* 递归 XY-cut：竖切优先（分栏），切不动再横切（页眉 / 标题 / 正文分开） */
function walk(items, depth) {
  if (depth > 5 || items.length < 4) return [items];
  const cols = splitOnce(items, 'x', 0.018, { tol: 0.03, spanRatio: 0.45, minCount: 3 });
  if (cols) return walk(cols[0], depth + 1).concat(walk(cols[1], depth + 1));
  const bands = splitOnce(items, 'y', 0.02, { tol: 0, spanRatio: 0, minCount: 2 });
  if (bands) return walk(bands[0], depth + 1).concat(walk(bands[1], depth + 1));
  return [items];
}

/* 在某一轴上找最宽的一条「几乎没人覆盖」的缝，切一刀；两侧不够实就返回 null（宁可不切） */
function splitOnce(items, axis, minGap, opt) {
  const isX = axis === 'x';
  const lo = (i) => (isX ? i.x : i.y);
  const hi = (i) => (isX ? i.x + i.w : i.y + i.h);
  const start = Math.min(...items.map(lo));
  const end = Math.max(...items.map(hi));
  if (end - start <= minGap * 1.2) return null;

  const BIN = 0.003;
  const n = Math.max(2, Math.ceil((end - start) / BIN) + 1);
  const cov = new Uint16Array(n);
  items.forEach((it) => {
    const a2 = Math.max(0, Math.floor((lo(it) - start) / BIN));
    const b2 = Math.min(n - 1, Math.floor((hi(it) - start) / BIN));
    for (let k = a2; k <= b2; k++) cov[k] += 1;
  });

  /* tol：容许多少条跨栏元素压在缝上（通栏标题、页脚），按条数百分比算 */
  const tol = Math.max(1, Math.round(items.length * (opt.tol || 0)));
  let best = null;
  let run = -1;
  for (let k = 0; k <= n; k++) {
    const free = k < n && cov[k] <= tol;
    if (free) { if (run < 0) run = k; continue; }
    if (run >= 0) {
      const w0 = start + run * BIN;
      const w1 = start + k * BIN;
      const width = w1 - w0;
      /* 贴边的空档不算缝（那是右侧参差 / 上下留白） */
      const inner = w0 > start + 0.02 && w1 < end - 0.02;
      if (inner && width >= minGap && (!best || width > best.w)) best = { w: width, at: (w0 + w1) / 2 };
      run = -1;
    }
  }
  if (!best) return null;

  const left = [];
  const right = [];
  items.forEach((it) => {
    const c = (lo(it) + hi(it)) / 2;
    (c <= best.at ? left : right).push(it);
  });
  if (!left.length || !right.length) return null;

  const total = items.length;
  /* 竖向跨度永远按 y 量：横切时它就是切的轴，竖切时用来判断「这一栏有没有贯穿整块」
     （居中标题切出来的两边又窄又矮，靠这个挡掉） */
  const ySpan = (g) => Math.max(...g.map((i) => i.y + i.h)) - Math.min(...g.map((i) => i.y));
  const spanAll = ySpan(items);
  const ok = [left, right].every((g) => {
    if (g.length < Math.max(opt.minCount, total * 0.04)) return false;
    if (!opt.spanRatio) return true;
    return ySpan(g) >= spanAll * opt.spanRatio;
  });
  return ok ? [left, right] : null;
}

/* 聚行：同一高度、字高相近的 item 归一行；返回行数组 */
function buildRows(items) {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  sorted.forEach((it) => {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y) <= Math.max(last.h, it.h) * 0.6) {
      last.items.push(it);
      last.y = Math.min(last.y, it.y);
      last.h = Math.max(last.h, it.h);
    } else {
      lines.push({ y: it.y, h: it.h, items: [it] });
    }
  });

  const rows = [];
  lines.forEach((ln) => {
    ln.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    let maxGap = 0;
    let tail = '';
    ln.items.forEach((it) => {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        if (gap > maxGap) { maxGap = gap; tail = it.s.trim(); }
        if (gap > Math.max(0.008, it.h * 0.3)) text += ' ';
      }
      text += it.s;
      prevEnd = it.x + it.w;
    });
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    rows.push({
      text, gap: maxGap, tail,
      x0: Math.min(...ln.items.map((i) => i.x)),
      x1: Math.max(...ln.items.map((i) => i.x + i.w)),
      top: ln.y, bottom: ln.y + ln.h, h: ln.h,
    });
  });
  return rows;
}

/* 一整块（单栏）内：聚行 → 聚段 */
function collectColumn(items, forceOneLine) {
  const rows = buildRows(items);
  if (!rows.length) return [];

  const leaderRows = rows.filter((r) => r.gap >= 0.06).length;
  const oneLineEach = forceOneLine || (rows.length >= 4 && leaderRows / rows.length >= 0.5);

  const steps = rows.slice(1).map((r, i) => r.top - rows[i].top).filter((v) => v > 0);
  const lead = steps.length ? steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 0;
  const left = Math.min(...rows.map((r) => r.x0));
  const rights = rows.map((r) => r.x1).sort((a, b) => a - b);
  const rightEdge = rights[Math.floor(rights.length * 0.75)];   /* 本栏常见的右边线 */
  const colW = Math.max(0.05, rightEdge - left);

  const groups = [];
  let cur = null;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    let brk = !cur || oneLineEach;
    if (cur && !oneLineEach) {
      const vGap = r.top - prev.top;
      const bigGap = vGap > Math.max(r.h, prev.h) * 1.45 && (!lead || vGap > lead * 1.5);
      const sizeJump = Math.abs(r.h - prev.h) > Math.max(r.h, prev.h) * 0.18;
      /* 上一行明显比本栏常见右边界短 + 这一行从块左起：段落末行的典型特征 → 换段
         （参差排版的行尾只短几个字，不会被误判） */
      const shortEnd = prev.x1 < rightEdge - Math.max(0.02, colW * 0.25)
        && (r.x0 - left) < Math.max(0.01, colW * 0.06);
      brk = bigGap || sizeJump || shortEnd;
    }
    if (brk) { cur = { lines: [r] }; groups.push(cur); } else { cur.lines.push(r); }
  });

  return groups.map((p) => {
    const y0 = Math.min(...p.lines.map((l) => l.top));
    const y1 = Math.max(...p.lines.map((l) => l.bottom));
    const x0 = Math.min(...p.lines.map((l) => l.x0));
    const x1 = Math.max(...p.lines.map((l) => l.x1));
    return {
      text: p.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim(),
      box: { x: x0, y: y0, w: Math.max(0.002, x1 - x0), h: Math.max(0.004, y1 - y0) },
    };
  }).filter((p) => p.text);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
