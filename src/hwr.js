/* 手写转文字（HWR）
   - 离线引擎：PP-OCRv5 中文识别（ONNX，onnxruntime-web 的 WASM 后端），
     模型/字典/运行时都放在 /vendor/hwr/，首次识别时懒加载
   - 备用引擎：把笔迹转成图片，交给已配置的多模态模型识别（中英混排/连笔更稳，但要联网）
   - 两者都吃「一张白底墨迹图」：inkToCanvas() 负责把笔画光栅化
*/

import { toSimp } from './t2s.js';

const DIR = '/vendor/hwr/';
const ORT_JS = DIR + 'ort.wasm.min.js';
const LS_HWR = 'kynb_hwr';

export function getHwrCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(LS_HWR) || '{}'); } catch (e) { c = {}; }
  return {
    auto: c.auto !== false,              // 自动上屏：认出来直接写进笔记
    engine: c.engine === 'ai' ? 'ai' : 'local',
    idle: Math.max(200, Math.min(3000, Number(c.idle) || 800)),   // 停笔多久开始识别
    /* 停笔多久算「这一行写完了」：写一个字常常要在笔画之间停 2~5 秒，
       定稿太快会把一个字拆成好几块（以前 2.4 秒就是这么坏事的） */
    commit: Math.max(3000, Math.min(20000, Number(c.commit) || 8000)),
  };
}

export function setHwrCfg(c) {
  localStorage.setItem(LS_HWR, JSON.stringify({
    auto: c.auto !== false,
    engine: c.engine === 'ai' ? 'ai' : 'local',
    idle: Math.max(200, Math.min(3000, Number(c.idle) || 800)),
    commit: Math.max(3000, Math.min(20000, Number(c.commit) || 8000)),
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
  /* 留白要够：笔画本身有粗细，最后一笔贴边时会被切掉半个字（「apple」认成「appl」就是这么来的） */
  const pad = Math.max(10, Math.max(bw, bh) * 0.16);
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

/* ---------------- 字块切分 / 长行分块 ----------------
   PP-OCR 的 rec 模型是按 [3,48,320] 训的（官方 tricks：宽高比 > 10 的样本训练时直接丢弃），
   所以一行写太长、宽高比超过 6~7 之后就开始「后半截掉字」。
   解决：先按字块切出每个字，再按宽度攒成若干段，一段一段认（每段都保持窄长比），
   段的间隙大就补一个空格。这也顺带让「字号」有了可靠的估计（字块高度）。 */

/** 把笔画按「横向重叠 / 贴得很近」并成字块（一个字的几笔归一块），按 x 排好 */
export function charClusters(strokes) {
  const items = strokes.map((s) => ({ s, b: bboxOf([s]) })).filter((x) => x.b);
  if (!items.length) return [];
  const hs = items.map((x) => x.b.h).sort((a, b) => a - b);
  const ref = Math.max(8, hs[Math.floor((hs.length - 1) * 0.75)] || 20);
  const tol = ref * 0.22;
  items.sort((a, b) => a.b.x - b.b.x);
  const groups = [];
  for (const it of items) {
    let hit = null;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      if (it.b.x > g.x1 + tol) break;              /* 已经隔太远（x 升序） */
      if (g.x0 > it.b.x + it.b.w + tol) continue;  /* 这个组在右边，往左看 */
      const ov = Math.min(g.y1, it.b.y + it.b.h) - Math.max(g.y0, it.b.y);
      if (ov < -ref * 0.5) continue;               /* 竖着不搭边：不是同一个字 */
      hit = g; break;
    }
    if (hit) {
      hit.items.push(it);
      hit.x0 = Math.min(hit.x0, it.b.x);
      hit.x1 = Math.max(hit.x1, it.b.x + it.b.w);
      hit.y0 = Math.min(hit.y0, it.b.y);
      hit.y1 = Math.max(hit.y1, it.b.y + it.b.h);
    } else {
      groups.push({ x0: it.b.x, x1: it.b.x + it.b.w, y0: it.b.y, y1: it.b.y + it.b.h, items: [it] });
    }
  }
  groups.sort((a, b) => a.x0 - b.x0);
  return groups.map((g) => ({ x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1, strokes: g.items.map((x) => x.s) }));
}

/**
 * 一行太长就按字块切成若干段，每段宽高比不超过 maxRatio。
 * 阈值定在 12 是实测出来的：12 字以内整行直认识别率并不差（PP-OCR 单图推理会按比例放宽宽度），
 * 切得太碎反而因为「连接处切到笔画」掉字；超过 12 才切，且只切在字块缝上。
 */
export function splitLongLine(strokes, maxRatio) {
  const mr = Number(maxRatio) || 12;
  const all = bboxOf(strokes);
  if (!all) return [];
  const H = Math.max(8, all.h);
  const whole = [{ strokes, x0: all.x, x1: all.x + all.w }];
  if (all.w / H <= mr) return whole;
  const cs = charClusters(strokes);
  if (cs.length <= 1) return whole;
  const out = [];
  let cur = null;
  for (const c of cs) {
    const nx1 = cur ? Math.max(cur.x1, c.x1) : c.x1;
    if (cur && (nx1 - cur.x0) / H > mr) { out.push(cur); cur = null; }
    if (!cur) cur = { strokes: [], x0: c.x0, x1: c.x1 };
    for (const s of c.strokes) cur.strokes.push(s);
    cur.x1 = Math.max(cur.x1, c.x1);
  }
  if (cur && cur.strokes.length) out.push(cur);
  return out.length ? out : whole;
}

/** 估字号：取字块高度的 80 分位（避开「一」「丶」这种扁/小的笔画），汉字字面高约占字号 0.88 */
export function estimateSize(strokes) {
  const hs = charClusters(strokes).map((c) => c.y1 - c.y0).filter((h) => h > 1).sort((a, b) => a - b);
  if (!hs.length) return 0;
  const h = hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.8))];
  return Math.max(12, Math.min(200, Math.round(h / 0.88)));
}

/* ---------------- 标点：一小笔的特殊照顾 ----------------
   PP-OCR 是「整行」识别器：一行里带标点它认得（实测「你好，世界。这是测试！」100%），
   但把单独一个逗号/句号裁出来送进去，它几乎一律返回空（实测 ，。、（）“ 全空）。
   所以这里做两件事：
     1) 判断「这一笔小到不可能是汉字」——换行/分块时别把标点拆出去；
     2) 万一真被单独识别了，按形状猜一个标点补上。 */

function inkLen(strokes) {
  let n = 0;
  for (const s of strokes) {
    let prev = null;
    eachPt(s.pts, (x, y) => {
      if (prev) n += Math.hypot(x - prev[0], y - prev[1]);
      prev = [x, y];
    });
  }
  return n;
}

/** 像不像一个标点：笔画很少、bbox 很小（相对行高或绝对尺寸），且笔画总长很短 */
export function isPunctLike(strokes, lineH) {
  const b = bboxOf(strokes);
  if (!b) return false;
  if (!strokes || strokes.length > 2) return false;      /* 标点最多两笔（冒号、引号） */
  const ref = Math.max(12, Number(lineH) || 0);
  /* 绝对尺寸兜底：1414 宽的纸上，正常字不会小于 22px 高 */
  const tiny = b.h < 22 && b.w < 26;
  const small = ref > 0 && b.h < ref * 0.42 && b.w < ref * 0.62;
  if (!tiny && !small) return false;
  return inkLen(strokes) < Math.max(36, ref * 1.6);
}

/**
 * 单独一个标点被认成空/乱码时，按形状猜：
 * 很短的点→。 短斜点→、 带尾巴的撇→， 上下两点→：
 * lineH 是正常字的高度（没传就按标点自身高度反推）。
 */
export function guessPunct(strokes, lineH) {
  const b = bboxOf(strokes);
  if (!b) return '';
  const list = strokes.filter((s) => ptCount(s.pts) > 0);
  if (!list.length) return '';
  if (list.length === 2) {
    const bs = list.map((s) => bboxOf([s])).filter(Boolean).sort((a, c) => a.y - c.y);
    if (bs.length === 2 && bs[1].y > bs[0].y + bs[0].h * 0.9 &&
        bs[0].h < b.h * 0.7 && bs[1].h < b.h * 0.7) return '：';
  }
  const ref = Math.max(14, Number(lineH) || b.h * 2.4);
  const len = inkLen(list);
  /* 首尾距离 / 总长度：点（或小圈）起点终点几乎重合，撇是一条线 */
  let first = null, lastPt = null;
  for (const s of list) {
    eachPt(s.pts, (x, y) => { if (!first) first = [x, y]; lastPt = [x, y]; });
  }
  const chord = (first && lastPt) ? Math.hypot(lastPt[0] - first[0], lastPt[1] - first[1]) : 0;
  const straight = len > 0 ? chord / len : 0;
  if (len < ref * 0.16) return '。';        /* 很短 */
  if (straight < 0.6) return '。';          /* 起点终点几乎重合：点 / 小圈 */
  if (len < ref * 0.28) return '、';        /* 短撇 */
  return '，';                              /* 带尾巴的长撇 */
}

/** 中文语境里把半角标点换成全角（纯英文不动；小数点的点不换） */
export function normalizePunct(s) {
  const t = String(s == null ? '' : s);
  if (!t) return t;
  const hasCjk = /[\u4e00-\u9fff]/.test(t);
  const hasLatin = /[A-Za-z]/.test(t);
  if (!hasCjk && hasLatin) return t;
  return t
    .replace(/,/g, '，')
    .replace(/;/g, '；')
    .replace(/:/g, '：')
    .replace(/\?/g, '？')
    .replace(/!/g, '！')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
    .replace(/\./g, (m, i, all) =>
      (/\d/.test(all[i - 1] || '') && /\d/.test(all[i + 1] || '')) ? '.' : '。');
}

/* 模型对单标点有时会吐字母/乱码，只有它真的给了标点才信它 */
const PUNCT_ONLY = /^[，。？！：；、,.?!:;'"“”‘’（）()《》〈〉…·]+$/;

/**
 * 一整行（或一整段）笔迹 → 文字：自动切段、逐段识别、按间隙补空格。
 * opt.lineH：正常字的高度（上一行的字号），用来判断「这一小笔是不是标点」。
 * score 取各段最小值（最不确定的那段说话），调用方据此决定要不要动墨迹。
 */
export async function recognizeStrokes(strokes, opt) {
  const all0 = bboxOf(strokes) || { h: 24 };
  const refH = Math.max(12, Number(opt && opt.lineH) || all0.h);

  /* 行尾那一小笔（句号/逗号/顿号）先摘出来：
     模型经常把它当噪音——要么吞掉，要么带偏前面的字（实测「才，」被认成「オ-」）。
     摘掉之后正文照常识别，标点按形状补回去。问号/感叹号个头大，不摘，交给模型。 */
  let tail = null;
  const last = strokes[strokes.length - 1];
  if (last && strokes.length > 1) {
    const lb = bboxOf([last]);
    if (lb && isPunctLike([last], refH) && inkLen([last]) < refH * 0.32 &&
        lb.x > all0.x + all0.w * 0.6) {
      tail = last;
      strokes = strokes.slice(0, -1);
    }
  }

  const parts = splitLongLine(strokes);
  const all = bboxOf(strokes) || { h: 24 };
  const H = Math.max(8, all.h);
  let text = '', score = 1, ms = 0, prevX1 = null, cands = null, dataUrl = '';
  for (const p of parts) {
    const ink = inkToCanvas(p.strokes);
    if (!ink) continue;
    let r;
    try { r = await recognizeLocal(ink); } catch (e) { continue; }
    ms += r.ms;
    let got = r.text;
    let sc = r.score;
    /* 标点：模型单独认一小笔经常吐乱码（实测 点→"-"、撇→"」"），只有它真给了标点才信；
       否则按形状补一个（。，、：），实在猜不出就用模型原来的结果 */
    if (isPunctLike(p.strokes, refH)) {
      if (!PUNCT_ONLY.test(got)) {
        const g = guessPunct(p.strokes, refH);
        if (g) { got = g; sc = 0.4; }
      }
      if (!got) sc = 0;
    }
    if (!got) continue;
    if (!dataUrl) dataUrl = ink.dataUrl;
    if (text && prevX1 != null && p.x0 - prevX1 > H * 0.9) text += ' ';
    text += got;
    score = Math.min(score, sc);
    prevX1 = p.x1;
    /* 只有一整段时才能给「整行」的候选；切过段就只留一个结果 */
    if (parts.length === 1 && r.cands && r.cands.length) cands = r.cands;
  }
  /* 把摘出去的标点补回行尾（正文末尾已经是标点就不重复加） */
  if (tail) {
    const g = guessPunct([tail], refH);
    if (g) {
      const t = text.trim();
      if (!t) { text = g; score = Math.min(score, 0.4); }
      else if (!/[，。？！：；、]$/.test(t)) text = t + g;
      else text = t;
    }
  }

  return { text: text.trim(), score, ms, parts: parts.length, dataUrl,
    cands: cands || [{ text: text.trim(), score }] };
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

/**
 * CTC 前缀 beam search：在贪心之外再留几个候选。
 * 手写识别经常「差一个字」，候选条里点一下就能改，比擦了重写快得多。
 */
function ctcBeam(frames, chars, beamWidth, keep) {
  const T = frames.length;
  const BW = beamWidth || 8;
  const KEEP = keep || 4;
  let beams = [{ text: '', prob: 0, last: -1 }];   /* prob 用对数 */
  for (let t = 0; t < T; t++) {
    const fr = frames[t];
    const next = new Map();
    const put = (text, last, pr) => {
      const key = text + '\u0000' + last;
      const cur = next.get(key);
      if (!cur || pr > cur.prob) next.set(key, { text, last, prob: pr });
    };
    const lb = Math.log(Math.max(1e-9, fr.blank));
    for (const b of beams) {
      put(b.text, -1, b.prob + lb);              /* 走 blank：不吐字 */
      for (const [c, v] of fr.top) {
        if (c === 0) continue;
        const ch = chars[c] || '';
        if (!ch) continue;
        const lv = Math.log(Math.max(1e-9, v));
        if (c === b.last) {
          /* 重复字符：不经过 blank 时 CTC 会折叠掉，概率给个小权重近似 */
          put(b.text, c, b.prob + lv - 2.3);
        } else {
          put(b.text + ch, c, b.prob + lv);
        }
      }
    }
    beams = [...next.values()].sort((a, b) => b.prob - a.prob).slice(0, BW);
  }
  const scored = beams.map((b) => ({ text: toSimp(b.text), prob: b.prob / Math.max(1, T) }));
  const out = [];
  const seen = new Set();
  for (const c of scored) {
    const t = c.text.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ text: t, score: c.prob });
    if (out.length >= KEEP) break;
  }
  return out;
}

/* 形近的「假英文字母」：西里尔/全角字符经常被模型吐出来，混在英文里就成了乱码。
   只有在整段没有中文时才做这个归一化。 */
const CONF_LATIN = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'ԁ': 'd',
  'ɡ': 'g', 'ⅼ': 'l', 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
  'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'Ј': 'J', 'І': 'I',
};

function fixLatin(s) {
  let t = String(s || '').replace(/\u3000/g, ' ');
  let cjk = 0, latin = 0, n = 0;
  for (const ch of t) {
    if (!ch.trim()) continue;
    n++;
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
    else if (/[A-Za-z0-9]/.test(ch)) latin++;
  }
  if (cjk > 0) return t;                       /* 有中文就别动 */
  if (!n || latin / n < 0.5) return t;
  let out = '';
  for (let ch of t) {
    const code = ch.codePointAt(0);
    if (code >= 0xFF01 && code <= 0xFF5E) ch = String.fromCharCode(code - 0xFEE0);
    out += CONF_LATIN[ch] || ch;
  }
  return out;
}

/** 离线识别：返回 { text, score, cands, ms }；cands 是 top-N 候选（第一个就是 text） */
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

  /* 一趟扫描：每帧记下 blank 概率和前 6 个候选字符（贪心和 beam 都用它，别扫两遍） */
  const frames = new Array(T);
  for (let i = 0; i < T; i++) {
    const base = i * C;
    const top = [];
    for (let c = 0; c < C; c++) {
      const v = p[base + c];
      if (top.length < 6) { top.push([c, v]); top.sort((a, b) => b[1] - a[1]); }
      else if (v > top[5][1]) { top[5] = [c, v]; top.sort((a, b) => b[1] - a[1]); }
    }
    frames[i] = { blank: p[base], top };
  }

  /* 贪心；置信度按「真正吐出来的每个字」的概率取几何平均（比按帧平均稳得多） */
  let prev = -1, s = '', logSum = 0, confN = 0;
  for (let i = 0; i < T; i++) {
    const best = frames[i].top[0];
    const c = best ? best[0] : 0;
    if (c !== 0 && c !== prev) {
      s += _chars[c] || '';
      logSum += Math.log(Math.max(1e-6, best[1]));
      confN++;
    }
    prev = c;
  }
  const conf = confN ? Math.exp(logSum / confN) : 0;
  const text = normalizePunct(fixLatin(toSimp(s.trim())));

  /* beam 候选（贪心的结果一定在里面，失败就用它兜底） */
  let cands = [];
  try {
    cands = ctcBeam(frames, _chars);
  } catch (e) { cands = []; }
  cands = cands.map((c) => ({ ...c, text: normalizePunct(fixLatin(c.text)) }));
  if (!cands.length || cands[0].text !== text) {
    cands = [{ text, score: confN ? conf / confN : 0 }, ...cands.filter((x) => x.text !== text)];
  }
  return { text, ms, score: conf, cands: cands.slice(0, 4) };
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
