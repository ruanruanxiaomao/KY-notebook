/* 手写板（像输入法那样写字→出字）
   自己画一个小画布：只画笔画折线，抬笔后停 idle 毫秒自动识别，
   识别结果按「自动上屏 / 点候选上屏」两种情况交给外面。
*/
import { inkToCanvas, recognizeLocal, recognizeAI, getHwrCfg, setHwrCfg, ensureLocalEngine,
  isPunctLike, guessPunct } from './hwr.js';
import { chat, getCfg } from './ai.js';

export class HwrPad {
  constructor(els, opts = {}) {
    this.bar = els.bar;
    this.cv = els.cv;
    this.candsEl = els.cands;
    this.statusEl = els.status;
    this.autoEl = els.auto;
    this.engineEl = els.engine;
    this.opts = opts;                  // { onCommit, onBack, onNewline, onStatus }
    this.strokes = [];                 // [{ pts:[[x,y]...], w }]
    this.cur = null;
    this.timer = 0;
    this.busy = false;
    this.open = false;
    this.lastInk = null;               // 最近一次识别的墨迹快照（给 AI 复核用）
    this.lastText = '';
    this.lastCommitted = '';
    this._pend = 0;
    this._lastPaint = 0;
    this._dpr = 1;
    this._bindCanvas();
    this._bindHead();
    const cfg = getHwrCfg();
    this.autoEl.checked = cfg.auto;
    this.engineEl.value = cfg.engine;
    this.idle = cfg.idle;
  }

  /* ---------- 开关 ---------- */
  show(on) {
    this.open = on !== false;
    this.bar.hidden = !this.open;
    if (this.open) {
      this.resize();
      if (getHwrCfg().engine === 'local') {
        /* 打开就开始拉模型，别等第一笔写完才慢 */
        this.setStatus('离线引擎准备中…');
        ensureLocalEngine().then(
          () => { if (this.open) this.setStatus(''); },
          (e) => this.setStatus(e.message || String(e), true),
        );
      }
    } else {
      this.clear();
    }
  }

  setStatus(msg, bad) {
    if (!this.statusEl) return;
    this.statusEl.textContent = msg || '';
    this.statusEl.className = 'hwr-status' + (bad ? ' bad' : '');
  }

  /* ---------- 画布 ---------- */
  resize() {
    const r = this.cv.getBoundingClientRect();
    const cssW = Math.max(120, Math.round(r.width));
    const cssH = Math.max(80, Math.round(r.height));
    const dpr = window.devicePixelRatio || 1;
    if (cssW === this._cssW && cssH === this._cssH && dpr === this._dpr) return;
    this._cssW = cssW;
    this._cssH = cssH;
    this._dpr = dpr;
    this.cv.width = Math.round(cssW * dpr);
    this.cv.height = Math.round(cssH * dpr);
    this.paint();
  }

  _pos(e) {
    const r = this._rect || (this._rect = this.cv.getBoundingClientRect());
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _bindCanvas() {
    const cv = this.cv;
    if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(cv);

    const down = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      this._rect = cv.getBoundingClientRect();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件 */ }
      this.cur = { pts: [this._pos(e)], w: 4 };
      this.strokes.push(this.cur);
      this._paintNow(true);
    };

    const move = (e, raw) => {
      if (!this.cur) return;
      if (e.cancelable) e.preventDefault();
      const list = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents()) || [];
      const evs = list.length ? list : [e];
      let added = false;
      for (const ev of evs) {
        const p = this._pos(ev);
        const pts = this.cur.pts;
        const l = pts[pts.length - 1];
        if (Math.hypot(p[0] - l[0], p[1] - l[1]) < 0.7) continue;
        pts.push(p);
        added = true;
      }
      if (added) this._paintNow(raw);
    };

    const up = (e) => {
      if (!this.cur) return;
      if (e && typeof e.clientX === 'number') {
        const p = this._pos(e);
        const pts = this.cur.pts;
        const l = pts[pts.length - 1];
        if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.5) pts.push(p);
      }
      this.cur = null;
      this._rect = null;
      this.paint();
      this.resetIdle();
    };

    if ('onpointerrawupdate' in cv) cv.addEventListener('pointerrawupdate', (e) => move(e, true));
    cv.addEventListener('pointermove', (e) => move(e, false));
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  /** 写字时立刻画（最多 8ms 一次），比等 rAF 少一帧延迟 */
  _paintNow(force) {
    const now = performance.now();
    if (!force && now - this._lastPaint < 8) {
      if (!this._pend) {
        this._pend = requestAnimationFrame(() => { this._pend = 0; this.paint(); });
      }
      return;
    }
    this._lastPaint = now;
    this.paint();
  }

  paint() {
    const g = this.cv.getContext('2d');
    const d = this._dpr || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    g.setTransform(d, 0, 0, d, 0, 0);
    g.strokeStyle = '#1f1c18';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const s of this.strokes) {
      if (!s.pts.length) continue;
      g.lineWidth = s.w || 4;
      g.beginPath();
      g.moveTo(s.pts[0][0], s.pts[0][1]);
      if (s.pts.length === 1) g.lineTo(s.pts[0][0] + 0.6, s.pts[0][1]);
      for (let i = 1; i < s.pts.length; i++) g.lineTo(s.pts[i][0], s.pts[i][1]);
      g.stroke();
    }
  }

  /* ---------- 识别 ---------- */
  resetIdle() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), this.idle);
  }

  clear() {
    clearTimeout(this.timer);
    this.strokes = [];
    this.cur = null;
    this.paint();
  }

  undoStroke() {
    this.strokes.pop();
    this.paint();
  }

  async run() {
    if (this.busy || !this.strokes.length) return;
    const snapshot = this.strokes.map((s) => ({ w: s.w, pts: s.pts.slice() }));
    const ink = inkToCanvas(snapshot);
    if (!ink) return;
    this.busy = true;
    this.lastInk = ink;
    /* 先清板：跟输入法一样，认的同时可以接着写下一笔 */
    this.strokes = [];
    this.paint();
    this.setStatus('识别中…');
    const cfg = getHwrCfg();
    try {
      let r;
      if (cfg.engine === 'ai') {
        if (!getCfg().vision) throw new Error('AI 引擎需要模型「支持看图」，去设置里勾上；或改用离线');
        r = await recognizeAI(ink, chat);
      } else {
        r = await recognizeLocal(ink);
      }
      this.setStatus('');
      /* 标点兜底：手写板上写一个「，」「。」模型常返回空或乱码，按形状补一个 */
      if (!r.text || !/^[，。？！：；、,.?!:;]+$/.test(r.text)) {
        if (isPunctLike(snapshot, 0)) {
          const g = guessPunct(snapshot, 0);
          if (g) { r.text = g; r.score = 0.4; }
        }
      }
      if (!r.text) {
        if (!this.strokes.length) this.strokes = snapshot;   // 没认出来就把笔迹还回去
        this.paint();
        this.setStatus('没认出来，再写一次', true);
        return;
      }
      this.lastText = r.text;
      this.emit(r.text, r.ms);
    } catch (e) {
      if (!this.strokes.length) this.strokes = snapshot;
      this.paint();
      this.setStatus(e.message || String(e), true);
    } finally {
      this.busy = false;
    }
  }

  emit(text, ms) {
    const cfg = getHwrCfg();
    this.addCand(text, ms);
    if (cfg.auto) this.commit(text);
    else this.setStatus('点上面的候选上屏');
  }

  commit(text) {
    this.lastCommitted = text;
    if (this.opts.onCommit) this.opts.onCommit(text);
  }

  /* ---------- 候选条 ---------- */
  addCand(text, ms) {
    this.candsEl.innerHTML = '';
    const chip = (label, fn, title, cls) => {
      const b = document.createElement('button');
      b.className = 'hwr-chip' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.title = title || '';
      b.onclick = fn;
      this.candsEl.appendChild(b);
    };
    chip(text, () => this.commit(text), '点一下写进笔记');
    if (ms) {
      const t = document.createElement('span');
      t.className = 'hwr-ms';
      t.textContent = ms + 'ms';
      this.candsEl.appendChild(t);
    }
    if (this.lastInk && getCfg().vision) {
      chip('AI 再看', async () => {
        this.setStatus('AI 识别中…');
        try {
          const r = await recognizeAI(this.lastInk, chat);
          this.setStatus('');
          if (!r.text) { this.setStatus('AI 也没认出来', true); return; }
          const chip2 = document.createElement('button');
          chip2.className = 'hwr-chip ai';
          chip2.textContent = 'AI：' + r.text;
          chip2.onclick = () => {
            /* 上次自动上屏的如果就是本地结果，先退掉再写 AI 的 */
            if (this.lastCommitted && this.lastCommitted !== r.text && this.opts.onBack) {
              this.opts.onBack(this.lastCommitted.length);
            }
            this.commit(r.text);
          };
          this.candsEl.appendChild(chip2);
        } catch (e) {
          this.setStatus(e.message || String(e), true);
        }
      }, '把这次笔迹交给多模态模型再看一遍', 'ghost');
    }
  }

  /* ---------- 顶部控件 ---------- */
  _bindHead() {
    this.autoEl.onchange = () => {
      const c = getHwrCfg();
      c.auto = this.autoEl.checked;
      setHwrCfg(c);
      this.setStatus(c.auto ? '自动上屏：开' : '自动上屏：关，点候选才写进去');
      setTimeout(() => this.setStatus(''), 1600);
    };
    this.engineEl.onchange = () => {
      const c = getHwrCfg();
      c.engine = this.engineEl.value;
      setHwrCfg(c);
      if (c.engine === 'local') {
        this.setStatus('离线引擎准备中…');
        ensureLocalEngine().then(() => this.setStatus(''), (e) => this.setStatus(e.message, true));
      } else {
        this.setStatus(getCfg().vision ? 'AI 识别：每次要等 2~5 秒' : '先去设置勾「支持看图」');
      }
    };
  }
}
