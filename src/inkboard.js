/* 手写画板引擎：页面坐标固定 W×H，canvas 只负责显示
   - 笔画数据结构：{ t:'pen'|'hl'|'er', c, w, pts:[x,y,p, x,y,p, ...] }
   - 撤销/重做是「笔画数组快照」，橡皮也当作一种笔画重放
   - 模板只影响纸面背景（CSS），不画进 canvas；导出时补一层纸色
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
    this._s = cssW / PAGE_W;
    this.paper.style.width = cssW + 'px';
    this.paper.style.height = cssH + 'px';
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(cssW * dpr);
    this.cv.height = Math.round(cssH * dpr);
    this._k = s * dpr;
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
    if (pts.length < 2) return;
    ctx.beginPath();
    if (pts.length === 2) { ctx.moveTo(pts[0], pts[1]); ctx.lineTo(pts[0] + 0.01, pts[1]); return; }
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i + 1 < pts.length; i += 2) {
      const x0 = pts[i - 2], y0 = pts[i - 1];
      const x1 = pts[i], y1 = pts[i + 1];
      const nx = pts[i + 2], ny = pts[i + 3];
      const mx = (x1 + (nx === undefined ? x1 : nx)) / 2;
      const my = (y1 + (ny === undefined ? y1 : ny)) / 2;
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
    const x = (e.clientX - r.left) / this._s;
    const y = (e.clientY - r.top) / this._s;
    const p = typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5;
    return [x, y, p];
  }

  _bind() {
    const cv = this.cv;
    const down = (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件会抛，忽略 */ }
      const t = this.tool;
      const st = { t, c: this.color, w: this.size, pts: [] };
      this._st = st;
      this.strokes.push(st);
      const p = this._pt(e);
      st.pts.push(p[0], p[1], p[2]);
      this._paintStroke(st);
    };
    const move = (e) => {
      if (!this._st) return;
      e.preventDefault();
      const evs = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents()) || [e];
      for (const ev of evs) {
        const p = this._pt(ev);
        const pts = this._st.pts;
        const lx = pts[pts.length - 3], ly = pts[pts.length - 2];
        if (Math.hypot(p[0] - lx, p[1] - ly) < 1.2) continue;
        pts.push(p[0], p[1], p[2]);
        this._paintStroke(this._st);   // 增量：整条重画（笔画点少，够快）
        this.redraw();
      }
    };
    const up = () => {
      if (!this._st) return;
      const st = this._st;
      this._st = null;
      if (st.pts.length < 4) st.pts.push(st.pts[0], st.pts[1], st.pts[2] || 0.5);
      this.pushUndo();
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
    if (this.bg) {
      await drawImageUrl(ctx, this.bg, 0, 0, W, H);
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

  thumb(maxW = 320) {
    const s = maxW / PAGE_W;
    const c = document.createElement('canvas');
    c.width = maxW; c.height = Math.round(PAGE_H * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (this.bg) drawImageUrl(ctx, this.bg, 0, 0, c.width, c.height);
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
