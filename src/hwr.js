/* 手写转文字（HWR）
   - 离线引擎：PP-OCRv5 中文识别（ONNX，onnxruntime-web 的 WASM 后端），
     模型/字典/运行时都放在 /vendor/hwr/，首次识别时懒加载
   - 备用引擎：把笔迹转成图片，交给已配置的多模态模型识别（中英混排/连笔更稳，但要联网）
   - 两者都吃「一张白底墨迹图」：inkToCanvas() 负责把笔画光栅化
*/

const DIR = '/vendor/hwr/';
const ORT_JS = DIR + 'ort.wasm.min.js';
const LS_HWR = 'kynb_hwr';

export function getHwrCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(LS_HWR) || '{}'); } catch (e) { c = {}; }
  return {
    auto: c.auto !== false,              // 自动上屏：认出来直接写进笔记
    engine: c.engine === 'ai' ? 'ai' : 'local',
    idle: Math.max(200, Math.min(2000, Number(c.idle) || 500)),   // 停笔多久开始识别
  };
}

export function setHwrCfg(c) {
  localStorage.setItem(LS_HWR, JSON.stringify({
    auto: c.auto !== false,
    engine: c.engine === 'ai' ? 'ai' : 'local',
    idle: Math.max(200, Math.min(2000, Number(c.idle) || 600)),
  }));
}

/* ---------------- 笔画 → 白底墨迹图 ---------------- */

/* 两个地方的笔画格式不一样：
   画板（inkboard）是扁平三元组 [x,y,压感, x,y,压感, ...]，手写板是 [[x,y], ...]
   统一用 eachPt 遍历，别在这里假设某一种 */
function eachPt(pts, fn) {
  if (!pts || !pts.length) return;
  if (typeof pts[0] === 'number') {
    for (let i = 0; i + 1 < pts.length; i += 3) fn(pts[i], pts[i + 1]);
  } else {
    for (const q of pts) fn(q[0], q[1]);
  }
}

function ptCount(pts) {
  if (!pts || !pts.length) return 0;
  return typeof pts[0] === 'number' ? Math.floor(pts.length / 3) : pts.length;
}

/**
 * strokes: [{ pts:[[x,y],...], w }]，坐标用 CSS 像素即可（同一坐标系就行）
 * 输出：{ canvas, dataUrl }，四周留白，把字撑到约 120px 高，方便模型看清笔画
 */
export function inkToCanvas(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let wMax = 3;
  for (const s of strokes) {
    eachPt(s.pts, (x, y) => {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    });
    if (s.w > wMax) wMax = s.w;
  }
  if (!isFinite(x0)) return null;
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const pad = Math.max(6, Math.max(bw, bh) * 0.10);
  /* 归一化到「高约 120px」：太小模型看不清，太大白算 */
  const target = 120;
  const k = Math.max(0.4, Math.min(4, target / (bh + pad * 2)));
  let W = Math.max(24, Math.round((bw + pad * 2) * k));
  const H = Math.max(24, Math.round((bh + pad * 2) * k));
  /* 模型是拿「文本行」训的：单个字太方反而认不准，横向补到 1.6:1（实测 45/48 → 46/48） */
  if (W < H * 1.6) W = Math.round(H * 1.6);

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#111';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const ox = pad - x0, oy = pad - y0;
  /* 横向补宽后要把字放回中间 */
  const dx = Math.max(0, (W - (bw + pad * 2) * k) / 2);
  for (const s of strokes) {
    const n = ptCount(s.pts);
    if (!n) continue;
    g.lineWidth = Math.max(2.2, Math.min(14, (s.w || wMax) * k * 1.1));
    g.beginPath();
    let first = true;
    eachPt(s.pts, (x, y) => {
      const px = (x + ox) * k + dx;
      const py = (y + oy) * k;
      if (first) { g.moveTo(px, py); first = false; } else g.lineTo(px, py);
    });
    if (n === 1) g.lineTo((x0 + ox) * k + dx + 0.6, (y0 + oy) * k);
    g.stroke();
  }
  return { canvas: c, dataUrl: c.toDataURL('image/png'), bbox: { x: x0, y: y0, w: bw, h: bh } };
}

/** 一组笔画的包围盒（页面坐标） */
export function bboxOf(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    eachPt(s.pts, (x, y) => {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    });
  }
  if (!isFinite(x0)) return null;
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * 把一堆笔画按「行」分组：纵向上互相压得住 40% 以上的算同一行，行内再按 x 排序。
 * 画布上写完一段话，可能有 2~3 行，一行一张图分别送识别。
 */
export function groupLines(strokes) {
  const items = strokes.map((s) => ({ s, b: bboxOf([s]) })).filter((x) => x.b);
  /* 按「笔画中心」从上往下排：横线的 bbox 高度≈0，用左上角排序会把一行的笔画拆散 */
  items.sort((a, b) => (a.b.y + a.b.h / 2) - (b.b.y + b.b.h / 2));
  const lines = [];
  for (const it of items) {
    const cy = it.b.y + it.b.h / 2;
    let hit = null;
    for (const ln of lines) {
      const tol = Math.max(2, (ln.y1 - ln.y0) * 0.35);
      if (cy >= ln.y0 - tol && cy <= ln.y1 + tol) { hit = ln; break; }
    }
    if (!hit) {
      hit = { y0: it.b.y, y1: it.b.y + it.b.h, list: [] };
      lines.push(hit);
    } else {
      hit.y0 = Math.min(hit.y0, it.b.y);
      hit.y1 = Math.max(hit.y1, it.b.y + it.b.h);
    }
    hit.list.push(it.s);
  }
  lines.sort((a, b) => a.y0 - b.y0);
  return lines.map((ln) => ln.list.sort((a, b) => {
    const ba = bboxOf([a]), bb2 = bboxOf([b]);
    return (ba ? ba.x : 0) - (bb2 ? bb2.x : 0);
  }));
}

/**
 * 像不像公式：有「一条又长又平的横线，且它上下都有别的笔画」——
 * 分数线 / 分式 / 根号横线都能命中；普通横线文字里不会有这么多上下结构。
 * 只用来给提示，不自动改判。
 */
export function looksLikeFormula(strokes) {
  const bb = bboxOf(strokes);
  if (!bb || bb.w < 2) return false;
  for (const s of strokes) {
    const b = bboxOf([s]);
    if (!b) continue;
    const flat = b.h < Math.max(6, bb.h * 0.12);
    const wide = b.w > bb.w * 0.45;
    if (!flat || !wide) continue;
    const cy = b.y + b.h / 2;
    let above = 0, below = 0;
    for (const o of strokes) {
      if (o === s) continue;
      const ob = bboxOf([o]);
      if (!ob) continue;
      if (ob.y + ob.h < cy - 1) above++;
      else if (ob.y > cy + 1) below++;
    }
    if (above && below) return true;
  }
  return false;
}

/* ---------------- 公式 ---------------- */

const TEX_SYS = '你是手写公式识别引擎。把图里的手写数学内容转成 LaTeX，只输出 LaTeX 代码本身：'
  + '不要 $ 包裹、不要 \\[ \\]、不要解释、不要代码块。用标准写法（\\frac{}{}、^{}、_{}、\\sqrt{}、\\int、\\sum）。';

function cleanTex(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```[\w]*\n?/m, '').replace(/```$/m, '').trim();
  t = t.replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim();
  t = t.replace(/^\\\[/, '').replace(/\\\]$/, '').trim();
  t = t.replace(/^(LaTeX|公式|结果)[:：]\s*/i, '');
  return t.split('\n').filter((x) => x.trim()).join(' ').trim();
}

/** 公式识别：交给多模态模型，返回 LaTeX 源码 */
export async function recognizeFormula(ink, chat) {
  const img = ink.dataUrl || (ink.canvas || ink).toDataURL('image/png');
  const t0 = performance.now();
  const txt = await chat({
    system: TEX_SYS,
    prompt: '把这张手写公式转成 LaTeX。',
    image: img,
    temperature: 0,
    maxTokens: 1500,          /* 同上：思考 token + LaTeX 本身都要留出余量 */
  });
  return { tex: cleanTex(txt), ms: Math.round(performance.now() - t0) };
}

/**
 * LaTeX → 一张能塞进笔记的 SVG 图片（用页面已有的 MathJax 排版）。
 * px 是期望的行高（约等于文字块的字号）。
 * 注意：index.html 里 MathJax 配的是 fontCache:'local'，否则生成的 SVG 会引用全局字形缓存，单独拿出来就是空白。
 */
export function texToImage(tex, px, color) {
  const MJ = window.MathJax;
  if (!MJ || typeof MJ.tex2svg !== 'function') {
    throw new Error('MathJax 还没加载好（首次需要联网一次），先联网打开一次再试');
  }
  const node = MJ.tex2svg(tex, { display: false });
  const svg = node.querySelector('svg');
  if (!svg) throw new Error('公式排版失败');
  const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  if (vb.length !== 4 || !(vb[3] > 0)) throw new Error('公式没有可用尺寸');
  /* MathJax 的 viewBox 单位是 em 的 1/1000 */
  const em = Math.max(10, px);
  const k = em / 1000;
  const w = Math.max(8, vb[2] * k);
  const h = Math.max(8, vb[3] * k);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.removeAttribute('style');
  svg.setAttribute('color', color || '#1f1c18');
  svg.style.color = color || '#1f1c18';
  const xml = new XMLSerializer().serializeToString(svg);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  return { src: url, w, h, tex };
}

/* ---------------- 离线引擎 ---------------- */

let _ready = null;      // Promise<{ ort, sess }>
let _chars = null;
let _loadInfo = { ms: 0, bytes: 0 };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('运行时没加载上：' + src));
    document.head.appendChild(s);
  });
}

/** 预热：第一次会拉 28MB 资源（本机服务，不联网），之后从缓存走 */
export function ensureLocalEngine() {
  if (_ready) return _ready;
  _ready = (async () => {
    const t0 = performance.now();
    if (!window.ort) await loadScript(ORT_JS);
    const ort = window.ort;
    if (!ort) throw new Error('onnxruntime-web 没有挂到 window.ort');
    ort.env.wasm.wasmPaths = DIR;
    ort.env.wasm.numThreads = 1;          // 单线程：WebView 里没有 SharedArrayBuffer，稳妥
    ort.env.wasm.simd = true;
    const [txt, buf] = await Promise.all([
      fetch(DIR + 'dict.txt').then((r) => {
        if (!r.ok) throw new Error('字典读取失败 ' + r.status);
        return r.text();
      }),
      fetch(DIR + 'rec.onnx').then((r) => {
        if (!r.ok) throw new Error('模型读取失败 ' + r.status);
        return r.arrayBuffer();
      }),
    ]);
    _loadInfo.bytes = buf.byteLength;
    /* PP-OCR 的词表：0 是 CTC 空白，末尾补一个空格字符 */
    _chars = ['', ...txt.split('\n').filter((x) => x.length), ' '];
    const sess = await ort.InferenceSession.create(buf, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    _loadInfo.ms = Math.round(performance.now() - t0);
    return { ort, sess };
  })();
  _ready.catch(() => { _ready = null; });   // 失败允许重试
  return _ready;
}

export function engineInfo() { return { ..._loadInfo }; }

/** 把白底墨迹图缩到 48 高、归一化，喂给 rec 模型 */
function prep(canvas) {
  const H = 48;
  const w = Math.max(16, Math.round(H * canvas.width / Math.max(1, canvas.height)));
  const c = document.createElement('canvas');
  c.width = w; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, H);
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, w, H);
  const d = g.getImageData(0, 0, w, H).data;
  const n = w * H;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const v = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    const z = (v - 0.5) / 0.5;
    out[i] = z; out[n + i] = z; out[2 * n + i] = z;
  }
  return { data: out, w, h: H };
}

/** 离线识别：返回 { text, ms } */
export async function recognizeLocal(ink) {
  const { ort, sess } = await ensureLocalEngine();
  const src = ink.canvas || ink;
  const { data, w, h } = prep(src);
  const t = new ort.Tensor('float32', data, [1, 3, h, w]);
  const t0 = performance.now();
  const out = await sess.run({ [sess.inputNames[0]]: t });
  const y = out[sess.outputNames[0]];
  const ms = Math.round(performance.now() - t0);
  const [, T, C] = y.dims;
  const p = y.data;
  let prev = -1;
  let s = '';
  let conf = 0, confN = 0;
  for (let i = 0; i < T; i++) {
    let best = 0, bv = -Infinity;
    const base = i * C;
    for (let c = 0; c < C; c++) { const v = p[base + c]; if (v > bv) { bv = v; best = c; } }
    if (best !== 0) { conf += bv; confN++; }
    if (best !== 0 && best !== prev) s += _chars[best] || '';
    prev = best;
  }
  /* 置信度（只统计出了字的帧）：低于阈值就别替换墨迹，交给用户决定 */
  return { text: s.trim(), ms, score: confN ? conf / confN : 0 };
}

/* ---------------- AI 引擎 ---------------- */

const AI_SYS = '你是一台手写识别引擎。只输出图片里写的内容本身，不要解释、不要引号、不要标点补充。'
  + '中文一律输出简体。看不清就输出最像的字。图里没有字就输出空。';

function cleanAiText(s) {
  let t = String(s || '').trim();
  /* 去掉常见的回答壳子：「识别结果：xxx」、反引号、引号 */
  t = t.replace(/^```[\w]*\n?/m, '').replace(/```$/m, '').trim();
  t = t.replace(/^(识别结果|图片中的文字|文字内容|结果)[:：]\s*/, '');
  t = t.replace(/^["'“”「『]+|["'“”」』]+$/g, '');
  return t.split('\n')[0].trim();
}

/** 用已配置的多模态模型识别：需要在设置里勾「支持看图」 */
export async function recognizeAI(ink, chat) {
  const img = ink.dataUrl || (ink.canvas || ink).toDataURL('image/png');
  const t0 = performance.now();
  const txt = await chat({
    system: AI_SYS,
    prompt: '把这张手写图里的内容转成文字。',
    image: img,
    temperature: 0,
    maxTokens: 800,          /* 推理型模型会先花 token 思考，给少了会被截断 */
  });
  return { text: cleanAiText(txt), ms: Math.round(performance.now() - t0) };
}

export { LS_HWR };
