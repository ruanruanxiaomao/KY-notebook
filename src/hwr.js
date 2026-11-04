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

/**
 * strokes: [{ pts:[[x,y],...], w }]，坐标用 CSS 像素即可（同一坐标系就行）
 * 输出：{ canvas, dataUrl }，四周留白，把字撑到约 120px 高，方便模型看清笔画
 */
export function inkToCanvas(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let wMax = 3;
  for (const s of strokes) {
    for (const p of s.pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
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
    const pts = s.pts;
    if (!pts.length) continue;
    g.lineWidth = Math.max(2.2, Math.min(14, (s.w || wMax) * k * 1.1));
    g.beginPath();
    g.moveTo((pts[0][0] + ox) * k + dx, (pts[0][1] + oy) * k);
    if (pts.length === 1) g.lineTo((pts[0][0] + ox) * k + dx + 0.6, (pts[0][1] + oy) * k);
    for (let i = 1; i < pts.length; i++) {
      g.lineTo((pts[i][0] + ox) * k + dx, (pts[i][1] + oy) * k);
    }
    g.stroke();
  }
  return { canvas: c, dataUrl: c.toDataURL('image/png') };
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
  for (let i = 0; i < T; i++) {
    let best = 0, bv = -Infinity;
    const base = i * C;
    for (let c = 0; c < C; c++) { const v = p[base + c]; if (v > bv) { bv = v; best = c; } }
    if (best !== 0 && best !== prev) s += _chars[best] || '';
    prev = best;
  }
  /* 模型偶尔会连着吐同一段空白/重复，去掉首尾空格 */
  return { text: s.trim(), ms };
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
    maxTokens: 120,
  });
  return { text: cleanAiText(txt), ms: Math.round(performance.now() - t0) };
}

export { LS_HWR };
