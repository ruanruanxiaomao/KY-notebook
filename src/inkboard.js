/* 手写画板引擎：页面坐标固定 W×H，canvas 只负责显示
   - 笔画数据结构：{ t:'pen'|'hl'|'er', c, w, pts:[x,y,p, x,y,p, ...] }
   - 撤销/重做是「笔画数组快照」，橡皮也当作一种笔画重放
   - 模板平时只影响纸面背景（CSS），不画进 canvas；导出 PNG 时由 _paintTemplate 补画
*/
export const PAGE_W = 1414;
export const PAGE_H = 1000;

export const COLORS = ['#1f1c18', '#8b2f2f', '#1f4e79', '#2f6b3a', '#8a5a00', '#6b3f8b', '#c2185b', '#ffffff'];
export const SIZES = [2, 4, 7];

export class InkBoard {
  constructor(canvas, paper, stage, opts = {}) {
    this.cv = canvas;
    this.paper = paper;
    this.stage = stage;
    this.ctx = canvas.getContext('2d');
    this.zoom = opts.zoom || 1;
    this.tool = 'pen';
    this.color = COLORS[0];
    this.size = SIZES[1];
    this.strokes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.bg = null;
    this.template = 'blank';
    this._st = null;
    this._k = 1;      // 页面坐标 → 设备像素
    this._s = 1;      // 页面坐标 → CSS 像素
    this.onChange = null;
    this._ro = null;
    this._bind();
    this._observe();
    this.layout();
  }

  /* ---------- 尺寸 ---------- */
  _observe() {
    if (this._ro) this._ro.disconnect();
    this._ro = new ResizeObserver(() => this.layout());
    this._ro.observe(this.stage);
  }

  layout() {
    const pad = 28;
    const availW = Math.max(320, this.stage.clientWidth - pad);
    const availH = Math.max(240, this.stage.clientHeight - pad);
    const s = Math.min(availW / PAGE_W, availH / PAGE_H, 1) * this.zoom;
    const cssW = Math.round(PAGE_W * s);
    const cssH = Math.round(PAGE_H * s);
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    /* 尺寸没变就直接返回：改 canvas.width 会清空画布，若再触发 ResizeObserver 回调就会
       形成「改尺寸 → 回调 → 再改」的抖动循环 */
    if (cssW === this._cssW && cssH === this._cssH && bw === this.cv.width && bh === this.cv.height) return;
    this._cssW = cssW;
    this._cssH = cssH;
    this.paper.style.width = cssW + 'px';
    this.paper.style.height = cssH + 'px';
    /* canvas 的 CSS 尺寸必须和纸面一致：只设 width/height 属性时，元素按属性像素（= CSS × dpr）
       显示，高分屏上画布会比纸面大一圈、墨迹追不上鼠标 */
    this.cv.style.width = cssW + 'px';
    this.cv.style.height = cssH + 'px';
    this.cv.width = bw;
    this.cv.height = bh;
    /* 页面坐标 → 设备像素用真实 backing 尺寸算（避免 round 累积误差） */
    this._k = bw / PAGE_W;
    this._s = this._k / dpr;
    this.redraw();
  }

  setZoom(z) {
    this.zoom = Math.min(3, Math.max(0.4, z));
    this.layout();
  }

  /* ---------- 纸面 ---------- */
  setTemplate(t) {
    this.template = t || 'blank';
    this.paper.classList.remove('tpl-lines', 'tpl-grid', 'tpl-dots');
    if (this.template !== 'blank') this.paper.classList.add('tpl-' + this.template);
  }

  setBg(dataUrl) {
    this.bg = dataUrl || null;
    if (dataUrl) {
      this.paper.style.backgroundColor = '#fff';
      this.paper.style.backgroundImage = `url("${dataUrl}")`;
      this.paper.style.backgroundSize = 'contain';
      this.paper.style.backgroundPosition = 'center';
      this.paper.style.backgroundRepeat = 'no-repeat';
    } else {
      this.paper.style.backgroundImage = '';
      this.paper.style.backgroundSize = '';
      this.paper.style.backgroundPosition = '';
      this.paper.style.backgroundRepeat = '';   // 恢复由模板 class 控制的 repeat
    }
  }

  /* ---------- 页面数据 ---------- */
  loadPage({ template, bg, strokes } = {}) {
    this.setTemplate(template || 'blank');
    this.setBg(bg || null);
    this.strokes = Array.isArray(strokes) ? strokes.map((s) => ({ ...s, pts: s.pts.slice() })) : [];
    this.undoStack = [];
    this.redoStack = [];
    this.redraw();
  }

  getStrokes() { return this.strokes.map((s) => ({ t: s.t, c: s.c, w: s.w, pts: s.pts.slice() })); }
  isEmpty() { return this.strokes.length === 0; }

  /* ---------- 绘制 ---------- */
  _pathFor(st) {
    const ctx = this.ctx;
    const pts = st.pts;
    // pts 是三元组 [x, y, 压力, x, y, 压力, ...]，必须按 3 步长读，按 2 步长会把压力当坐标画成乱线
    const n = Math.floor(pts.length / 3);
    if (n < 1) return;
    ctx.beginPath();
    if (n === 1) { ctx.moveTo(pts[0], pts[1]); ctx.lineTo(pts[0] + 0.01, pts[1]); return; }
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 1; i < n; i++) {
      const x1 = pts[i * 3], y1 = pts[i * 3 + 1];
      const j = i + 1;
      const mx = j < n ? (x1 + pts[j * 3]) / 2 : x1;
      const my = j < n ? (y1 + pts[j * 3 + 1]) / 2 : y1;
      ctx.quadraticCurveTo(x1, y1, mx, my);
    }
  }

  _paintStroke(st) {
    const ctx = this.ctx;
    ctx.save();
    if (st.t === 'er') ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = st.t === 'hl' ? 0.3 : 1;
    ctx.strokeStyle = st.t === 'er' ? 'rgba(0,0,0,1)' : st.c;
    ctx.lineWidth = st.w * (st.t === 'hl' ? 3 : 1) * (st.t === 'er' ? 3 : 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this._pathFor(st);
    ctx.stroke();
    ctx.restore();
  }

  redraw() {
    const ctx = this.ctx;
    const W = this.cv.width, H = this.cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(this._k, 0, 0, this._k, 0, 0);
    for (const st of this.strokes) this._paintStroke(st);
  }

  /* ---------- 输入 ---------- */
  _pt(e) {
    const r = this.cv.getBoundingClientRect();
    /* 用「实际显示宽度 / 页面宽度」换算，而不是缓存下来的 _s：窗口缩放、CSS 变换、dpr 变化时
       缓存的 _s 会和真实显示尺寸脱节，笔迹就会跟不上鼠标（抖动/画歪） */
    const s = (r.width / PAGE_W) || this._s;
    const x = (e.clientX - r.left) / s;
    const y = (e.clientY - r.top) / s;
    const p = typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5;
    return [x, y, p];
  }

  _bind() {
    const cv = this.cv;
    const down = (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      if (this.tool === 'pan') return;     /* 抓手：不在画布上落笔，交给外层做平移 */
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件会抛，忽略 */ }
      const t = this.tool;
      const st = { t, c: this.color, w: this.size, pts: [] };
      this._st = st;
      /* 在落笔前存快照：撤销才能回到「这一笔之前」 */
      this.pushUndo();
      this.strokes.push(st);
      const p = this._pt(e);
      st.pts.push(p[0], p[1], p[2]);
      this._paintStroke(st);
    };
    const move = (e) => {
      if (!this._st) return;
      e.preventDefault();
      const evs = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents()) || [e];
      let added = false;
      for (const ev of evs) {
        const p = this._pt(ev);
        const pts = this._st.pts;
        const lx = pts[pts.length - 3], ly = pts[pts.length - 2];
        if (Math.hypot(p[0] - lx, p[1] - ly) < 1.2) continue;
        pts.push(p[0], p[1], p[2]);
        added = true;
      }
      /* 一次 pointermove 里可能合并了多个采样点：整条重画一次就够，
         以前每个采样点都整幅重画（画布清空→重画所有笔画），高分屏/多笔画时会明显掉帧 */
      if (added) this.redraw();
    };
    const up = () => {
      if (!this._st) return;
      const st = this._st;
      this._st = null;
      if (st.pts.length < 4) st.pts.push(st.pts[0], st.pts[1], st.pts[2] || 0.5);
      this.redraw();
      if (this.onChange) this.onChange();
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', (e) => { if (this._st && e.pointerType === 'mouse') up(); });
  }

  /* ---------- 撤销 / 重做 ---------- */
  pushUndo() {
    this.undoStack.push(this.strokes.map((s) => ({ ...s, pts: s.pts.slice() })));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.strokes.map((s) => ({ ...s, pts: s.pts.slice() })));
    this.strokes = this.undoStack.pop();
    this.redraw();
    if (this.onChange) this.onChange();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.strokes.map((s) => ({ ...s, pts: s.pts.slice() })));
    this.strokes = this.redoStack.pop();
    this.redraw();
    if (this.onChange) this.onChange();
  }

  clear() {
    if (!this.strokes.length) return;
    this.pushUndo();
    this.strokes = [];
    this.redraw();
    if (this.onChange) this.onChange();
  }

  /* ---------- 导出 ---------- */
  async exportPng(scale = 2) {
    const W = PAGE_W * scale, H = PAGE_H * scale;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    /* 和屏幕上的 background-size:contain 保持一致，不把底图拉变形 */
    if (this.bg) {
      await drawImageContain(ctx, this.bg, 0, 0, W, H);
    } else {
      /* 纸面模板线在屏幕上是 CSS 背景，导出时要补画，否则导出图和屏幕不一致 */
      this._paintTemplate(ctx, W, H, scale);
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const st of this.strokes) {
      const saveCtx = this.ctx;
      this.ctx = ctx;
      this._paintStroke(st);
      this.ctx = saveCtx;
    }
    return c.toDataURL('image/png');
  }

  /** 把纸面模板（横线 / 方格 / 点阵）画进导出图；k 为相对 1414×1000 的像素缩放 */
  _paintTemplate(ctx, W, H, k) {
    const t = this.template;
    if (!t || t === 'blank') return;
    ctx.save();
    if (t === 'lines') {
      ctx.strokeStyle = '#e8e0d2';
      ctx.lineWidth = k;
      for (let y = 27.5 * k; y < H; y += 28 * k) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    } else if (t === 'grid') {
      ctx.strokeStyle = '#eee7da';
      ctx.lineWidth = k;
      for (let y = 0; y < H; y += 28 * k) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      for (let x = 0; x < W; x += 28 * k) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    } else if (t === 'dots') {
      ctx.fillStyle = '#ddd3c1';
      const r = 1.1 * k;
      for (let y = 12 * k; y < H; y += 24 * k) {
        for (let x = 12 * k; x < W; x += 24 * k) {
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  async thumb(maxW = 320) {
    const s = maxW / PAGE_W;
    const c = document.createElement('canvas');
    c.width = maxW; c.height = Math.round(PAGE_H * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (this.bg) await drawImageContain(ctx, this.bg, 0, 0, c.width, c.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    for (const st of this.strokes) {
      const saveCtx = this.ctx;
      this.ctx = ctx;
      this._paintStroke(st);
      this.ctx = saveCtx;
    }
    return c.toDataURL('image/jpeg', 0.7);
  }
}

export function drawImageUrl(ctx, url, x, y, w, h) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, x, y, w, h); resolve(); };
    img.onerror = () => resolve();
    img.src = url;
  });
}

/** 按 contain 方式居中画底图（等同 CSS background-size:contain），不拉伸变形 */
export function drawImageContain(ctx, url, x, y, w, h) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
      const k = Math.min(w / iw, h / ih);
      const dw = iw * k, dh = ih * k;
      ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  });
}

/** 图片 → 指定宽度的 JPEG dataURL */
export function imageToDataUrl(img, maxW = 1600, quality = 0.85) {
  const scale = Math.min(1, maxW / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('这张图片读不出来'));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error('读文件失败'));
    fr.readAsDataURL(file);
  });
}
