/* 手写画板引擎：页面坐标固定 W×H，canvas 只负责显示
   - 笔画数据结构：{ t:'pen'|'hl'|'er', c, w, pts:[x,y,p, x,y,p, ...] }
   - 工具：pen 笔 / hl 荧光 / er 像素橡皮 / del 整笔删除（点一下就删掉那一笔，Xournal++ 的 delete stroke）
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
    /* desynchronized：Chromium 上允许跳过一部分合成同步，实测能压低笔迹延迟 */
    this.ctx = canvas.getContext('2d', { desynchronized: true });
    /* 离屏画布只放「已完成的笔画」：抬笔时把这一笔盖上去，之后每帧只 drawImage 一次，
       不再每来一个采样点就把全部笔画重画一遍（笔画一多就是这里卡的） */
    this._off = document.createElement('canvas');
    this._offCtx = this._off.getContext('2d');
    this.zoom = opts.zoom || 1;
    /* 页面坐标系：默认 1414x1000；批注页按 PDF / 图片的版式比例改成竖版，笔迹才不会挤在中间一条 */
    this.pageW = opts.pageW || PAGE_W;
    this.pageH = opts.pageH || PAGE_H;
    this.tool = 'pen';
    this.color = COLORS[0];
    this.size = SIZES[1];
    this.strokes = [];
    this.hidden = new Set();        /* 暂时不画的笔画：边写边识别时，墨迹「变成」文字的那一刻藏起来 */
    this.undoStack = [];
    this.redoStack = [];
    this.bg = null;
    this.template = 'blank';
    /* 页面元素：{ type:'image'|'text', x,y,w,h, z:'below'|'above', src|text, size, color }
       屏幕上是 DOM（可拖可删），导出 PNG / 缩略图时由下面的 _paintItems 画进来 */
    this.items = [];
    this._st = null;
    this._rect = null;   // 一次手势只读一次 getBoundingClientRect
    this._pred = null;   // 浏览器预测的后续点（只画、不写进数据）
    this._raf = 0;
    this._rawAt = 0;     // 最近一次 pointerrawupdate 的时间戳，用来避免和 pointermove 重复
    this._k = 1;      // 页面坐标 → 设备像素
    this._s = 1;      // 页面坐标 → CSS 像素
    this.onChange = null;
    this.onStrokeEnd = null;         /* 抬笔后回调：画布自动转文字要用 */
    this.onStrokeStart = null;       /* 落笔回调：正在等的「开始识别」定时器要先停掉（新笔画=还在写同一个字） */
    this.onItemsChanged = null;      /* 撤销恢复了元素：交给上层重画 DOM */
    this.hud = null;                 /* 调试用的延迟面板 */
    this._lag = { n: 0, sum: 0, max: 0 };
    this._fps = { t: 0, n: 0, v: 0 };
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
    const s = Math.min(availW / this.pageW, availH / this.pageH, 1) * this.zoom;
    const cssW = Math.round(this.pageW * s);
    const cssH = Math.round(this.pageH * s);
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
    this._off.width = bw;
    this._off.height = bh;
    this._rect = null;
    /* 页面坐标 → 设备像素用真实 backing 尺寸算（避免 round 累积误差） */
    this._k = bw / this.pageW;
    this._s = this._k / dpr;
    this.redraw();
  }

  setZoom(z) {
    this.zoom = Math.min(5, Math.max(0.3, z));
    this.layout();
  }

  /* 换页面比例（批注页每页按自己的版式设一次） */
  setPageSize(w, h) {
    const W = Math.max(200, Math.round(w || PAGE_W));
    const H = Math.max(200, Math.round(h || PAGE_H));
    if (W === this.pageW && H === this.pageH) return;
    this.pageW = W;
    this.pageH = H;
    this._cssW = -1;                 /* 强制重新算尺寸 */
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
  loadPage({ template, bg, strokes, items } = {}) {
    this.setTemplate(template || 'blank');
    this.setBg(bg || null);
    this.items = Array.isArray(items) ? items.map((it) => ({ ...it })) : [];
    this.strokes = Array.isArray(strokes) ? strokes.map((s) => ({ ...s, pts: s.pts.slice() })) : [];
    this.undoStack = [];
    this.redoStack = [];
    this.hidden.clear();
    this.redraw();
  }

  /** 存盘用的笔画：排除「已经变成文字、暂时藏起来」的那些，否则重开会墨迹+文字重影 */
  getStrokes() {
    return this.strokes.filter((s) => !this.hidden.has(s))
      .map((s) => ({ t: s.t, c: s.c, w: s.w, pts: s.pts.slice() }));
  }
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

  /** 每种笔的粗细曲线：min/max 是「压力 0 → 1」时的倍率，mul 是整体倍率，alpha 是不透明度 */
  static get BRUSHES() {
    return {
      pen: { mul: 1.0, min: 0.42, max: 1.05, alpha: 1 },     /* 钢笔：压感明显 */
      ball: { mul: 1.0, min: 1.0, max: 1.0, alpha: 1 },      /* 圆珠笔：粗细均匀 */
      pencil: { mul: 0.92, min: 0.72, max: 1.0, alpha: 0.72 }, /* 铅笔：淡、略有颗粒 */
      brush: { mul: 1.5, min: 0.3, max: 1.5, alpha: 1 },     /* 毛笔：起收锋 + 压感 */
      calli: { mul: 1.35, min: 1.0, max: 1.0, alpha: 1 },    /* 书法：按走向变粗细（扁笔尖） */
      hl: { mul: 3.2, min: 1.0, max: 1.0, alpha: 0.3 },      /* 荧光笔 */
      er: { mul: 3.0, min: 1.0, max: 1.0, alpha: 1 },
    };
  }

  /** 单段的粗细（页面坐标） */
  _segWidth(t, base, p, i, n, x0, y0, x1, y1) {
    const B = InkBoard.BRUSHES[t] || InkBoard.BRUSHES.pen;
    let w = base * B.mul;
    if (t === 'calli') {
      /* 扁笔尖：笔画方向和笔尖夹角越接近 90°，线越粗 */
      const ang = Math.atan2(y1 - y0, x1 - x0);
      w *= 0.28 + 0.95 * Math.abs(Math.sin(ang - 0.785));
    } else {
      w *= B.min + (B.max - B.min) * Math.max(0, Math.min(1, p));
      if (t === 'brush') {
        /* 起笔收笔各 3 个点收细，像毛笔的锋 */
        const taper = Math.min(1, i / 3, (n - i) / 3);
        w *= 0.32 + 0.68 * Math.max(0, taper);
      }
    }
    return Math.max(0.55, w);
  }

  _paintStroke(st) {
    const ctx = this.ctx;
    const t = st.t || 'pen';
    const B = InkBoard.BRUSHES[t] || InkBoard.BRUSHES.pen;
    const pts = st.pts;
    const n = Math.floor(pts.length / 3);
    if (!n) return;
    ctx.save();
    if (t === 'er') ctx.globalCompositeOperation = 'destination-out';
    else if (t === 'hl') ctx.globalCompositeOperation = 'multiply';   /* 荧光笔：叠在字上不糊 */
    ctx.globalAlpha = B.alpha;
    ctx.strokeStyle = t === 'er' ? 'rgba(0,0,0,1)' : st.c;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const base = st.w || 4;
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(pts[0], pts[1], this._segWidth(t, base, pts[2], 1, 1, 0, 0, 1, 0) / 2, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      ctx.restore();
      return;
    }
    /* 逐段按压力给粗细；相邻且粗细接近的段攒成一条 path，最多 8 档，别一段一次 stroke */
    /* 平滑坐标：手指/触屏的采样本身有 1–3px 的高频抖动，直接用原始点画就是「折线」。
       这里对坐标做一次 3 抽头加权（0.25 / 0.5 / 0.25），只影响画法、不改 st.pts 里的数据；
       端点保持原样，长直线上的交替抖动会被磨平，粗细与压力不受影响。 */
    const sx = new Array(n), sy = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3], y = pts[i * 3 + 1];
      if (i === 0 || i === n - 1) { sx[i] = x; sy[i] = y; continue; }
      sx[i] = pts[(i - 1) * 3] * 0.25 + x * 0.5 + pts[(i + 1) * 3] * 0.25;
      sy[i] = pts[(i - 1) * 3 + 1] * 0.25 + y * 0.5 + pts[(i + 1) * 3 + 1] * 0.25;
    }

    const q = Math.max(0.35, base * 0.12);
    let curW = -1;
    let open = false;
    /* 折线成段是因为「每个采样点之间直接 lineTo」：手指采样本身有 1–3px 抖动，
       逐段直连就把抖动画成了看得见的折角。改成过相邻中点的二次曲线，控制点用真实采样点，
       曲线仍然贴着笔迹，但折角被磨圆了（笔迹数据不变，只是画法变了）。 */
    let px = sx[0], py = sy[0];
    for (let i = 1; i < n; i++) {
      const x0 = px, y0 = py;
      const x1 = sx[i], y1 = sy[i];
      const p = (pts[(i - 1) * 3 + 2] + pts[i * 3 + 2]) / 2;
      let w = this._segWidth(t, base, p, i, n, x0, y0, x1, y1);
      if (t === 'pencil') {
        /* 铅笔的颗粒：用笔画种子做确定性抖动，重画时不会闪 */
        const sd = (st.seed || 1) * 12.9898 + i * 78.233;
        w *= 0.88 + 0.24 * Math.abs(Math.sin(sd) % 1);
      }
      const qw = Math.max(q, Math.round(w / q) * q);
      if (qw !== curW) {
        if (open) ctx.stroke();
        ctx.lineWidth = qw;
        ctx.beginPath();
        ctx.moveTo(px, py);
        curW = qw;
        open = true;
      }
      const mx = (px + x1) / 2;
      const my = (py + y1) / 2;
      ctx.quadraticCurveTo(px, py, mx, my);
      px = x1;
      py = y1;
    }
    if (open) {
      ctx.lineTo(px, py);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 全量重建：所有笔画先画进离屏，再合成一次 */
  redraw() {
    const W = this.cv.width;
    const H = this.cv.height;
    const octx = this._offCtx;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, W, H);
    octx.setTransform(this._k, 0, 0, this._k, 0, 0);
    const save = this.ctx;
    this.ctx = octx;
    for (const st of this.strokes) if (!this.hidden.has(st)) this._paintStroke(st);
    this.ctx = save;
    this.drawLive();
  }

  /** 每帧只做一次：离屏 + 正在写的这一笔（+ 预测点） */
  drawLive() {
    const ctx = this.ctx;
    const W = this.cv.width;
    const H = this.cv.height;
    const t0 = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this._off, 0, 0);
    const st = this._st;
    if (st) {
      ctx.setTransform(this._k, 0, 0, this._k, 0, 0);
      this._paintStroke(st);
      this._paintPredicted(ctx, st);
    }
    /* FPS 统计（只喂给延迟面板） */
    const now = performance.now();
    if (now - this._fps.t > 500) {
      if (this._fps.t) this._fps.v = Math.round(this._fps.n * 1000 / (now - this._fps.t));
      this._fps.t = now;
      this._fps.n = 0;
    } else {
      this._fps.n++;
    }
    this._frameMs = performance.now() - t0;
  }

  /** 笔尾的预测段：只为「看起来跟手」，不进 strokes 数据，下一帧自然被真实点覆盖 */
  _paintPredicted(ctx, st) {
    const pred = this._pred;
    if (!pred || !pred.length) return;
    const n = st.pts.length;
    if (n < 3) return;
    ctx.save();
    const BT = InkBoard.BRUSHES[st.t] || InkBoard.BRUSHES.pen;
    ctx.globalAlpha = BT.alpha;
    if (st.t === 'hl') ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = st.c;
    ctx.lineWidth = this._segWidth(st.t, st.w || 4, st.pts[n - 1], n / 3, n / 3 + 1,
      st.pts[n - 3], st.pts[n - 2], pred[0][0], pred[0][1]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(st.pts[n - 3], st.pts[n - 2]);
    for (const q of pred) ctx.lineTo(q[0], q[1]);
    ctx.stroke();
    ctx.restore();
  }

  _scheduleDraw() {
    /* 一帧只画一次，但别干等 rAF：事件到的时候如果距上一笔已经过了 10ms，
       就直接画（下一帧 vsync 立刻能看到），能省掉最多一整帧的等待 */
    const now = performance.now();
    if (!this._raf && now - (this._lastDraw || 0) >= 10) {
      this._lastDraw = now;
      this.drawLive();
      return;
    }
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._lastDraw = performance.now();
      this.drawLive();
    });
  }

  /** 抬笔：把这一笔画进离屏（O(1)，不重画其它笔画） */
  _commit(st) {
    const octx = this._offCtx;
    octx.setTransform(this._k, 0, 0, this._k, 0, 0);
    const save = this.ctx;
    this.ctx = octx;
    this._paintStroke(st);
    this.ctx = save;
  }

  /* ---------- 输入 ---------- */
  _pt(e) {
    /* 每帧每个采样点都调 getBoundingClientRect 会强制同步布局，是卡顿的主因之一；
       一笔只读一次（落笔时刷新），layout() 里会清空缓存 */
    const r = this._rect || (this._rect = this.cv.getBoundingClientRect());
    const s = (r.width / this.pageW) || this._s;
    const x = (e.clientX - r.left) / s;
    const y = (e.clientY - r.top) / s;
    const p = typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5;
    return [x, y, p];
  }

  _bind() {
    const cv = this.cv;

    const down = (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      /* 多指/手掌：同一时刻只认一根指针。以前不判 pointerId，写字的指头还在动、
         另一根手指（或手掌）又按下来，两路 move 会把点插进同一笔，直线变成折线。 */
      if (this._st) return;
      if (e.pointerType === 'touch' && this._penAt && (performance.now() - this._penAt) < 1500) {
        return;   /* 手写笔在附近时，手指一律当掌拒，不落笔 */
      }
      e.preventDefault();
      if (this.tool === 'pan') return;     /* 抓手：不在画布上落笔，交给外层做平移 */
      if (this.tool === 'sel') return;     /* 选择：点的是插入的图片/文字，不落笔 */
      if (this.tool === 'lasso') return;   /* 圈选：框选由上层做，别画上去 */
      if (this.tool === 'text') return;    /* 打字：点一下由上层放输入框 */
      if (this.tool === 'del') {           /* 整笔删除：点一下删掉命中的那一笔 */
        this._delOn = true;
        this._delPushed = false;
        this._rect = cv.getBoundingClientRect();
        this.eraseAt(e);
        return;
      }
      /* 落笔时刷一次矩形：整笔期间复用，避免每个采样点都触发一次强制布局 */
      this._rect = cv.getBoundingClientRect();
      if (e.pointerType === 'pen') this._penAt = performance.now();
      if (this.onStrokeStart) this.onStrokeStart();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件会抛，忽略 */ }
      const t = this.tool;
      const st = { t, c: this.color, w: this.size, pts: [], seed: (Math.random() * 997) | 0 };
      this._st = st;
      this._pid = e.pointerId;
      this._pred = null;
      /* 在落笔前存快照：撤销才能回到「这一笔之前」 */
      this.pushUndo();
      this.strokes.push(st);
      const p = this._pt(e);
      st.pts.push(p[0], p[1], p[2]);
      this.drawLive();
    };

    /** isRaw=true 来自 pointerrawupdate（平台允许的最高频率，早于被节流的 pointermove） */
    const move = (e, isRaw) => {
      if (this._st && this._pid !== undefined && e.pointerId !== this._pid) return;
      if (this._delOn) { this.eraseAt(e); return; }
      if (!this._st) return;
      if (!isRaw && this._rawAt && (e.timeStamp || performance.now()) - this._rawAt < 120) {
        return;   /* 同一批点已经由 raw 处理过，pointermove 别再重复加 */
      }
      if (isRaw) this._rawAt = e.timeStamp || performance.now();
      if (e.cancelable) e.preventDefault();
      if (this.hud && isRaw && e.timeStamp) {
        const lag = performance.now() - e.timeStamp;
        if (lag >= 0 && lag < 400) {
          this._lag.n++;
          this._lag.sum += lag;
          if (lag > this._lag.max) this._lag.max = lag;
        }
      }

      /* 注意：getCoalescedEvents() 可能返回空数组（某些实现 / 合成事件），不能直接 || [e] */
      const list = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents()) || [];
      const evs = list.length ? list : [e];
      let added = false;
      for (const ev of evs) {
        const p = this._pt(ev);
        const pts = this._st.pts;
        const lx = pts[pts.length - 3];
        const ly = pts[pts.length - 2];
        if (Math.hypot(p[0] - lx, p[1] - ly) < this._minStep()) continue;
        pts.push(p[0], p[1], p[2]);
        added = true;
      }

      /* 预测点：只画不存，用来补「笔已经走到、画面还没跟上」的那一两帧 */
      if (typeof e.getPredictedEvents === 'function') {
        try {
          const pr = e.getPredictedEvents();
          this._pred = pr && pr.length ? pr.map((ev) => this._pt(ev)) : null;
        } catch (err) { this._pred = null; }
      } else {
        this._pred = null;
      }

      /* 一帧只画一次：一帧内可能来 4~8 个采样点，以前每个点都整幅重绘一次 */
      if (added || this._pred) this._scheduleDraw();
    };

    const up = (e) => {
      this._delOn = false;
      if (e && e.pointerType === 'pen') this._penAt = performance.now();
      if (e && this._pid !== undefined && e.pointerId !== undefined && e.pointerId !== this._pid) return;
      this._pid = undefined;
      if (!this._st) return;
      const st = this._st;
      this._st = null;
      this._pred = null;
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }

      /* 抬起前最后一点：raw 模式下可能还没进 strokes，补上（否则笔尾会缺一小段） */
      if (e && typeof e.clientX === 'number') {
        const p = this._pt(e);
        const n = st.pts.length;
        if (n < 3 || Math.hypot(p[0] - st.pts[n - 3], p[1] - st.pts[n - 2]) > 0.6) {
          st.pts.push(p[0], p[1], p[2]);
        }
      }
      if (st.pts.length < 4) st.pts.push(st.pts[0], st.pts[1], st.pts[2] || 0.5);

      this._commit(st);          /* 这一笔盖进离屏，其它笔画不用重画 */
      this.drawLive();
      this._rect = null;
      if (this.onChange) this.onChange();
      if (this.onStrokeEnd) this.onStrokeEnd(st);
      if (this.hud) this._hudUpdate(st);
    };

    /* 高频采样：pointerrawupdate 比 pointermove 更早、更密（Chromium 支持）；
       不支持的环境退回 pointermove，行为不变 */
    /* pointerrawupdate 在桌面 Chromium 上坐标是对的，但在 Android WebView 里
       clientY 会和 pointerdown/pointermove 差一个「WebView 顶部内边距」的距离
       （实测 44 CSS px：raw 给 518、move 给 474），于是落笔点和抬笔点各被拉出
       一段竖钩，画直线看起来像「一竖一横再一竖」。
       在 Android 上宁可少一点采样率，也不要错的坐标：只用 pointermove。 */
    var isAndroidWebView = /Android/i.test(navigator.userAgent);
    if (!isAndroidWebView && 'onpointerrawupdate' in cv) {
      cv.addEventListener('pointerrawupdate', (e) => move(e, true));
    }
    cv.addEventListener('pointermove', (e) => move(e, false));
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', (e) => { if (this._st && e.pointerType === 'mouse') up(e); });
  }

  /** 两个采样点之间的最小距离，按「屏幕上 1.1px」折算成页面坐标：
      缩得越小、屏幕越密，阈值越小，保证慢写时也不会把点吃掉 */
  _minStep() {
    const w = (this._rect && this._rect.width) || this.cv.clientWidth || this.pageW;
    return Math.max(0.12, 1.1 * this.pageW / Math.max(1, w));
  }


  /* ---------- 整笔删除 ---------- */
  /** 命中阈值按「屏幕 10px」换算成页面坐标，放大时更精确 */
  _hitTol() {
    const s = this._s || 1;
    return Math.max(4, 9 / Math.max(0.15, s));
  }

  /** 把笔画拆成线段，返回点到折线的最短距离 */
  _distToStroke(st, x, y) {
    const pts = st.pts;
    const n = Math.floor(pts.length / 3);
    if (!n) return Infinity;
    const tol = (st.w || 4) * (st.t === 'hl' ? 1.6 : 0.6);
    if (n === 1) return Math.hypot(x - pts[0], y - pts[1]) - tol;
    let best = Infinity;
    for (let i = 1; i < n; i++) {
      const x1 = pts[(i - 1) * 3], y1 = pts[(i - 1) * 3 + 1];
      const x2 = pts[i * 3], y2 = pts[i * 3 + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d < best) best = d;
    }
    return best - tol;
  }

  /** 删掉命中的笔画（可拖动连续删）；一次拖动只记一次撤销 */
  /* ---------- 输入延迟面板（设置里可开，用来判断「不跟手」卡在哪一环） ---------- */
  setHud(on) {
    if (!on) {
      if (this.hud) { this.hud.remove(); this.hud = null; }
      return;
    }
    if (this.hud) return;
    const d = document.createElement('div');
    d.className = 'ink-hud';
    d.textContent = '写一笔看数据';
    document.body.appendChild(d);
    this.hud = d;
  }

  _hudUpdate(st) {
    const l = this._lag;
    const avg = l.n ? (l.sum / l.n) : 0;
    const pts = Math.floor(st.pts.length / 3);
    this.hud.innerHTML = `输入延迟 平均 <b>${avg.toFixed(1)}</b>ms / 峰值 ${l.max.toFixed(0)}ms<br>`
      + `本笔 ${pts} 点 · 绘制 ${(this._frameMs || 0).toFixed(1)}ms · ${this._fps.v || 0}fps`;
    l.n = 0; l.sum = 0; l.max = 0;
    if (st.t === 'er') return;
  }

  eraseAt(e) {
    if (!this.strokes.length) return false;
    const [x, y] = this._pt(e);
    const tol = this._hitTol();
    let hit = -1;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this._distToStroke(this.strokes[i], x, y) <= tol) { hit = i; break; }
    }
    if (hit < 0) return false;
    if (!this._delPushed) { this.pushUndo(); this._delPushed = true; }
    this.strokes.splice(hit, 1);
    this.redraw();
    if (this.onChange) this.onChange();
    return true;
  }

  /* ---------- 撤销 / 重做 ---------- */
  /** 快照带上页面元素：「墨迹转文字」要能一步撤回成原来的笔迹 */
  _snap() {
    return {
      strokes: this.strokes.map((s) => ({ ...s, pts: s.pts.slice() })),
      items: (this.items || []).map((it) => ({ ...it })),
    };
  }

  _applySnap(s) {
    this.strokes = s.strokes;
    this.hidden.clear();
    if (Array.isArray(s.items) && Array.isArray(this.items)) {
      this.items.length = 0;
      for (const it of s.items) this.items.push(it);
      if (this.onItemsChanged) this.onItemsChanged();
    }
  }

  pushUndo() {
    this.undoStack.push(this._snap());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    if (!this.undoStack.length) return;
    if (this.onBeforeUndo) this.onBeforeUndo();
    this.redoStack.push(this._snap());
    this._applySnap(this.undoStack.pop());
    this.redraw();
    if (this.onChange) this.onChange();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snap());
    this._applySnap(this.redoStack.pop());
    this.redraw();
    if (this.onChange) this.onChange();
  }

  /** 删掉指定的这些笔画（墨迹转文字用）：一次操作只记一次撤销 */
  removeStrokes(list) {
    if (!list || !list.length) return 0;
    const set = new Set(list);
    const before = this.strokes.length;
    this.strokes = this.strokes.filter((s) => !set.has(s));
    const n = before - this.strokes.length;
    if (n) {
      for (const st of list) this.hidden.delete(st);
      this.redraw();
      if (this.onChange) this.onChange();
    }
    return n;
  }

  /** 暂时藏起 / 放出这些笔画（不删数据，用于「墨迹正在变成文字」的过渡） */
  hideStrokes(list, on) {
    if (!list || !list.length) return;
    for (const st of list) {
      if (on) this.hidden.add(st); else this.hidden.delete(st);
    }
    this.redraw();
  }

  /** 矩形（页面坐标）里碰到的笔画：套索圈选转文字用 */
  strokesInRect(x0, y0, x1, y1) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const out = [];
    for (const st of this.strokes) {
      const pts = st.pts;
      const total = Math.floor(pts.length / 3);
      if (!total) continue;
      let inside = 0;
      for (let i = 0; i < pts.length; i += 3) {
        if (pts[i] >= ax && pts[i] <= bx && pts[i + 1] >= ay && pts[i + 1] <= by) inside++;
      }
      /* 一半以上的点在框里才算，免得把划过去的笔误收进来 */
      if (inside / total >= 0.5) out.push(st);
    }
    return out;
  }

  clear() {
    if (!this.strokes.length) return;
    this.pushUndo();
    this.strokes = [];
    this.redraw();
    if (this.onChange) this.onChange();
  }

  /* ---------- 页面元素 ---------- */
  /** 画一层元素（below 在笔迹下、above 在笔迹上） */
  async _paintItems(ctx, k, layer) {
    const list = (this.items || []).filter((it) => (it.z || 'below') === layer);
    for (const it of list) {
      if (it.type === 'image' && it.src) {
        await drawImageFit(ctx, it.src, it.x * k, it.y * k, it.w * k, it.h * k);
      } else if (it.type === 'text') {
        this._paintText(ctx, it, k);
      }
    }
  }

  _paintText(ctx, it, k) {
    const size = Math.max(6, (it.size || 28) * k);
    /* 行距跟屏幕上的 .tx 用同一个值（以前这里写死 1.55，导出比屏幕松，看着不齐） */
    const lhK = Math.max(1.05, Math.min(3, Number(it.lh) || 1.3));
    const lh = size * lhK;
    const maxW = Math.max(10, it.w * k);
    ctx.save();
    ctx.font = `${size}px ${this.textFont || 'system-ui, sans-serif'}`;
    ctx.fillStyle = it.color || '#1f1c18';
    ctx.textBaseline = 'top';
    const lines = [];
    String(it.text || '').split('\n').forEach((par) => {
      if (!par) { lines.push(''); return; }
      let cur = '';
      for (const ch of par) {
        if (cur && ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; }
        else cur += ch;
      }
      lines.push(cur);
    });
    lines.forEach((ln, i) => ctx.fillText(ln, it.x * k, it.y * k + i * lh));
    ctx.restore();
  }

  /* ---------- 导出 ---------- */
  async exportPng(scale = 2) {
    /* 导出期间会临时把 this.ctx 指向离屏画布，先把待画的帧取消，避免画串 */
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    const W = this.pageW * scale, H = this.pageH * scale;
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
    /* 元素要在 identity 变换下画（内部按 k 自己换算），且分上下两层 */
    await this._paintItems(ctx, scale, 'below');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const st of this.strokes) {
      if (this.hidden.has(st)) continue;
      const saveCtx = this.ctx;
      this.ctx = ctx;
      this._paintStroke(st);
      this.ctx = saveCtx;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    await this._paintItems(ctx, scale, 'above');
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
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    const s = maxW / this.pageW;
    const c = document.createElement('canvas');
    c.width = maxW; c.height = Math.round(this.pageH * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    if (this.bg) await drawImageContain(ctx, this.bg, 0, 0, c.width, c.height);
    await this._paintItems(ctx, s, 'below');
    ctx.setTransform(s, 0, 0, s, 0, 0);
    for (const st of this.strokes) {
      if (this.hidden.has(st)) continue;
      const saveCtx = this.ctx;
      this.ctx = ctx;
      this._paintStroke(st);
      this.ctx = saveCtx;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    await this._paintItems(ctx, s, 'above');
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

/** 按 contain 画进 (x,y,w,h)，元素框变了也不变形 */
export function drawImageFit(ctx, url, x, y, w, h) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      const k = Math.min(w / iw, h / ih);
      const dw = iw * k;
      const dh = ih * k;
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
