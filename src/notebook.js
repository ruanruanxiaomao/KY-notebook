/* 笔记本：笔记库 + 编辑器 */
import { store, uid, fmtTime } from './store.js';
import { InkBoard, PAGE_W, PAGE_H, COLORS, SIZES, imageToDataUrl, loadImageFile } from './inkboard.js';
import { buildNoteJson, parseNoteJson } from './notejson.js';
import { mdInto } from './md.js';
import { HwrPad } from './hwrpad.js';
import { bboxOf, groupLines, looksLikeFormula, recognizeLocal, recognizeAI, recognizeFormula, texToImage,
  inkToCanvas, recognizeStrokes, estimateSize, isPunctLike, getHwrCfg, charClusters } from './hwr.js';
import { chat, getCfg } from './ai.js';

const LS_LAST = 'kynb_last_note';
const LS_LAST_AT = 'kynb_last_note_at';   /* 最后落盘时间：用来判断「刚写过」要不要自动回到那本 */

/* initNotebook() 之后把一份 API 挂在这里，annot.js 存笔记时用，不必再经 main.js 传一圈 */
let noteApi = null;
export function noteSink() { return noteApi; }

export function initNotebook() {
  const $ = (id) => document.getElementById(id);
  const libEl = $('inkLib');
  const emptyEl = $('inkEmpty');
  const edEl = $('inkEditor');
  const titleEl = $('inkTitle');
  const pageInfo = $('inkPageInfo');
  const tplSel = $('inkTemplate');
  const starBtn = $('inkStar');
  const srcBar = $('inkSrcBar');

  const boardA = new InkBoard($('inkCv'), $('inkPaper'), $('inkStage'));
  /* P1-16 / v3.23 双栏：右栏是第二个 InkBoard，board 指向「活动栏」，
     这样工具栏（颜色/线宽/笔/撤销/缩放）不用改就自动作用在活动栏上 */
  let board = boardA;
  const paperA = $('inkPaper');
  const cvA = $('inkCv');
  const P = { on: false, act: 0, i2: 1, b2: null, stage2: null, wrap: null };
  const st = { note: null, mode: 'ink', md: '', mdEditing: false, pages: [], idx: 0, tool: 'pen', color: COLORS[0], size: SIZES[1], saveT: 0 };

  /* ---------- 工具栏 ---------- */
  const colorBox = $('inkColors');
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'sw' + (i === 0 ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.onclick = () => {
      st.color = c;
      board.color = c;
      colorBox.querySelectorAll('.sw').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    };
    colorBox.appendChild(b);
  });

  const sizeBox = $('inkSizes');
  SIZES.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'sz' + (i === 1 ? ' on' : '');
    b.innerHTML = `<i style="width:${4 + s * 2}px;height:${4 + s * 2}px"></i>`;
    b.title = s + ' px';
    b.onclick = () => {
      st.size = s;
      board.size = s;
      sizeBox.querySelectorAll('.sz').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    };
    sizeBox.appendChild(b);
  });

  document.querySelectorAll('.tool[data-tool]').forEach((b) => {
    b.onclick = () => {
      setTool(b.dataset.tool);
      document.querySelectorAll('.tool[data-tool]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    };
  });

  board.color = st.color;
  board.size = st.size;

  $('inkUndo').onclick = () => board.undo();
  $('inkRedo').onclick = () => board.redo();
  $('inkClear').onclick = () => { if (board.isEmpty() || confirm('清空这一页的笔迹？')) board.clear(); };
  tplSel.onchange = () => {
    board.setTemplate(tplSel.value);
    st.pages[st.idx].template = tplSel.value;
    saveSoon(true);
  };

  board.onChange = () => {
    /* 实时同步回内存里的页对象：导出 JSON / 存笔记 / 缩略图都读它，等 700ms 防抖太晚 */
    const cur = st.pages[curIdx()];
    if (cur) cur.strokes = board.getStrokes();
    saveSoon(false);
  };

  /* ---------- 画布缩放 / 拖拽平移 ---------- */
  const stageEl = $('inkStage');
  const zoomInfo = $('inkZoomInfo');
  const ZOOM_KEY = 'kynb_zoom';

  /* 文字笔记用的是自己的页面缩放（mdZoom），顶部这排 ± / 百分比 / ⤢ 也要跟着它走，
     否则在文字笔记里点顶部缩放就像「没反应」。mdZoom 定义在下面，用 try 兜 TDZ。 */
  function mdZoomLive() {
    try { return typeof mdZoom === 'number' ? mdZoom : null; } catch (e) { return null; }
  }
  function paintZoom() {
    if (st.mode === 'md') {
      const z = mdZoomLive();
      if (z != null) { zoomInfo.textContent = Math.round(z * 100) + '%'; return; }
    }
    zoomInfo.textContent = Math.round((board.zoom || 1) * 100) + '%';
    try { localStorage.setItem(ZOOM_KEY, String(board.zoom || 1)); } catch (e) { /* 无痕模式忽略 */ }
  }

  /* 以 (cx, cy) 为锚点缩放：缩放前后让这个点在屏幕上不动 */
  function setZoom(z, cx, cy) {
    z = Math.max(0.3, Math.min(5, z));
    /* 滚动模式：只改页宽，不碰（已经隐藏的）画布布局 */
    if (scrollOn) {
      board.zoom = z;
      applyScrollZoom();
      paintZoom();
      return;
    }
    const r = stageEl.getBoundingClientRect();
    const px = cx == null ? r.width / 2 : cx - r.left;
    const py = cy == null ? r.height / 2 : cy - r.top;
    const before = board.paper.clientWidth || 1;
    board.setZoom(z);
    const after = board.paper.clientWidth || 1;
    const k = after / before;
    stageEl.scrollLeft = (stageEl.scrollLeft + px) * k - px;
    stageEl.scrollTop = (stageEl.scrollTop + py) * k - py;
    paintZoom();
  }

  $('inkZoomIn').onclick = () => {
    if (st.mode === 'md' && mdZoomLive() != null) { bumpMdZoom(0.1); return; }
    setZoom((board.zoom || 1) + 0.15);
  };
  $('inkZoomOut').onclick = () => {
    if (st.mode === 'md' && mdZoomLive() != null) { bumpMdZoom(-0.1); return; }
    setZoom((board.zoom || 1) - 0.15);
  };
  $('inkZoomFit').onclick = () => {
    if (st.mode === 'md' && mdZoomLive() != null) { mdZoom = 1; applyMdZoom(true); mdInk.draw(); return; }
    if (scrollOn) { board.zoom = 1; applyScrollZoom(); paintZoom(); return; }
    board.setZoom(1);
    stageEl.scrollTo({ left: 0, top: 0 });
    paintZoom();
  };

  stageEl.addEventListener('wheel', (e) => {
    if (st.mode === 'md' || !st.note) return;
    e.preventDefault();
    setZoom((board.zoom || 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
  }, { passive: false });

  const ptrs = new Map();
  let panState = null;
  let pinchState = null;

  stageEl.addEventListener('pointerdown', (e) => {
    if (st.mode === 'md' || !st.note) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinchState = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: board.zoom || 1 };
      panState = null;
      stageEl.classList.remove('panning');
      return;
    }
    if (st.tool === 'pan' && ptrs.size === 1) {
      panState = { x: e.clientX, y: e.clientY, l: stageEl.scrollLeft, t: stageEl.scrollTop };
      stageEl.classList.add('panning');
      try { stageEl.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件 */ }
    }
  });

  stageEl.addEventListener('pointermove', (e) => {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (panState) {
      stageEl.scrollLeft = panState.l - (e.clientX - panState.x);
      stageEl.scrollTop = panState.t - (e.clientY - panState.y);
      return;
    }
    if (pinchState && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchState.d0 > 12) {
        setZoom(pinchState.z0 * d / pinchState.d0, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
    }
  });

  const endPointer = (e) => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinchState = null;
    if (ptrs.size === 0) {
      panState = null;
      stageEl.classList.remove('panning');
    }
  };
  stageEl.addEventListener('pointerup', endPointer);
  stageEl.addEventListener('pointercancel', endPointer);

  /* ---------- 页面元素：插入的图片 / 文字 ---------- */
  const layerBelow = $('inkItemsBelow');
  const layerAbove = $('inkItemsAbove');
  /* 选中：id → { a, b } 表示选中这个文字块里 [a,b) 这几个字；null 表示整块（图片）。
     这样「框住一个字」就只选那一个字，不会再一大块全亮。 */
  const sel = new Map();
  let editingId = null;
  let activeTextId = null;      /* 手写转文字往哪个文本框里写 */
  const itBar = $('itBar');     /* 点中元素后浮出的操作条 */
  let barItem = null;
  const candBar = $('candBar'); /* 识别候选条 */
  let candTimer = 0;
  let candFor = null;
  /* 手写转文字的状态（提前声明，避免各种初始化顺序下的 TDZ） */
  let live = null;             /* 正在写的那一行：{ strokes, item, base, size, gen, pt, ct } */
  let lastPara = null;         /* 刚写完的那一块：{ id, t, size }，接着写就往里续 */
  let lastSize = 40;           /* 上一段用过的字号：写「一」「丶」这种估不出高度时兜底 */
  let inlineEditor = null;     /* 打字工具：纸面上的就地输入框 */

  /* ---------- 排版设置（字号 / 行距 / 对齐）----------
     识别出来的字默认「一行一块、行距统一、左边界对齐」；这里的三项就是那套默认值的开关。 */
  const LAYOUT_KEY = 'kynb_layout';
  const layout = { size: 0, gap: 1.35, align: 'left' };   /* size=0 表示跟随笔迹高度 */
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    if (raw && typeof raw === 'object') {
      layout.size = Math.max(0, Math.min(160, Number(raw.size) || 0));
      layout.gap = Math.max(1.1, Math.min(3, Number(raw.gap) || 1.35));
      if (raw.align === 'center' || raw.align === 'right') layout.align = raw.align;
    }
  } catch (e) { /* 无痕模式 */ }

  function getLayout() { return { size: layout.size, gap: layout.gap, align: layout.align }; }

  function setLayout(next) {
    if (!next) return getLayout();
    if (next.size != null) layout.size = Math.max(0, Math.min(160, Number(next.size) || 0));
    if (next.gap != null) layout.gap = Math.max(1.1, Math.min(3, Number(next.gap) || 1.35));
    if (next.align) layout.align = (next.align === 'center' || next.align === 'right') ? next.align : 'left';
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) { /* 忽略 */ }
    return getLayout();
  }

  const pageNow = () => st.pages[curIdx()];

  /* ---------- 字体：笔记里的文字跟着「系统字体」走，可以在设置里换 ---------- */
  /* 注意：DOM 的 .tx 和 canvas 导出用的是同一条字体栈（styles.css 里的 --text-font），
     两边不一致的话，屏幕上和导出的 PNG 会长得不一样。 */
  let _fontStack = '';
  let _measureCtx = null;
  function textFont() {
    if (_fontStack) return _fontStack;
    let v = '';
    try {
      v = getComputedStyle(document.documentElement).getPropertyValue('--text-font').trim();
    } catch (e) { v = ''; }
    _fontStack = v || 'system-ui, sans-serif';
    return _fontStack;
  }
  /** 换字体后要清缓存，不然量出来的宽度还是旧字体的 */
  function refreshFont() {
    _fontStack = '';
    board.textFont = textFont();
    /* 换了字体（比如手机主题字体加载完），字宽会变；只把不够宽的那些撑开，不动用户手动调过的 */
    const p = pageNow();
    if (p && Array.isArray(p.items)) {
      for (const it of p.items) {
        if (it.type !== 'text') continue;
        const need = Math.ceil(measureW(it.text, it.size || 32)) + Math.ceil((it.size || 32) * 0.35);
        if (need > (it.w || 0)) fitItemWidth(it);
      }
    }
    renderItems();
    refreshBar();
  }
  board.textFont = textFont();

  /** 用当前字体量文字宽度（字号 size）：折行宽度按它算，不然会莫名换行、看起来像「只认了一半」 */
  function measureW(text, size) {
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = `${size}px ${textFont()}`;
    let w = 0;
    for (const ln of String(text == null ? '' : text).split('\n')) {
      w = Math.max(w, _measureCtx.measureText(ln || ' ').width);
    }
    return w;
  }

  /** 按内容把文字块宽度调好：宁宽勿窄（窄了会折行，看起来像后半截没认出来） */
  function fitItemWidth(it) {
    const size = it.size || 32;
    const need = Math.ceil(measureW(it.text, size)) + Math.ceil(size * 0.35);
    const maxW = Math.max(80, Math.round(board.pageW - it.x - 8));
    it.w = Math.max(48, Math.min(maxW, need));
    return it.w;
  }

  function itemSize(it) { return Math.max(8, Math.round(Number(it && it.size) || 32)); }

  /** 行距倍率：老数据没有 lh，按 1.3（和 .tx 原来的行高一致） */
  function itemLh(it) {
    const v = Number(it && it.lh);
    return Math.max(1.05, Math.min(3, isFinite(v) && v > 0 ? v : 1.3));
  }

  /** 文字按当前字号 / 折行宽度排出来有几行、最宽多宽、总共多高（页面坐标） */
  function textMetricsOf(it) {
    const size = itemSize(it);
    const maxW = Math.max(20, Number(it.w) || 300);
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = `${size}px ${textFont()}`;
    let rows = 0, widest = 0;
    for (const par of String(it.text || '').split('\n')) {
      if (!par) { rows += 1; continue; }
      let cur = '', w = 0;
      for (const ch of par) {
        const cw = _measureCtx.measureText(ch).width;
        if (cur && w + cw > maxW) { widest = Math.max(widest, w); rows += 1; cur = ch; w = cw; }
        else { cur += ch; w += cw; }
      }
      widest = Math.max(widest, w);
      rows += 1;
    }
    const n = Math.max(1, rows);
    return { rows: n, w: Math.max(8, widest), h: n * size * itemLh(it) };
  }

  /** 元素在页面坐标系里的实际框（文字按真实排版量算，图片用 w/h）——对齐、等距都按它算 */
  function visualBox(it) {
    if (it.type === 'image') return { x: it.x, y: it.y, w: it.w || 100, h: it.h || it.w || 100 };
    const m = textMetricsOf(it);
    return { x: it.x, y: it.y, w: m.w, h: m.h };
  }

  function setTool(t) {
    st.tool = t;
    board.tool = t;
    document.querySelectorAll('#inkTools [data-tool]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tool === t);
    });
    $('inkStage').classList.toggle('grab', t === 'pan');
    $('inkStage').classList.toggle('selecting', t === 'sel');
    $('inkStage').classList.toggle('lassoing', t === 'lasso');
    $('inkStage').classList.toggle('texting', t === 'text');
    if (t !== 'text') { try { finishInlineText(true); } catch (e) { /* 还没定义 */ } }
    try { hideCandBar(); } catch (e) { /* 还没定义 */ }
    if (t !== 'lasso') { try { clearLasso(); } catch (e) { /* 初始化早期还没定义 */ } }
    if (t !== 'sel') { sel.clear(); try { closeBar(); } catch (e) { /* 同上 */ } renderItems(); }
  }

  /* 元素层是 1414×1000 的页面坐标系，整体缩放跟纸面对齐，缩放/转屏都不用重算每个元素 */
  function syncItemsScale() {
    const k = (board.paper.clientWidth || PAGE_W) / PAGE_W;
    layerBelow.style.transform = `scale(${k})`;
    layerAbove.style.transform = `scale(${k})`;
    const sl = $('inkSelLayer');
    if (sl) sl.style.transform = `scale(${k})`;
  }
  if (window.ResizeObserver) new ResizeObserver(syncItemsScale).observe(board.paper);

  function placeItem(el, it) {
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.width = it.w + 'px';
    if (it.type === 'image') el.style.height = it.h + 'px';
  }

  function renderItems() {
    layerBelow.innerHTML = '';
    layerAbove.innerHTML = '';
    const p = pageNow();
    if (!p) return;
    if (!Array.isArray(p.items)) p.items = [];
    board.items = p.items;
    p.items.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'it it-' + it.type
        + (sel.get(it.id) === null ? ' on' : '') + (it.id === activeTextId ? ' cur' : '');
      el.dataset.id = it.id;
      placeItem(el, it);
      if (it.type === 'image') {
        const img = document.createElement('img');
        img.src = it.src;
        img.alt = '';
        img.draggable = false;
        el.appendChild(img);
      } else {
        const tx = document.createElement('div');
        tx.className = 'tx';
        tx.style.fontSize = (it.size || 32) + 'px';
        tx.style.lineHeight = String(itemLh(it));   /* 行距跟着这块走，屏幕和导出用同一个值 */
        tx.style.color = it.color || '#1f1c18';
        tx.textContent = it.text || '';
        el.appendChild(tx);
      }
      const del = document.createElement('button');
      del.className = 'it-del';
      del.title = '删除这个元素';
      del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); removeItem(it.id); };
      el.appendChild(del);
      if (it.type === 'image') {
        const rs = document.createElement('div');
        rs.className = 'it-rs';
        rs.title = '拖动改大小';
        rs.addEventListener('pointerdown', (e) => startResize(e, it, el));
        el.appendChild(rs);
      } else {
        const rs = document.createElement('div');
        rs.className = 'it-rs';
        rs.title = '拖动缩放：上下拖改字号，左右拖改宽度';
        rs.addEventListener('pointerdown', (e) => startTextResize(e, it, el));
        el.appendChild(rs);
      }
      el.addEventListener('pointerdown', (e) => startDrag(e, it, el));
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (it.type === 'text') openTextDialog(it);
      });
      (it.z === 'above' ? layerAbove : layerBelow).appendChild(el);
    });
    syncItemsScale();
    try { paintSel(); } catch (e) { /* 初始化早期还没定义 */ }
    if (barItem) {
      if (!p.items.some((x) => x.id === barItem.id)) closeBar();
      else refreshBar();
    }
  }

  /* ---------- 选中元素后浮出的操作条（改字号 / 改字 / 删除） ---------- */
  function itemEl(id) {
    return layerAbove.querySelector(`[data-id="${id}"]`) || layerBelow.querySelector(`[data-id="${id}"]`);
  }

  /** 选中集合的包围盒（视口坐标）；多选时操作条挂在整块外面 */
  function selRect() {
    let r = null;
    const add = (l, t, rr, bb) => {
      r = r ? {
        left: Math.min(r.left, l), top: Math.min(r.top, t),
        right: Math.max(r.right, rr), bottom: Math.max(r.bottom, bb),
      } : { left: l, top: t, right: rr, bottom: bb };
    };
    const cr = board.cv.getBoundingClientRect();
    const k = cr.width / board.pageW || 1;
    for (const [id, range] of sel) {
      const it = (pageNow() || { items: [] }).items.find((x) => x.id === id);
      if (!it) continue;
      if (!range) {
        const el = itemEl(id);
        if (!el) continue;
        const b = el.getBoundingClientRect();
        add(b.left, b.top, b.right, b.bottom);
        continue;
      }
      const boxes = charBoxes(it).filter((b) => b.i >= range.a && b.i < range.b);
      if (!boxes.length) continue;
      const x0 = Math.min(...boxes.map((b) => b.x));
      const x1 = Math.max(...boxes.map((b) => b.x + b.w));
      const y0 = Math.min(...boxes.map((b) => b.y));
      const y1 = Math.max(...boxes.map((b) => b.y + b.h));
      add(cr.left + x0 * k, cr.top + y0 * k, cr.left + x1 * k, cr.top + y1 * k);
    }
    return r;
  }

  function refreshBar() {
    if (!barItem || !sel.size) return;
    const r = selRect();
    if (!r) { closeBar(); return; }
    const sr = stageEl.getBoundingClientRect();
    const bw = itBar.offsetWidth || 210;
    const bh = itBar.offsetHeight || 40;
    /* 优先放在选中块上方，放不下就放下面；左右夹在可视区里 */
    let top = r.top - bh - 8;
    if (top < sr.top + 6) top = Math.min(sr.bottom - bh - 6, r.bottom + 8);
    let left = (r.left + r.right) / 2 - bw / 2;
    left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
    itBar.style.left = Math.round(left) + 'px';
    itBar.style.top = Math.round(top) + 'px';

    const list = selItems();
    const texts = list.filter((x) => x.type === 'text');
    const chars = selCharCount();
    let blocks = 0;
    for (const r of sel.values()) if (!r) blocks += 1;
    const del = itBar.querySelector('[data-act="del"]');
    const edit = itBar.querySelector('[data-act="edit"]');
    const whole = itBar.querySelector('[data-act="whole"]');
    const info = itBar.querySelector('.itbar-info');
    if (del) del.textContent = chars && blocks ? `删除 ${chars} 字 + ${blocks} 块`
      : (chars ? `删除 ${chars} 字` : (blocks > 1 ? `删除 ${blocks} 块` : '删除'));
    if (edit) edit.hidden = !(list.length === 1 && list[0].type === 'text');
    /* 只选了几个字时，给一个「整块」按钮，方便整段删 / 整段拖 */
    const oneRange = list.length === 1 && list[0].type === 'text' && sel.get(list[0].id);
    if (whole) whole.hidden = !oneRange;
    if (info) {
      if (chars || blocks) {
        info.textContent = chars && blocks ? `${chars} 字 + ${blocks} 块`
          : (chars ? `已选 ${chars} 个字` : `已选 ${blocks} 块`);
      } else {
        info.textContent = list[0] && list[0].type === 'image'
          ? (list[0].tex ? '公式' : '图片')
          : `${(list[0] && list[0].size) || 32}px`;
      }
    }
    /* 只有文字能改字号；纯图片选中时把 A− / A+ 收起来 */
    itBar.classList.toggle('pic', texts.length === 0);
    if (fmtOpen) placeFmt();
  }

  function openBar(it) {
    if (it && !sel.has(it.id)) selectOnly(it.id);
    barItem = it || selItems()[0] || null;
    if (!barItem) { closeBar(); return; }
    itBar.hidden = false;
    refreshBar();
  }

  function closeBar() {
    barItem = null;
    itBar.hidden = true;
    try { closeFmt(); } catch (e) { /* 初始化早期还没定义 */ }
  }

  /** 改字号：选中的文字块一起改（批量） */
  function bumpSize(f) {
    const texts = selItems().filter((x) => x.type === 'text');
    if (!texts.length) return;
    for (const it of texts) {
      it.size = Math.max(10, Math.min(160, Math.round((it.size || 32) * f)));
      fitItemWidth(it);
    }
    renderItems();
    saveSoon(true);
    refreshBar();
  }

  /* ---------- 排版：对齐 / 等距 / 统一字号 / 行距 / 整理本页 ---------- */
  const fmtBar = $('fmtBar');
  let fmtOpen = false;

  function placeFmt() {
    /* 面板固定在屏幕下方中间（样式里定的），这里只清掉可能残留的 inline 定位，免得和 transform 打架 */
    if (!fmtBar) return;
    fmtBar.style.removeProperty('left');
    fmtBar.style.removeProperty('top');
  }

  function openFmt() {
    if (!fmtBar || !sel.size) return;
    fmtBar.hidden = false;
    fmtOpen = true;
    placeFmt();
  }

  function closeFmt() {
    fmtOpen = false;
    if (fmtBar) fmtBar.hidden = true;
  }

  const ALIGN_NAME = {
    left: '左对齐', right: '右对齐', hcenter: '水平居中',
    top: '顶端对齐', bottom: '底端对齐', vcenter: '垂直居中',
  };

  /** 对齐：按选中内容的真实包围盒（文字按排版量算，不是框宽） */
  function alignSel(op) {
    const list = selItems();
    if (!list.length) return;
    const bs = list.map((it) => ({ it, b: visualBox(it) }));
    const L = Math.min(...bs.map((x) => x.b.x));
    const R = Math.max(...bs.map((x) => x.b.x + x.b.w));
    const T = Math.min(...bs.map((x) => x.b.y));
    const B = Math.max(...bs.map((x) => x.b.y + x.b.h));
    for (const { it, b } of bs) {
      if (op === 'left') it.x = Math.round(L);
      else if (op === 'right') it.x = Math.round(R - b.w);
      else if (op === 'hcenter') it.x = Math.round((L + R) / 2 - b.w / 2);
      else if (op === 'top') it.y = Math.round(T);
      else if (op === 'bottom') it.y = Math.round(B - b.h);
      else if (op === 'vcenter') it.y = Math.round((T + B) / 2 - b.h / 2);
      it.x = Math.max(2, it.x);
      it.y = Math.max(2, it.y);
    }
    renderItems();
    saveSoon(true);
    refreshBar();
    toast('已' + (ALIGN_NAME[op] || '对齐'));
  }

  /** 等距分布：至少 3 块，按中心排序后让间隙相等 */
  function distributeSel(axis) {
    const list = selItems();
    if (list.length < 3) { toast('至少选 3 块才能等距分布', true); return; }
    const bs = list.map((it) => ({ it, b: visualBox(it) }));
    if (axis === 'h') {
      bs.sort((a, b) => a.b.x - b.b.x);
      const first = bs[0].b.x;
      const last = bs[bs.length - 1];
      const total = bs.reduce((s, x) => s + x.b.w, 0);
      const gap = ((last.b.x + last.b.w) - first - total) / (bs.length - 1);
      let cur = first;
      for (const x of bs) { x.it.x = Math.round(cur); cur += x.b.w + gap; }
    } else {
      bs.sort((a, b) => a.b.y - b.b.y);
      const first = bs[0].b.y;
      const last = bs[bs.length - 1];
      const total = bs.reduce((s, x) => s + x.b.h, 0);
      const gap = ((last.b.y + last.b.h) - first - total) / (bs.length - 1);
      let cur = first;
      for (const x of bs) { x.it.y = Math.round(cur); cur += x.b.h + gap; }
    }
    renderItems();
    saveSoon(true);
    refreshBar();
    toast(axis === 'h' ? '已水平等距' : '已垂直等距');
  }

  /** 统一字号 + 行距：以第一块为准 */
  function sameSizeSel() {
    const texts = selItems().filter((x) => x.type === 'text');
    if (!texts.length) { toast('选中的里面没有文字', true); return; }
    const size = itemSize(texts[0]);
    const lh = itemLh(texts[0]);
    for (const it of texts) { it.size = size; it.lh = lh; fitItemWidth(it); }
    renderItems();
    saveSoon(true);
    refreshBar();
    toast(`已统一成 ${size}px`);
  }

  function bumpGapSel(d) {
    const texts = selItems().filter((x) => x.type === 'text');
    if (!texts.length) return;
    for (const it of texts) {
      it.lh = Math.max(1.05, Math.min(3, Math.round((itemLh(it) + d) * 20) / 20));
    }
    renderItems();
    saveSoon(true);
    refreshBar();
    toast('行距 ' + itemLh(texts[0]).toFixed(2));
  }

  /**
   * 整理本页：把这一页的文字按「行」归拢 —— 行内左边界对齐、行距统一、超出页宽自动折到下一行。
   * 手写时东一句西一句也能一键排成整齐的段落；一条 ↶ 可撤回。
   */
  function tidyPage() {
    const p = pageNow();
    if (!p || !Array.isArray(p.items)) return 0;
    const texts = p.items.filter((x) => x.type === 'text' && String(x.text || '').trim());
    if (!texts.length) { toast('这一页没有文字', true); return 0; }
    board.pushUndo();
    const margin = 96;
    const maxW = Math.max(240, Math.round(board.pageW - margin * 2));
    /* 1) 按视觉中心 y 归行 */
    const rows = [];
    for (const it of texts.slice().sort((a, b) => visualBox(a).y - visualBox(b).y)) {
      const b = visualBox(it);
      const cy = b.y + b.h / 2;
      let row = null;
      for (const r of rows) {
        if (Math.abs(cy - r.cy) < Math.min(b.h, r.h) * 0.55) { row = r; break; }
      }
      if (!row) { row = { cy, h: b.h, list: [] }; rows.push(row); }
      row.list.push(it);
      row.cy = (row.cy * (row.list.length - 1) + cy) / row.list.length;
      row.h = Math.max(row.h, b.h);
    }
    rows.sort((a, b) => a.cy - b.cy);
    /* 2) 逐行排：左边界对齐、行距统一、放不下就折到下一行 */
    let y = Math.max(40, Math.round(rows[0].cy - rows[0].h / 2));
    for (const r of rows) {
      r.list.sort((a, b) => a.x - b.x);
      let x = margin;
      let rowH = 0;
      for (const it of r.list) {
        const size = itemSize(it);
        it.lh = layout.gap;
        fitItemWidth(it);
        if (it.w > maxW) it.w = maxW;
        const vw = visualBox(it).w;
        if (x > margin && x + vw > margin + maxW) {   /* 这一行放不下 → 换行 */
          y += rowH + Math.round(size * 0.35);
          x = margin;
          rowH = 0;
        }
        it.x = Math.round(x);
        it.y = Math.round(y);
        x += vw + Math.round(size * 0.35);
        rowH = Math.max(rowH, visualBox(it).h);
      }
      y += Math.max(rowH, r.h);
    }
    renderItems();
    saveSoon(true);
    toast('已把这一页的文字按行排整齐');
    return texts.length;
  }

  /** 把设置里的字号 / 行距用到本页所有文字（老笔记也能一次改齐） */
  function applyLayoutToPage() {
    const p = pageNow();
    if (!p || !Array.isArray(p.items)) return 0;
    let n = 0;
    for (const it of p.items) {
      if (it.type !== 'text') continue;
      if (layout.size) it.size = layout.size;
      it.lh = layout.gap;
      fitItemWidth(it);
      n += 1;
    }
    renderItems();
    saveSoon(true);
    return n;
  }

  if (fmtBar) {
    fmtBar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.align) { alignSel(b.dataset.align); return; }
      if (b.dataset.dist) { distributeSel(b.dataset.dist); return; }
      const f = b.dataset.fmt;
      if (f === 'close') { closeFmt(); return; }
      if (f === 'same') { sameSizeSel(); return; }
      if (f === 'gapup') { bumpGapSel(0.1); return; }
      if (f === 'gapdown') { bumpGapSel(-0.1); return; }
      if (f === 'tidy') { tidyPage(); return; }
    });
    window.addEventListener('resize', () => placeFmt());
  }

  if (itBar) {
    itBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'del') { removeSelected(); return; }
      if (act === 'fmt') { if (fmtOpen) closeFmt(); else openFmt(); return; }
      if (act === 'whole') {
        const list = selItems();
        if (list.length === 1 && list[0].type === 'text') {
          sel.set(list[0].id, null);
          paintSel();
          refreshBar();
        }
        return;
      }
      if (act === 'edit') {
        const list = selItems();
        if (list.length === 1 && list[0].type === 'text') openTextDialog(list[0]);
        return;
      }
      bumpSize(act === 'plus' ? 1.12 : 1 / 1.12);
    });
    window.addEventListener('resize', () => refreshBar());
  }
  stageEl.addEventListener('scroll', () => refreshBar(), { passive: true });

  /** 手指点在元素上：命中哪个 */
  function hitItemAt(cx, cy) {
    const p = pageNow();
    if (!p || !Array.isArray(p.items)) return null;
    const order = p.items.slice().sort((a, b) => (b.z === 'above' ? 1 : 0) - (a.z === 'above' ? 1 : 0));
    for (const it of order) {
      const el = itemEl(it.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (cx >= r.left - 6 && cx <= r.right + 6 && cy >= r.top - 6 && cy <= r.bottom + 6) return it;
    }
    return null;
  }

  /* 手指「点一下」识别出来的文字 = 选中它（弹出改字号 / 删除）；笔照常写字，手指画一笔也不会被吞。
     判断方式：手指按下的位置撞上了文字块 → 先放行让画板照常落笔；抬起来时如果几乎没动
     （<8px，视为「点」而不是「写」），才把它当选择，并把刚才点出来的那个墨点撤掉。 */
  let tapSel = null;
  stageEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') { try { closeBar(); } catch (err) { /* 还没初始化 */ } return; }
    if (st.mode === 'md' || !st.note) return;
    if (st.tool === 'pan' || st.tool === 'lasso' || st.tool === 'sel') return;
    const it = hitItemAt(e.clientX, e.clientY);
    if (!it) { try { closeBar(); } catch (err) { /* 同上 */ } return; }
    tapSel = {
      id: it.id, x: e.clientX, y: e.clientY, pid: e.pointerId,
      n0: board.strokes.length, u0: board.undoStack.length,
    };
  }, true);

  const endTapSel = (e) => {
    const t = tapSel;
    if (!t || e.pointerId !== t.pid) return;
    tapSel = null;
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) {        /* 是在写字，不是在点 */
      try { closeBar(); } catch (err) { /* 同上 */ }
      return;
    }
    /* 等画板把这一下手势收尾（onStrokeEnd 也跑完了）再清理 */
    setTimeout(() => {
      const p = pageNow();
      const it = p && Array.isArray(p.items) ? p.items.find((x) => x.id === t.id) : null;
      if (!it) return;
      /* 点出来的那个墨点：删掉，连它开的那条撤销记录一起退 */
      if (board.strokes.length > t.n0) {
        const extra = board.strokes.slice(t.n0);
        board.removeStrokes(extra);
        if (live && live.strokes.length && live.strokes.every((s) => extra.indexOf(s) >= 0)) {
          clearTimeout(live.pt);
          clearTimeout(live.ct);
          live = null;
        }
        while (board.undoStack.length > t.u0 + 1) board.undoStack.pop();
        if (board.undoStack.length === t.u0 + 1) board.undoStack.pop();
      }
      tapSelect(it, t.x, t.y);
    }, 0);
  };
  stageEl.addEventListener('pointerup', endTapSel, true);
  stageEl.addEventListener('pointercancel', (e) => {
    if (tapSel && e.pointerId === tapSel.pid) tapSel = null;
  }, true);

  /**
   * 把文字块拆成「每个字的框」（页面坐标）。用于按字命中、按字选中、高亮和删除。
   * 按 .tx 的排版规则近似：字号 size、行高 1.3、宽度不够就换行（中文按字换，英文按字近似）。
   */
  function charBoxes(it) {
    const size = it.size || 32;
    const lh = size * 1.3;
    const maxW = Math.max(24, it.w || 300);
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = `${size}px ${textFont()}`;
    const out = [];
    let x = 0, row = 0, idx = 0;
    for (const ch of Array.from(String(it.text || ''))) {
      if (ch === '\n') { x = 0; row += lh; idx += 1; continue; }
      const w = _measureCtx.measureText(ch).width;
      if (x > 0 && x + w > maxW) { x = 0; row += lh; }
      out.push({ i: idx, ch, x: it.x + x, y: it.y + row, w: Math.max(2, w), h: lh });
      x += w;
      idx += 1;
    }
    return out;
  }

  /** 点在文字块的哪个字上（返回字符下标；点在空白处就取最近的字） */
  function charIndexAt(it, px, py) {
    const boxes = charBoxes(it);
    if (!boxes.length) return 0;
    let best = 0, bestD = Infinity;
    for (const b of boxes) {
      if (px >= b.x - 2 && px <= b.x + b.w + 2 && py >= b.y && py <= b.y + b.h) return b.i;
      const dx = px < b.x ? b.x - px : (px > b.x + b.w ? px - b.x - b.w : 0);
      const dy = py < b.y ? b.y - py : (py > b.y + b.h ? py - b.y - b.h : 0);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = b.i; }
    }
    return best;
  }

  /** 视口坐标 → 页面坐标 */
  function pageAt(cx, cy) {
    const r = board.cv.getBoundingClientRect();
    const k = r.width / board.pageW || 1;
    return [(cx - r.left) / k, (cy - r.top) / k];
  }

  function selCount() { return sel.size; }
  function selCharCount() {
    let n = 0;
    for (const r of sel.values()) if (r) n += Math.max(0, r.b - r.a);
    return n;
  }

  function paintSel() {
    /* 整块选中的（图片）才画那个大框；文字只画「字」的高亮 */
    document.querySelectorAll('.ink-items .it').forEach((x) => {
      x.classList.toggle('on', sel.get(x.dataset.id) === null);
    });
    const layer = $('inkSelLayer');
    if (layer) {
      layer.innerHTML = '';
      const p = pageNow();
      if (p && Array.isArray(p.items)) {
        for (const [id, r] of sel) {
          if (!r) continue;
          const it = p.items.find((x) => x.id === id);
          if (!it) continue;
          let run = null;
          const flush = () => {
            if (!run) return;
            const d = document.createElement('div');
            d.className = 'ch';
            d.style.left = run.x + 'px';
            d.style.top = run.y + 'px';
            d.style.width = run.w + 'px';
            d.style.height = run.h + 'px';
            layer.appendChild(d);
            run = null;
          };
          for (const b of charBoxes(it)) {
            if (b.i < r.a || b.i >= r.b) continue;
            if (run && Math.abs(b.y - run.y) < 0.5 && b.x <= run.x + run.w + 1.5) {
              run.w = b.x + b.w - run.x;
            } else { flush(); run = { x: b.x, y: b.y, w: b.w, h: b.h }; }
          }
          flush();
        }
      }
    }
    const multi = sel.size > 1;
    layerAbove.classList.toggle('multi', multi);
    layerBelow.classList.toggle('multi', multi);
  }

  /** 只选这一块（清掉其它） */
  function selectOnly(id) {
    sel.clear();
    if (id) sel.set(id, null);
    paintSel();
  }

  function selItems() {
    const p = pageNow();
    if (!p || !Array.isArray(p.items)) return [];
    return p.items.filter((x) => sel.has(x.id));
  }

  /** 点一下某个元素：文字按「字」选，图片整块选；返回现在是否处于选中态 */
  function tapSelect(it, cx, cy) {
    /* 已经选着别的块时，点新的一块是「加进来」而不是把之前的清掉——这样点几下就能攒出多选 */
    const add = sel.size > 0 && !sel.has(it.id);
    if (it.type === 'text') {
      const [px, py] = pageAt(cx, cy);
      const idx = charIndexAt(it, px, py);
      const on = toggleChar(it, idx, add);
      if (on) openBar(it); else closeBar();
      return on;
    }
    if (sel.get(it.id) === null) { sel.delete(it.id); paintSel(); closeBar(); return false; }
    if (!add) sel.clear();
    sel.set(it.id, null);
    paintSel();
    openBar(it);
    return true;
  }

  /**
   * 点一个文字块里的某个字：
   *  · 点在已选中的字上 → 取消这块的选中
   *  · 点在选中范围的左右隔壁 → 把范围扩一个字（连着点就能选一段）
   *  · 其它情况 → 重新只选这一个字
   */
  function toggleChar(it, idx, add) {
    const cur = sel.get(it.id);
    if (cur && idx >= cur.a && idx < cur.b) { sel.delete(it.id); paintSel(); return false; }
    if (cur && (idx === cur.b || idx === cur.a - 1)) {
      sel.set(it.id, { a: Math.min(cur.a, idx), b: Math.max(cur.b, idx + 1) });
      paintSel();
      return true;
    }
    if (add && !cur) {
      /* 点到另一块上：追加进来，不清掉前面选的 */
      sel.set(it.id, { a: idx, b: idx + 1 });
      paintSel();
      return true;
    }
    sel.clear();
    sel.set(it.id, { a: idx, b: idx + 1 });
    paintSel();
    return true;
  }

  function startDrag(e, it, el) {
    if (st.tool !== 'sel') return;      /* 写字时不该拖到元素 */
    /* 点中文本框 = 把手写文字的落点切到这里（像点一下输入框） */
    if (it.type === 'text' && activeTextId !== it.id) {
      activeTextId = it.id;
      document.querySelectorAll('.ink-items .it').forEach((x) => {
        x.classList.toggle('cur', x.dataset.id === activeTextId);
      });
    }
    e.preventDefault();
    e.stopPropagation();
    const k = (board.paper.clientWidth || PAGE_W) / PAGE_W;
    const s0 = { x: e.clientX, y: e.clientY, ox: it.x, oy: it.y };
    let moved = false;
    const move = (ev) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - s0.x, ev.clientY - s0.y) < 4) return;   /* 还没动：先别改选中 */
        moved = true;
        /* 拖动：没选中过就整块选它；已经按字选中的保持原样（拖的还是这一块） */
        if (!sel.has(it.id)) { sel.clear(); sel.set(it.id, null); paintSel(); }
        openBar(it);
      }
      it.x = Math.round(s0.ox + (ev.clientX - s0.x) / k);
      it.y = Math.round(s0.oy + (ev.clientY - s0.y) / k);
      el.style.left = it.x + 'px';
      el.style.top = it.y + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      /* 没拖动 = 点了一下：文字按字选，图片整块选 */
      if (!moved) tapSelect(it, e.clientX, e.clientY);
      saveSoon(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startResize(e, it, el) {
    e.preventDefault();
    e.stopPropagation();
    selectOnly(it.id);
    openBar(it);
    const k = (board.paper.clientWidth || PAGE_W) / PAGE_W;
    const s0 = { x: e.clientX, y: e.clientY, w: it.w, h: it.h };
    const move = (ev) => {
      it.w = Math.max(40, Math.round(s0.w + (ev.clientX - s0.x) / k));
      it.h = Math.max(40, Math.round(s0.h + (ev.clientY - s0.y) / k));
      el.style.width = it.w + 'px';
      el.style.height = it.h + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveSoon(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** 文本框缩放：上下拖改字号（字会跟着变大变小），左右拖只改折行宽度 */
  function startTextResize(e, it, el) {
    e.preventDefault();
    e.stopPropagation();
    selectOnly(it.id);
    openBar(it);
    activeTextId = it.id;
    const k = (board.paper.clientWidth || PAGE_W) / PAGE_W;
    const s0 = { x: e.clientX, y: e.clientY, w: it.w || 200, size: it.size || 32 };
    const tx = el.querySelector('.tx');
    const maxW = () => Math.max(80, Math.round(board.pageW - it.x - 12));
    const move = (ev) => {
      const dx = (ev.clientX - s0.x) / k;
      const dy = (ev.clientY - s0.y) / k;
      if (Math.abs(dx) > Math.abs(dy) * 1.4) {
        it.w = Math.max(60, Math.min(maxW(), Math.round(s0.w + dx)));   /* 只改折行宽度 */
      } else {
        const f = Math.max(0.25, Math.min(4, (s0.size + dy * 0.45) / s0.size));
        it.size = Math.max(10, Math.min(160, Math.round(s0.size * f)));
        it.w = Math.max(60, Math.min(maxW(), Math.round(s0.w * f)));
      }
      el.style.width = it.w + 'px';
      if (tx) tx.style.fontSize = it.size + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveSoon(true);
      toast(`字号 ${it.size}px · 宽度 ${it.w}px`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function removeItem(id) {
    const p = pageNow();
    if (!p || !Array.isArray(p.items)) return;
    p.items = p.items.filter((x) => x.id !== id);
    if (lastPara && lastPara.id === id) lastPara = null;   /* 别往删掉的块里续写 */
    if (activeTextId === id) activeTextId = null;
    sel.delete(id);
    renderItems();
    saveSoon(true);
    toast('已删除元素');
  }

  /** 删掉选中的内容：文字只删选中的那几个字，图片整块删 */
  function removeSelected() {
    const p = pageNow();
    if (!p || !Array.isArray(p.items) || !sel.size) return 0;
    let n = 0;
    for (const [id, r] of [...sel]) {
      const it = p.items.find((x) => x.id === id);
      if (!it) continue;
      if (!r) {
        p.items = p.items.filter((x) => x.id !== id);
        if (lastPara && lastPara.id === id) lastPara = null;
        if (activeTextId === id) activeTextId = null;
        n += 1;
        continue;
      }
      const t = String(it.text || '');
      it.text = t.slice(0, r.a) + t.slice(r.b);
      if (!it.text.trim()) {
        p.items = p.items.filter((x) => x.id !== id);
        if (lastPara && lastPara.id === id) lastPara = null;
        if (activeTextId === id) activeTextId = null;
      } else {
        fitItemWidth(it);
      }
      n += 1;
    }
    sel.clear();
    closeBar();
    renderItems();
    saveSoon(true);
    toast(`已删除 ${n} 处内容`);
    return n;
  }

  /* ---------- 手写转文字 ---------- */
  /** 找到「当前文本框」；没有就新建一个（放在已有文字块下面，没有就靠页面上方） */
  function targetTextItem(create) {
    const p = pageNow();
    if (!p) return null;
    if (!Array.isArray(p.items)) p.items = [];
    const it = activeTextId ? p.items.find((x) => x.id === activeTextId && x.type === 'text') : null;
    if (it) return it;
    if (!create) return null;
    const texts = p.items.filter((x) => x.type === 'text');
    let y = Math.round(PAGE_H * 0.09);
    if (texts.length) {
      const bottom = Math.max(...texts.map((t) => t.y + Math.max(80,
        String(t.text || '').split('\n').length * (t.size || 40) * 1.6)));
      y = Math.min(Math.round(PAGE_H * 0.72), Math.round(bottom + 24));
    }
    const box = {
      id: uid('it'), type: 'text', z: 'above', text: '', size: 40, color: '#1f1c18',
      x: 96, y, w: Math.round(PAGE_W * 0.78), h: 120,
    };
    p.items.push(box);
    activeTextId = box.id;
    return box;
  }

  /** 新写的字跑到可视区外面去了就滚一下，不然用户会以为没写进去 */
  function scrollItemIntoView(id) {
    const el = layerAbove.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    const er = el.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    if (er.top >= sr.top + 6 && er.bottom <= sr.bottom - 6) return;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function commitHwr(text) {
    const it = targetTextItem(true);
    if (!it) return;
    it.text = (it.text || '') + text;
    renderItems();
    saveSoon(true);
    scrollItemIntoView(it.id);
  }

  /** 退掉最近上屏的文字（n 个字）；手写板的 ⌫ 和「AI 再看」都用它 */
  function backHwr(n) {
    const it = targetTextItem(false);
    if (!it) return;
    const t = String(it.text || '');
    it.text = n > 0 ? t.slice(0, Math.max(0, t.length - n)) : t.slice(0, -1);
    renderItems();
    saveSoon(true);
  }

  const hwr = new HwrPad(
    {
      bar: $('hwrBar'), cv: $('hwrCv'), cands: $('hwrCands'), status: $('hwrStatus'),
      auto: $('hwrAuto'), engine: $('hwrEngine'),
    },
    { onCommit: (text) => commitHwr(text), onBack: (n) => backHwr(n) },
  );

  /* 底部手写板：入口在「设置」里（主工具栏已经被画布识别占了） */
  function openHandPad(on) {
    if (!st.note || st.mode === 'md') { toast('先打开一本手写笔记', true); return; }
    hwr.show(on !== false);
  }
  $('hwrClose').onclick = () => hwr.show(false);
  $('hwrBack').onclick = () => backHwr(1);
  $('hwrEnter').onclick = () => commitHwr('\n');
  $('hwrClear').onclick = () => hwr.clear();

  /* ================= 画布上写完就地转文字 / 公式 ================= */
  /* 两种入口：
     ① 自动：开着 ✍ / ∑ 时，在纸上写完停笔一会儿，这一行笔迹就地换成文字（或公式）
     ② 手动：⬚ 圈住一片笔迹 → 浮出「转文字 / 转公式」，点哪个转哪个
     转换都是「删笔迹 + 原位加内容」，并且整件事只占一步撤销，↶ 能退回原笔迹。 */
  const HWR_MODE_KEY = 'kynb_hwrmode';
  let hwrMode = 'off';                 // 'off' | 'text' | 'formula'
  let pendingTex = new Set();          // 公式模式攒的笔画
  let texTimer = 0;
  let busyConv = false;
  let hinted = false;                  // 「手指点一下能删」的提示只弹一次
  let resumeHinted = false;            // 「这几笔没认出来」的提示只弹一次
  let tapHinted = false;               // 「轻点分段」的提示只弹一次

  try { hwrMode = localStorage.getItem(HWR_MODE_KEY) || 'off'; } catch (e) { hwrMode = 'off'; }
  if (hwrMode !== 'text' && hwrMode !== 'formula') hwrMode = 'off';

  function paintHwrBtns() {
    $('inkHwrText').classList.toggle('on', hwrMode === 'text');
    $('inkHwrTex').classList.toggle('on', hwrMode === 'formula');
    /* 轻点分段只在 ✍ 模式下生效：普通画笔点一下还是要点一个点 */
    board.tapToEnd = hwrMode === 'text';
  }
  paintHwrBtns();

  function setHwrMode(m) {
    hwrMode = hwrMode === m ? 'off' : m;
    try { localStorage.setItem(HWR_MODE_KEY, hwrMode); } catch (e) { /* 无痕 */ }
    paintHwrBtns();
    try { commitLine(true, true); } catch (e) { /* 还没定义 */ }
    pendingTex.clear();
    clearTimeout(texTimer);
    if (hwrMode === 'text') toast('边写边认已开：写完一个字就变成文字，停一下把整行定稿');
    else if (hwrMode === 'formula') {
      toast('公式模式：写完停笔，手写公式变成 LaTeX 排版（要用 AI 接口）');
      if (!getCfg().vision) toast('还没勾「模型支持看图」，公式模式需要视觉模型', true);
    } else toast('画布识别已关，笔迹保持原样');
  }

  $('inkHwrText').onclick = () => { if (st.note && st.mode !== 'md') setHwrMode('text'); };
  $('inkHwrTex').onclick = () => { if (st.note && st.mode !== 'md') setHwrMode('formula'); };

  board.onItemsChanged = () => renderItems();

  /* 正在预览的这一行，用户按撤销 = 不要这次转换：把文字撤掉，墨迹由 undo 快照恢复 */
  board.onBeforeUndo = () => {
    if (!live) return;
    const L = live;
    live = null;
    clearTimeout(L.pt);
    clearTimeout(L.ct);
    if (!L.item) return;
    const p = pageNow();
    if (!p || !Array.isArray(p.items)) return;
    if (L.base) {
      /* 续写的那一段：只退掉这次新加的字，前面认好的留着 */
      L.item.text = L.base;
      fitItemWidth(L.item);
    } else {
      p.items = p.items.filter((x) => x.id !== L.item.id);
      board.items = p.items;
    }
    renderItems();
  };

  /** 一行笔迹 → 原位文字块（字号按设置/笔迹高度，颜色跟着笔走；宽度按文字实际排版量出来） */
  function insertTextFromInk(list, text, opt) {
    const bb = bboxOf(list);
    if (!bb) return null;
    const p = pageNow();
    if (!p) return null;
    if (!Array.isArray(p.items)) p.items = [];
    const o = opt || {};
    /* 字号优先级：设置里固定的大小 > 本次会话估出来的 > 笔迹高度 > 上一段的字号 */
    const guess = layout.size || o.size || estimateSize(list) || Math.round(bb.h * 1.1) || lastSize;
    const size = Math.round(Math.max(10, Math.min(160, guess)));
    const lh = layout.gap;
    lastSize = size;
    let x = Math.round(bb.x - size * 0.02);
    let y = Math.round(bb.y - size * 0.15);
    const it = {
      id: uid('it'), type: 'text', z: 'above', text,
      size, lh, color: (list[0] && list[0].c) || '#1f1c18',
      /* .tx 的行高是 lh，字面顶部离行盒顶约 0.15 个字号，这里补回来，让文字正好压在墨迹上 */
      x, y, w: 100, h: Math.round(size * lh),
    };
    fitItemWidth(it);

    /* 和上一块排成一段：左边界对齐（按设置的对齐方式）、行距统一。
       这就是「默认成行、整整齐齐」的关键——不按手写位置硬贴，而是排到上一块的下一行。 */
    const a = o.anchor;
    if (a && a.type === 'text' && p.items.indexOf(a) >= 0) {
      const aSize = itemSize(a);
      const aLh = itemLh(a);
      /* 用上一块「文字实际宽度」当基准：块的 x 就是文字起点，右边那点 padding 不该算进居中 */
      const aW = textMetricsOf(a).w;
      const myW = textMetricsOf(it).w;
      if (layout.align === 'center') x = Math.round(a.x + (aW - myW) / 2);
      else if (layout.align === 'right') x = Math.round(a.x + Math.max(0, aW - myW));
      else x = Math.round(a.x);
      /* 离得近才贴到下一行；离得远说明是另起一段，保留手写位置 */
      const step = Math.round(aSize * aLh);
      if (bb.y - (a.y + step) < aSize * 1.8) y = Math.round(a.y + step);
      it.x = Math.max(4, x);
      it.y = Math.max(4, y);
      it.para = a.para || a.id;   /* 同一段：方便「整理本页」按段排 */
    }
    /* 定稿后在同一行接着写：另起一块，但基线跟上一块齐、排在它右边，
       既不覆盖上一块，也不会因为手写差几个像素显得歪 */
    const sl = o.sameLine;
    if (sl && sl.type === 'text' && p.items.indexOf(sl) >= 0) {
      const slSize = itemSize(sl);
      const slW = textMetricsOf(sl).w;
      it.y = Math.max(4, Math.round(sl.y + (slSize - size) * 0.15));
      it.x = Math.max(4, Math.round(Math.max(it.x, sl.x + slW + size * 0.12)));
    }
    p.items.push(it);
    return it;
  }

  /** 一行笔迹 → 原位公式（LaTeX 经 MathJax 排成 SVG 图片，可拖动、可缩放） */
  function insertTexFromInk(list, tex) {
    const bb = bboxOf(list);
    const p = pageNow();
    if (!bb || !p) return null;
    if (!Array.isArray(p.items)) p.items = [];
    const color = (list[0] && list[0].c) || '#1f1c18';
    const em = Math.max(10, Math.min(140, bb.h * 0.92));
    const img = texToImage(tex, em, color);
    /* 让排出来的公式高度正好等于原来手写的高度 */
    const k = bb.h / Math.max(1, img.h);
    const it = {
      id: uid('it'), type: 'image', z: 'above', src: img.src, tex: img.tex,
      x: Math.round(bb.x), y: Math.round(bb.y),
      w: Math.round(img.w * k), h: Math.round(bb.h),
    };
    p.items.push(it);
    return it;
  }

  /**
   * 把一组笔画转成文字或公式。
   * kind: 'text' | 'formula'
   * 返回 true 表示转成功（笔画已经换成内容）
   */
  async function convertInk(list, kind) {
    if (!list || !list.length || !st.note) return false;
    const ink = inkToCanvasCached(list);
    if (!ink) return false;
    let made = null;
    if (kind === 'formula') {
      if (!getCfg().vision) {
        toast('转公式要用「支持看图」的模型：去设置里勾上，或换个视觉模型', true);
        return false;
      }
      const r = await recognizeFormula(ink, chat);
      if (!r.tex) { toast('没认出公式，笔迹留着没动', true); return false; }
      made = insertTexFromInk(list, r.tex);
      if (made) toast(`已转成公式（${r.tex.slice(0, 40)}）· 点 ↶ 可退回笔迹`);
    } else {
      const r = await recognizeLocal(ink);
      if (!r.text) { toast('没认出字，笔迹留着没动', true); return false; }
      if (r.score < 0.2) {
        toast('这段不太确定，先没动它；想硬认就用 ⬚ 圈住后点「转文字」', true);
        return false;
      }
      made = insertTextFromInk(list, r.text);
      if (made) {
        const hint = looksLikeFormula(list) ? '（看着像公式？切到 ∑ 重写一次，或用 ⬚ 圈住点「转公式」）' : '';
        toast(`已转成文字「${r.text.slice(0, 12)}」· 点 ↶ 可退回笔迹${hint}`);
        showCandBar(made, r.cands, ink.dataUrl);
      }
    }
    if (!made) return false;
    board.removeStrokes(list);
    renderItems();
    saveSoon(true);
    return true;
  }

  /* 光栅化一次就够：转文字和转公式都吃同一张图 */
  function inkToCanvasCached(list) {
    try { return inkToCanvas(list); } catch (e) { return null; }
  }

  /* ---------- 边写边认（✍）：一行写到底，墨迹一个一个字变成文字 ---------- */
  /* 三个时间参数（都能在设置里调）：
       idle   —— 抬笔后多久「开始识别」。Windows Ink 官方文档用的也是 1 秒：
                 太短的话，一个字写到一半停一下就会被当成写完，认成半个字。
       commit —— 抬笔后多久「这一行写完」，墨迹删掉只留文字。默认 8 秒。
       need   —— 识别引擎是单线程的。正在认的时候又来了新笔画，不能把这次请求丢掉，
                 要记一笔 need，这一轮结束立刻补认 —— 丢一次就等于那几笔没进文字，
                 定稿时被一起删掉，表现就是「写了的字被吞了」。
     做法：抬笔 idle 后把「这一行到目前为止的墨迹」整行认一次，认出来的字原位铺成文字块，
     同时把这一行墨迹临时藏起来（数据还在，只是不画）。接着写的字照常落在后面，
     下一次再整行认一遍、整体刷新 —— 所以越写越准，而不是一个字一个结果。
     停笔 commit、换行、或关掉模式 → 定稿：把「已经变成文字」的墨迹删掉，只留文字。 */
  function hwrIdleMs() {
    try { return Math.max(200, Math.min(2000, getHwrCfg().idle || 800)); } catch (e) { return 800; }
  }
  function hwrCommitMs() {
    try { return Math.max(1200, Math.min(20000, getHwrCfg().commit || 3000)); } catch (e) { return 3000; }
  }

  function startSession(stroke) {
    const p = pageNow();
    const bb = bboxOf([stroke]);
    const base = { strokes: [], item: null, base: '', size: 0, gen: 0, pt: 0, ct: 0, need: false, tries: 0 };
    if (!p || !bb) return base;
    const prev = lastPara ? p.items.find((x) => x.id === lastPara.id && x.type === 'text') : null;
    if (!prev || Date.now() - lastPara.t > 45000) return base;
    const size = prev.size || 32;
    /* 上一块已经定稿 = 上一次书写结束了。这时候再落笔是**新的一次输入**，
       不能再并进上一块继续累积（否则写完三个字、停一会儿再写一个字，
       会变成四个字挤在同一块里）。连续书写时不会定稿，所以不受影响。 */
    const closed = !!lastPara.closed;
    const cy = bb.y + bb.h / 2;
    const endX = prev.x + measureW(prev.text, size);
    const gap = bb.x - endX;
    /* ⓪ 标点（一小笔）一律并进上一块：单独一块模型认不出来，并进去才能整行重认 / 按形状兜底。
       标点本来就是挂在上一句尾巴上的，定稿后补一个句号也该并进去。 */
    if (isPunctLike([stroke], size)) {
      return { ...base, item: prev, base: String(prev.text || ''), size };
    }
    /* ① 同一行、接着上一块的尾巴写 → 续写（字号、位置都不动）。
       只在「这一行还没定稿」时成立。 */
    if (!closed && cy > prev.y + size * 0.15 && cy < prev.y + size * 1.55 && gap > -size * 2.2 && gap < size * 1.8) {
      return { ...base, item: prev, base: String(prev.text || ''), size };
    }
    /* ② 下一行 → 另起一块，但锚到上一块：左边界对齐、行距统一（默认就排整齐） */
    const aSize = itemSize(prev);
    const step = Math.round(aSize * itemLh(prev));
    if (bb.y > prev.y + aSize * 0.8 && bb.y - (prev.y + step) < aSize * 3.2) {
      return { ...base, size, anchor: prev };
    }
    /* ③ 同一行（定稿后接着写也走这里）→ 另起一块，但基线跟上一块对齐、排在它右边，
       不覆盖、也不挤进上一块的文字里 */
    if (cy > prev.y - aSize * 0.9 && cy < prev.y + aSize * 1.6) {
      return { ...base, size, sameLine: prev };
    }
    return base;
  }

  function breaksLine(stroke) {
    if (!live || !live.strokes.length) return false;
    /* 这一行还没成形（没有文字块、只写了一两笔）就别判断换行：
       单笔的 bbox 只有几像素高，算出来的行高/字号全是错的，
       第二笔稍微靠下就会被当成「下一行」——一个字直接被拆成两块。
       真要是另起一行，上一行早就定稿了（live 为空），轮不到这里判断。 */
    if (!live.item && live.strokes.length < 3) return false;
    const b = bboxOf([stroke]);
    const all = bboxOf(live.strokes);
    if (!b || !all) return false;
    /* 行高别只看可见墨迹：墨迹已经被藏起来（变成文字）时只剩新写的一笔，
       算出来的行高很小，同一行里的第二笔就会被判成「下一行」——
       这是「一个字被拆成好几块」的第二个根因。
       字号同理：只写一横时 estimateSize 会给个 12px 的小字号，
       拿它去算行距，同一个字的下半部分就被甩到下一块去了。
       所以这里取「整行墨迹高度」当字号下限。 */
    const size = Math.max(live.size || 0, all.h * 0.95, live.item ? itemSize(live.item) : 0);
    const lineH = Math.max(24, size * 0.9, all.h);
    /* 标点这种一小笔永远不换行：拆成单独一块后模型认不出来（实测返回空） */
    if (isPunctLike([stroke], lineH)) return false;
    /* 这一行文字的上下边界：有文字块就按文字块算，没有就按墨迹算 */
    const topY = live.item ? live.item.y : all.y;
    const botY = live.item ? live.item.y + itemSize(live.item) : all.y + all.h;
    const step = size * (live.item ? itemLh(live.item) : 1.35);
    /* 行距 1.3~1.4 时，下一行起笔只比本行文字底部低一点点（约 0.15 行高），
       门槛太严就永远换不了行，字全挤进同一块 */
    if (b.y <= botY + lineH * 0.15) return false;
    /* 和「最后一个字」横向有交集，而且没低出一整行 → 是这个字的下半部分
       （「王」的末横、「你」的「尔」、上下结构），不能当换行 */
    const cs = charClusters(live.strokes);
    const lastC = cs.length ? cs[cs.length - 1] : null;
    const onLastChar = !!lastC && b.x < lastC.x1 + lineH * 0.25 && b.x + b.w > lastC.x0 - lineH * 0.25;
    if (onLastChar && b.y < topY + size * 1.25) return false;
    /* 回行首 → 新的一行；没回行首但低了很多（右侧另起一段）也算 */
    return b.x < all.x + size * 1.2 || b.y > botY + step * 0.9;
  }

  /** 已藏起来 = 已经变成文字，只有这些能删 */
  function hiddenOf(L) { return L.strokes.filter((s) => board.hidden.has(s)); }
  /** 还看得见 = 这一轮没认出来 / 还没轮到认，绝对不能跟着删 */
  function visibleOf(L) { return L.strokes.filter((s) => !board.hidden.has(s)); }

  /** 排一次识别：ms 后跑（默认用设置里的 idle），期间又来笔画就重新排 */
  function schedulePreview(L, ms) {
    if (!L) return;
    clearTimeout(L.pt);
    L.pt = setTimeout(() => { if (live === L) previewLine(L); }, Math.max(0, ms));
  }

  /** 排一次定稿：识别还没跑完就等一会儿再定稿，别拿旧的文字结果收尾 */
  function scheduleCommit(L) {
    if (!L) return;
    clearTimeout(L.ct);
    L.ct = setTimeout(() => {
      if (live !== L) return;
      if (busyConv || L.need) { scheduleCommit(L); return; }
      commitLine(false, false);   /* 时间到只是收尾，不封段 */
    }, hwrCommitMs());
  }

  async function previewLine(want) {
    const L = want || live;
    if (window.__kynbDebug) window.__hwrDbg = { step: 'enter', live: !!live, busy: busyConv, note: !!st.note };
    if (!L || !st.note) return;
    /* 引擎正忙：记下「还有新的要认」，这一轮结束立刻补跑。
       以前这里直接 return，那几笔就永远进不了文字（定稿时被一起删 = 笔画被吞） */
    if (busyConv) { L.need = true; return; }
    const strokes = L.strokes.slice();
    const gen = L.gen;
    if (!strokes.length) return;
    busyConv = true;
    try {
      /* 长行会被自动切段识别，不会再「后半截掉字」；
         带上正常字号，识别器才知道「这一小笔是不是标点」 */
      const refSize = L.size || (L.item ? itemSize(L.item) : 0) || lastSize || 0;
      const r = await recognizeStrokes(strokes, { lineH: refSize });
      if (window.__kynbDebug) window.__hwrDbg = { step: 'recognized', text: r.text, score: r.score, stale: !(live === L && live.gen === gen) };
      /* 期间又写了新的：这次结果过期，但别丢掉请求 —— 标记补跑，用最新的墨迹再认一遍 */
      if (!live || live !== L || L.gen !== gen) { L.need = true; return; }
      /* 置信度只挡「完全不像字」的涂鸦；认错了还能点候选 / AI 再看，比不认强 */
      if (!r.text || r.score < 0.12) return;
      /* 第一笔估出来的字号常常偏小（一横只有几像素高，estimateSize 会给 12px），
         先按上一段的字号兜一下，写下去以后再按整行墨迹高度往上抬 */
      if (!L.size) L.size = layout.size || Math.max(estimateSize(strokes) || 0, Math.round((lastSize || 40) * 0.8)) || lastSize;
      else if (!layout.size && L.item) {
        /* 整行墨迹比字号高一大截时，把这一块的字号抬到跟字高一致 ——
           不然字挤在一起，换行判断也会算错 */
        const allH = (bboxOf(L.strokes) || {}).h || 0;
        if (allH > L.size * 1.25) {
          const ns = Math.min(160, Math.round(allH * 0.95));
          if (ns > L.size) { L.size = ns; L.item.size = ns; }
        }
      }
      L.cands = r.cands || null;
      L.inkUrl = r.dataUrl || '';
      if (!L.item) {
        L.item = insertTextFromInk(strokes, r.text, { size: L.size, anchor: L.anchor });
        /* 插不进文字块（页面被切走 / 数据异常）就**别藏墨迹**：
           藏了却没有任何文字接手，这一行就等于被吞掉了 */
        if (!L.item) return;
      } else {
        /* 续写的那块可能已经被用户删了：别往已删除的块里写，重新起一块 */
        const pg = pageNow();
        if (pg && Array.isArray(pg.items) && pg.items.indexOf(L.item) < 0) {
          L.item = null;
          L.base = '';
          L.item = insertTextFromInk(strokes, r.text, { size: L.size });
          if (!L.item) return;
        } else {
          L.item.text = (L.base || '') + r.text;
          fitItemWidth(L.item);     /* 续写不改字号：一段话只用一个字号 */
        }
      }
      if (window.__kynbDebug) window.__hwrDbg = { step: 'inserted', id: L.item && L.item.id, items: (pageNow() || {}).items ? pageNow().items.length : -1 };
      board.hideStrokes(strokes, true);   /* 这一行的墨迹先藏起来，屏幕上只剩文字 */
      renderItems();
      saveSoon(false);
      if (!hinted) {
        hinted = true;
        toast('手指点一下这段文字，可以改字号或删掉；用笔接着写就是继续这一行');
      }
    } catch (e) {
      /* 识别失败就当没发生，墨迹还在 */
      if (window.__kynbDebug) window.__hwrDbg = { step: 'error', msg: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 300) };
    } finally {
      busyConv = false;
      /* 排队的那一次补上：不补就会「越写越少字」 */
      if (live === L && L.need) { L.need = false; schedulePreview(L, 40); }
    }
  }

  /** 这一行定稿：**只删已经变成文字的墨迹**，文字留下（撤销只会退掉这一次转换）
      final=true：换页 / 关模式时用 —— 没进文字的笔画留在原处，不要在新页接着认
      close=true：真的「这一段结束了」（换行 / 轻点 / 切页）。时间到只是收尾，
      不封段 —— 否则写字慢的人（笔画之间停几秒）会被拆成一块块。 */
  function commitLine(final, close) {
    const L = live;
    if (!L) return;
    clearTimeout(L.pt);
    clearTimeout(L.ct);
    live = null;
    /* 关键：以前这里是 removeStrokes(L.strokes)，把整行墨迹全删。
       如果最后一次识别没跑完 / 没认出（那几笔还没被藏起来），
       它们就会连墨迹带文字一起消失 —— 这就是「写了的笔画被系统吞掉」。
       现在只删 hidden 的（= 已经在文字里的），没进文字的留在画布上继续认。 */
    const done = hiddenOf(L);
    const rest = visibleOf(L);
    if (L.item) {
      /* 快照：续写的情况下把这一段新加的字去掉；新起一块的情况下把整块去掉。
         撤销后回到「墨迹还在、还没转」的状态。 */
      const snap = board._snap();
      if (L.base) {
        snap.items = snap.items.map((x) => (x.id === L.item.id ? { ...x, text: L.base } : x));
      } else {
        snap.items = snap.items.filter((x) => x.id !== L.item.id);
      }
      board.undoStack.push(snap);
      if (board.undoStack.length > 100) board.undoStack.shift();
      board.redoStack.length = 0;
    }
    if (done.length) board.removeStrokes(done);
    renderItems();
    saveSoon(true);
    /* closed：这一段真的结束了，下一次落笔另起一块（见 startSession）。
       还有没认出来的墨迹（rest）时先不封，等它们续认完再封。 */
    if (L.item) lastPara = { id: L.item.id, t: Date.now(), size: L.item.size, closed: !!close && !rest.length };
    if (L.item && L.cands && L.cands.length > 1) showCandBar(L.item, L.cands, L.inkUrl);
    /* 剩下的墨迹别变成「死墨迹」：开新一轮接着认（同一次识别失败最多重试 3 轮） */
    if (rest.length && !final && hwrMode === 'text') resumeWith(rest, L);
  }

  /** 定稿后还有没进文字的笔画：接着往同一块里续认
      （注意别用 startSession：那一块已经定稿了，startSession 会另起新块，
       同一个字就被拆成两块了） */
  function resumeWith(list, from) {
    if (!list.length) return;
    const tries = (from && from.tries) || 0;
    if (tries >= 3) {
      if (!resumeHinted) {
        resumeHinted = true;
        toast('这几笔没认出来，墨迹先留着；可以圈住它们点「转文字」，或者擦掉重写', true);
      }
      return;
    }
    let L = live;
    if (!L) {
      L = {
        strokes: [], item: (from && from.item) || null,
        /* base 用「这块现在的文字」：rest 只是没认出来的那几笔，
           重认完应该追加到已有文字后面，不能把整块覆盖掉 */
        base: from && from.item ? String(from.item.text || '') : '',
        size: (from && from.size) || 0, gen: 0, pt: 0, ct: 0, need: false, tries: 0,
        anchor: (from && from.anchor) || null,
      };
      /* 必须挂回 live：不挂的话这个会话是孤儿，预览/定稿的定时器都认不出它，
         那几笔就永远停在画布上（「写完定稿后多出一笔」就是这么来的） */
      live = L;
    }
    L.tries = tries + 1;
    for (const s of list) if (L.strokes.indexOf(s) < 0) L.strokes.push(s);
    L.gen++;
    schedulePreview(L, 260);
    scheduleCommit(L);
  }

  /** 公式模式：AI 慢，不适合每个字刷一遍，写完整段再一次性转 */
  async function flushFormula() {
    if (busyConv || !st.note) return;
    const list = [...pendingTex].filter((s) => board.strokes.indexOf(s) >= 0);
    pendingTex.clear();
    if (!list.length) return;
    busyConv = true;
    try {
      const lines = groupLines(list);
      for (const line of lines) {
        if (!line.length) continue;
        board.pushUndo();
        await convertInk(line, 'formula');
      }
    } catch (e) {
      toast('公式转换失败：' + (e && e.message ? e.message : e), true);
    } finally {
      busyConv = false;
    }
  }

  /* 落笔 = 还在写这个字：把「等一会儿开始识别」的定时器停掉，
     等他抬笔后重新计时。否则识别会正好在笔画中途跑起来，认到半个字 */
  board.onStrokeStart = () => {
    if (live) clearTimeout(live.pt);
  };

  /* 轻点空白处 = 这一段写完了：立刻认一次、定稿，接着写就是新的一段。
     这样就不用「等停笔多久」——分段由用户说了算，想接着同一段写就别点。 */
  board.onTap = async () => {
    if (hwrMode !== 'text' || !live || !st.note) return;
    const L = live;
    clearTimeout(L.pt);
    clearTimeout(L.ct);
    await previewLine(L);
    /* 引擎还在跑就等它跑完（最多 1 秒），别拿旧的识别结果收尾 */
    for (let i = 0; i < 20 && busyConv; i++) await new Promise((r) => setTimeout(r, 50));
    if (live !== L) return;
    commitLine(true, true);   /* 轻点 = 这一段写完了 */
    if (L.item && !tapHinted) {
      tapHinted = true;
      toast('这一段结束了，接着写就是新的一段；想继续同一段就别点，直接写');
    }
  };

  board.onStrokeEnd = (stroke) => {
    hideCandBar();
    if (hwrMode === 'off' || !st.note || st.mode === 'md') return;
    /* 除了荧光笔和橡皮，各种笔写出来的都参与识别（以前只认 'pen'，换了圆珠笔就不认了） */
    if (stroke.t === 'hl' || stroke.t === 'er') return;

    if (hwrMode === 'formula') {
      pendingTex.add(stroke);
      clearTimeout(texTimer);
      texTimer = setTimeout(() => flushFormula(), 1500);
      return;
    }

    if (breaksLine(stroke)) commitLine(false, true);   /* 换行 = 新的一段 */
    if (!live) live = startSession(stroke);
    const L = live;
    L.strokes.push(stroke);
    L.gen++;
    L.tries = 0;                 /* 有新笔画 = 重新开始，重试次数归零 */
    clearTimeout(L.pt);
    clearTimeout(L.ct);
    /* 开始识别的时间可调（默认 800ms）：Windows Ink 官方也是「抬笔后 1 秒没有新笔才开始认」。
       太短的话，一个字写到一半停一下就被当成写完，认成半个字，还容易把后面的笔画挤丢 */
    schedulePreview(L, hwrIdleMs());
    /* 定稿时间可调（默认 8 秒）：写一个字的笔画之间停 2~5 秒是常态，
       定稿太快 = 一个字被拆成好几块，所以别用 2.4 秒那种短阈值 */
    scheduleCommit(L);
  };

  /* ---------- ⬚ 圈选：框住一片笔迹，就地转换 ---------- */
  const selBar = $('hwrSelBar');
  let lasso = null;         // {x0,y0,x1,y1, strokes}

  function pagePos(e) {
    const r = board.cv.getBoundingClientRect();
    const k = r.width / board.pageW || 1;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  }

  function clearLasso() {
    lasso = null;
    selBar.hidden = true;
    const m = board.paper.querySelector('.marquee');
    if (m) m.remove();
  }

  stageEl.addEventListener('pointerdown', (e) => {
    if (st.tool !== 'lasso' || !st.note || st.mode === 'md') return;
    e.preventDefault();
    clearLasso();
    const [x, y] = pagePos(e);
    const box = document.createElement('div');
    box.className = 'marquee';
    board.paper.appendChild(box);
    lasso = { x0: x, y0: y, x1: x, y1: y, box, strokes: null, pid: e.pointerId };
    const move = (ev) => {
      if (!lasso) return;
      const [nx, ny] = pagePos(ev);
      lasso.x1 = nx; lasso.y1 = ny;
      const s = (board.paper.clientWidth || PAGE_W) / PAGE_W;
      box.style.left = Math.min(lasso.x0, nx) * s + 'px';
      box.style.top = Math.min(lasso.y0, ny) * s + 'px';
      box.style.width = Math.abs(nx - lasso.x0) * s + 'px';
      box.style.height = Math.abs(ny - lasso.y0) * s + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!lasso) return;
      const L = lasso;
      const list = board.strokesInRect(L.x0, L.y0, L.x1, L.y1);
      if (!list.length) { clearLasso(); toast('这一框里没有笔迹', true); return; }
      L.strokes = list;
      $('selInfo').textContent = `已选中 ${list.length} 笔`;
      selBar.hidden = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /* ---------- 「↖ 选择」下拖一个框：批量选中框里的文字 / 图片 ---------- */
  let selBox = null;

  stageEl.addEventListener('pointerdown', (e) => {
    if (st.tool !== 'sel' || !st.note || st.mode === 'md') return;
    if (e.target.closest('.it') || e.target.closest('.itbar')) return;   /* 点到块上 = 点选，不是框选 */
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    const box = document.createElement('div');
    box.className = 'marquee';
    board.paper.appendChild(box);
    const state = { x0, y0, x1: x0, y1: y0, moved: false, pid: e.pointerId };
    selBox = state;
    const move = (ev) => {
      if (selBox !== state) return;
      state.x1 = ev.clientX; state.y1 = ev.clientY;
      if (!state.moved && Math.hypot(state.x1 - x0, state.y1 - y0) > 5) state.moved = true;
      if (!state.moved) return;
      /* 框是画在纸上（1414×1000 的页面坐标系），所以要把视口坐标换算回去 */
      const [ax, ay] = pagePos({ clientX: x0, clientY: y0 });
      const [bx, by] = pagePos({ clientX: state.x1, clientY: state.y1 });
      const sc = (board.paper.clientWidth || PAGE_W) / PAGE_W;
      box.style.left = Math.min(ax, bx) * sc + 'px';
      box.style.top = Math.min(ay, by) * sc + 'px';
      box.style.width = Math.abs(bx - ax) * sc + 'px';
      box.style.height = Math.abs(by - ay) * sc + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (selBox === state) selBox = null;
      box.remove();
      if (!state.moved) {           /* 就是点了一下空白：清空选中 */
        sel.clear();
        closeBar();
        renderItems();
        return;
      }
      const L = Math.min(x0, state.x1), R = Math.max(x0, state.x1);
      const T = Math.min(y0, state.y1), B = Math.max(y0, state.y1);
      const p = pageNow();
      if (!p || !Array.isArray(p.items)) return;
      /* 框到哪几个字就选哪几个字（不再整块整块地选） */
      const [px0, py0] = pageAt(L, T);
      const [px1, py1] = pageAt(R, B);
      const pl = Math.min(px0, px1), pr = Math.max(px0, px1);
      const pt = Math.min(py0, py1), pb = Math.max(py0, py1);
      sel.clear();
      let chars = 0, blocks = 0;
      for (const it of p.items) {
        const el = itemEl(it.id);
        if (!el) continue;
        const er = el.getBoundingClientRect();
        if (er.right < L || er.left > R || er.bottom < T || er.top > B) continue;
        if (it.type !== 'text') { sel.set(it.id, null); blocks += 1; continue; }
        let a = Infinity, b = -Infinity;
        for (const box of charBoxes(it)) {
          if (box.x + box.w < pl || box.x > pr || box.y + box.h < pt || box.y > pb) continue;
          a = Math.min(a, box.i);
          b = Math.max(b, box.i + 1);
        }
        if (b > a) { sel.set(it.id, { a, b }); chars += b - a; }
      }
      paintSel();
      if (!sel.size) { closeBar(); toast('这一框里没有文字或图片', true); return; }
      openBar(selItems()[0]);
      toast(chars && blocks ? `已选中 ${chars} 个字 + ${blocks} 块`
        : (chars ? `已选中 ${chars} 个字` : `已选中 ${blocks} 块`));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  $('selCancel').onclick = () => { clearLasso(); setTool(st.tool); };
  $('selToText').onclick = async () => {
    if (!lasso || !lasso.strokes) return;
    const list = lasso.strokes;
    clearLasso();
    board.pushUndo();
    await convertInk(list, 'text');
    setTool('pen');
  };
  $('selToTex').onclick = async () => {
    if (!lasso || !lasso.strokes) return;
    const list = lasso.strokes;
    clearLasso();
    board.pushUndo();
    await convertInk(list, 'formula');
    setTool('pen');
  };

  function openTextDialog(it) {
    editingId = it ? it.id : null;
    if (it) activeTextId = it.id;      /* 手写接下来往这个框里写 */
    $('textTitle').textContent = it ? '编辑文字' : '插入文字';
    $('textInput').value = it ? (it.text || '') : '';
    $('textSize').value = String(it ? (it.size || 32) : 32);
    $('textColor').value = (it && it.color) || '#1f1c18';
    $('dlgText').showModal();
    setTimeout(() => $('textInput').focus(), 30);
  }

  /* ---------- 识别候选条：刚认完这一行，给几个「只差一个字」的备选 + AI 复核 ---------- */

  /** 只挑「长度一样、只差一个字、纯中文」的候选——其它多半是形近乱码，给出来反而添乱 */
  function usefulCands(text, cands) {
    const t0 = String(text || '');
    const out = [];
    if (!/^[\u4e00-\u9fff]+$/.test(t0)) return out;
    for (const c of (cands || []).slice(1)) {
      const t = String((c && c.text) || '');
      if (!t || t === t0 || t.length !== t0.length) continue;
      if (!/^[\u4e00-\u9fff]+$/.test(t)) continue;
      let diff = 0;
      for (let i = 0; i < t.length && diff < 2; i++) if (t[i] !== t0[i]) diff++;
      if (diff === 1) out.push(t);
      if (out.length >= 2) break;
    }
    return out;
  }

  function hideCandBar() {
    clearTimeout(candTimer);
    candFor = null;
    if (candBar) candBar.hidden = true;
  }

  function placeCandBar(it) {
    /* 候选条固定在屏幕下方（样式里定的），不跟着文字走——跟着文字会挡住下一行的起笔 */
    if (!candBar) return;
    candBar.style.removeProperty('left');
    candBar.style.removeProperty('top');
    if (it && !itemEl(it.id)) hideCandBar();
  }

  async function aiFix(it, inkUrl) {
    if (!inkUrl) return;
    toast('让 AI 再看一遍这一行…');
    try {
      const r = await recognizeAI({ dataUrl: inkUrl }, chat);
      if (r && r.text && r.text !== it.text) {
        it.text = r.text;
        fitItemWidth(it);
        renderItems();
        saveSoon(true);
        toast(`AI 改成「${r.text.slice(0, 16)}」`);
      } else {
        toast('AI 也觉得原来那样，没改');
      }
    } catch (e) {
      toast('AI 识别失败：' + (e && e.message ? e.message : e), true);
    }
    hideCandBar();
  }

  function showCandBar(it, cands, inkUrl) {
    if (!candBar || !it) return;
    const alts = usefulCands(it.text, cands);
    const vision = !!getCfg().vision;
    if (!alts.length && !vision) { hideCandBar(); return; }
    candFor = it;
    candBar.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = '认成';
    candBar.appendChild(lbl);
    for (const t of alts) {
      const b = document.createElement('button');
      b.textContent = t;
      b.title = '用这个';
      b.onclick = () => {
        it.text = t;
        fitItemWidth(it);
        renderItems();
        saveSoon(true);
        hideCandBar();
        toast('已改成「' + t.slice(0, 16) + '」');
      };
      candBar.appendChild(b);
    }
    if (vision) {
      const b = document.createElement('button');
      b.className = 'ai';
      b.textContent = 'AI 再看';
      b.title = '把这一行交给视觉模型重认一次（更准，但要 2~5 秒）';
      b.onclick = () => aiFix(it, inkUrl);
      candBar.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'close';
    x.textContent = '✕';
    x.onclick = () => hideCandBar();
    candBar.appendChild(x);
    candBar.hidden = false;
    placeCandBar(it);
    clearTimeout(candTimer);
    candTimer = setTimeout(() => hideCandBar(), 8000);
  }

  window.addEventListener('resize', () => { if (candFor) placeCandBar(candFor); });
  stageEl.addEventListener('scroll', () => { if (candFor) placeCandBar(candFor); }, { passive: true });

  /* ---------- 打字工具：点一下纸面，就地输入（Enter 结束，Esc 取消） ---------- */
  function startInlineText(e) {
    if (inlineEditor) finishInlineText(true);
    const [px, py] = pageAt(e.clientX, e.clientY);
    const sc = (board.paper.clientWidth || PAGE_W) / PAGE_W;
    const size = 36;
    const el = document.createElement('div');
    el.className = 'inline-text';
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.style.left = Math.round(px * sc) + 'px';
    el.style.top = Math.round(py * sc) + 'px';
    el.style.fontSize = Math.round(size * sc) + 'px';
    el.style.color = st.color || '#1f1c18';
    el.style.maxWidth = Math.round(Math.max(120, Math.min(560, board.pageW - px - 16)) * sc) + 'px';
    board.paper.appendChild(el);
    inlineEditor = { el, px, py, size };
    setTimeout(() => el.focus(), 0);
    el.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finishInlineText(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finishInlineText(false); }
    });
    el.addEventListener('blur', () => finishInlineText(true));
    toast('直接打字，Enter 结束（Shift+Enter 换行）');
  }

  function finishInlineText(commit) {
    const ed = inlineEditor;
    if (!ed) return;
    inlineEditor = null;
    const txt = String(ed.el.innerText || '').replace(/\u200b/g, '').replace(/\n+$/, '');
    ed.el.remove();
    if (!commit || !txt.trim()) return;
    const p = pageNow();
    if (!p) return;
    if (!Array.isArray(p.items)) p.items = [];
    const it = {
      id: uid('it'), type: 'text', z: 'above', text: txt, size: ed.size,
      color: st.color || '#1f1c18', x: Math.round(ed.px), y: Math.round(ed.py),
      w: 200, h: Math.round(ed.size * 1.4),
    };
    fitItemWidth(it);
    p.items.push(it);
    renderItems();
    saveSoon(true);
  }

  stageEl.addEventListener('pointerdown', (e) => {
    if (st.tool !== 'text' || !st.note || st.mode === 'md') return;
    if (e.target.closest('.inline-text')) return;
    const hit = e.target.closest('.it') ? hitItemAt(e.clientX, e.clientY) : null;
    if (hit) {
      e.preventDefault();
      if (hit.type === 'text') openTextDialog(hit);
      return;
    }
    e.preventDefault();
    startInlineText(e);
  }, true);

  $('textCancel').onclick = () => { editingId = null; $('dlgText').close(); };
  $('textOk').onclick = () => {
    const txt = $('textInput').value;
    const size = Math.max(12, Math.min(160, Number($('textSize').value) || 32));
    const color = $('textColor').value || '#1f1c18';
    const p = pageNow();
    if (!txt.trim() || !p) { editingId = null; $('dlgText').close(); return; }
    if (!Array.isArray(p.items)) p.items = [];
    if (editingId) {
      const it = p.items.find((x) => x.id === editingId);
      if (it) {
        it.text = txt; it.size = size; it.color = color;
        fitItemWidth(it);            /* 改完字重算宽度，别因为宽度不够自己折行 */
      }
      activeTextId = editingId;
    } else {
      const box = {
        id: uid('it'), type: 'text', z: 'above', text: txt, size, color,
        x: Math.round(PAGE_W * 0.1), y: Math.round(PAGE_H * 0.12), w: Math.round(PAGE_W * 0.8), h: 120,
      };
      p.items.push(box);
      activeTextId = box.id;         /* 接着用「✍ 手写」就往这里追加 */
    }
    editingId = null;
    $('dlgText').close();
    renderItems();
    saveSoon(true);
    setTool('sel');
  };

  $('inkAddImage').onclick = () => {
    if (!st.note || st.mode === 'md') return;
    $('inkFileImage').value = '';
    $('inkFileImage').click();
  };
  $('inkFileImage').onchange = async () => {
    const f = $('inkFileImage').files && $('inkFileImage').files[0];
    if (!f) return;
    try {
      const img = await loadImageFile(f);
      const url = imageToDataUrl(img, 1400, 0.86);
      const w = Math.round(PAGE_W * 0.46);
      const h = Math.round(w * (img.naturalHeight / Math.max(1, img.naturalWidth)));
      const p = pageNow();
      if (!p) return;
      if (!Array.isArray(p.items)) p.items = [];
      p.items.push({
        id: uid('it'), type: 'image', z: 'below', src: url,
        x: Math.round((PAGE_W - w) / 2), y: Math.round((PAGE_H - h) / 2), w, h,
      });
      renderItems();
      saveSoon(true);
      setTool('sel');
      toast('图片已插入：切到「↖」可拖动、右下角改大小');
    } catch (e) {
      toast('插入失败：' + (e.message || e), true);
    }
  };

  /* 插入 PDF：每页转成图片追加成新的一页，可以直接在上面写；不影响已有页 */
  $('inkAddPdf').onclick = () => {
    if (!st.note || st.mode === 'md') return;
    $('inkFilePdf').value = '';
    $('inkFilePdf').click();
  };
  $('inkFilePdf').onchange = async () => {
    const f = $('inkFilePdf').files && $('inkFilePdf').files[0];
    if (!f) return;
    const lib = window.pdfjsLib;
    if (!lib) { toast('pdf.js 还没加载好（需要联网一次）', true); return; }
    toast('正在导入 PDF…');
    try {
      const buf = await f.arrayBuffer();
      const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      await saveNow();
      const id = st.note.id;
      const base = st.pages.length;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1600 / vp0.width);
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const url = c.toDataURL('image/jpeg', 0.82);
        /* 每页按自己的宽高比设画布：A4 纵向就竖着放，塞进默认的横向页会被裁掉两头 */
        const pw = PAGE_W;
        const ph = Math.round(PAGE_W * (vp.height / Math.max(1, vp.width)));
        const pg = { no: base + i - 1, template: 'blank', strokes: [], items: [], bg: url, pw, ph };
        st.pages.push(pg);
        await store.putPage({
          id: `${id}#${pg.no}`, noteId: id, no: pg.no,
          template: 'blank', strokes: [], items: [], bg: url, pw, ph,
        });
      }
      st.note.pageCount = st.pages.length;
      st.note.updatedAt = Date.now();
      await store.putNote({ ...st.note });
      loadPage(base);
      renderLib();
      toast(`已插入 ${pdf.numPages} 页 PDF，可以直接在上面写`);
    } catch (e) {
      toast('PDF 导入失败：' + (e.message || e), true);
    }
  };

  /* 选择工具下点空白取消选中；Delete / Backspace 删掉选中的元素 */
  $('inkStage').addEventListener('pointerdown', (e) => {
    if (st.tool === 'sel' && !e.target.closest('.it') && sel.size) {
      sel.clear();
      closeBar();
      renderItems();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (!st.note || st.mode === 'md' || st.tool !== 'sel' || !sel.size) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSelected();
    }
  });

  /* ---------- 保存 ---------- */
  function saveSoon(force) {
    clearTimeout(st.saveT);
    st.saveT = setTimeout(() => saveNow(), force ? 120 : 700);
  }

  /** quick=true：只写页面和元数据、跳过缩略图与重绘列表——切后台 / 转屏时用，越快落盘越好 */
  async function saveNow(quick) {
    if (!st.note) return;
    /* 这里**不要** commitLine：预览阶段每写一笔都会存一次，一 commit 就等于「每笔都定稿」，
       一个字会被拆成好几块（「停一下再写下一笔就变成好几个字」的根因就在这里）。
       隐藏的墨迹已经从 getStrokes() 里剔掉，重开不会出现「墨迹 + 文字」重影。 */
    if (st.mode === 'md') {
      st.note.title = titleEl.value.trim() || '未命名笔记';
      st.note.md = st.md || '';
      /* 手写批注跟着文字笔记一起存 */
      st.note.mdInk = mdInk.serialize();
      /* 不要存 mdInk.on：那只是 UI 上的临时开关（进编辑模式会临时关掉），
         存下来会变成「下次打开永远写不了」。 */
      st.note.pageCount = 1;
      st.note.updatedAt = Date.now();
      await store.putNote({ ...st.note });
      localStorage.setItem(LS_LAST, st.note.id);
      localStorage.setItem(LS_LAST_AT, String(Date.now()));
      if (!quick) renderLib();
      return;
    }
    if (!st.pages.length) return;
    const idx = (P.on && P.act === 1) ? P.i2 : st.idx;
    const page = st.pages[idx];
    page.strokes = board.getStrokes();
    page.template = board.template;
    if (P.on && P.b2) {
      /* 双栏：另一栏那一页也一起存（不然切回来发现刚写的没了） */
      const other = (P.act === 1) ? st.idx : P.i2;
      const ob = (P.act === 1) ? boardA : P.b2;
      const p2 = st.pages[other];
      if (p2 && ob) {
        p2.strokes = ob.getStrokes();
        p2.template = ob.template;
        await store.putPage({
          id: st.note.id + '#' + p2.no,
          noteId: st.note.id,
          no: p2.no,
          template: p2.template,
          strokes: p2.strokes,
          items: p2.items || [],
          bg: p2.bg || null,
        });
      }
    }
    await store.putPage({
      id: `${st.note.id}#${page.no}`,
      noteId: st.note.id,
      no: page.no,
      template: page.template,
      strokes: page.strokes,
      items: page.items || [],
      bg: page.bg || null,
    });
    st.note.pageCount = st.pages.length;
    st.note.updatedAt = Date.now();
    st.note.title = titleEl.value.trim() || '未命名笔记';
    if (!quick) st.note.thumb = await board.thumb(320);
    await store.putNote({ ...st.note });
    localStorage.setItem(LS_LAST, st.note.id);
    localStorage.setItem(LS_LAST_AT, String(Date.now()));
    if (!quick) renderLib();
  }

  /* 安卓壳：转屏 / 切后台 / 被系统回收都会重建 WebView，这里不等 700ms 防抖，直接落盘 */
  function flushSave() {
    if (!st.note) return;
    if (st.mode === 'md') { clearTimeout(st.saveT); saveNow(true); return; }
    if (!st.pages.length) return;
    clearTimeout(st.saveT);
    saveNow(true);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('pagehide', flushSave);

  /* ---------- 页面 ---------- */
  function loadPage(i) {
    if (P.on && P.act === 1) {
      if (!P.b2) return;
      P.i2 = Math.max(0, Math.min(st.pages.length - 1, i));
      const p2 = st.pages[P.i2] || { template: 'blank', strokes: [], items: [], bg: null };
      P.b2.loadPage({ template: p2.template, bg: p2.bg, strokes: p2.strokes || [], items: p2.items || [] });
      syncInfo();
      return;
    }
    return loadPage1(i);
  }

  function loadPage1(i) {
    if (!st.pages.length) return;
    st.idx = Math.max(0, Math.min(st.pages.length - 1, i));
    const p = st.pages[st.idx];
    if (!p) return;
    if (!Array.isArray(p.items)) p.items = [];
    sel.clear();
    activeTextId = null;      /* 换页了，手写文字重新找个框 */
    try { commitLine(true, true); } catch (e) { /* 初始化早期还没定义 */ }
    lastPara = null;
    pendingTex.clear();
    clearTimeout(texTimer);
    try { clearLasso(); } catch (e) { /* 初始化早期还没定义 */ }
    board.setPageSize(p.pw || PAGE_W, p.ph || PAGE_H);
    board.loadPage({ template: p.template, bg: p.bg, strokes: p.strokes, items: p.items });
    renderItems();
    tplSel.value = p.template || 'blank';
    pageInfo.textContent = `第 ${st.idx + 1} / ${st.pages.length} 页`;
  }

  /* ---------- 连续滚动：整本纵向排列，点哪页回哪页写 ----------
     每页导出一张「底图 + 笔迹 + 文字」的快照，纵向排开 —— 翻页从「点按钮」
     变成「往下滑」，长文档 / 试卷一眼看到底。点某页就切回那一页正常书写。 */
  let scrollOn = false;
  let scrollBusy = false;
  let scrollZoom0 = 1;      /* 进滚动前编辑视图的缩放，退出时还回去 */

  function applyScrollZoom() {
    const wrap = $('inkScroll');
    if (!scrollOn || wrap.hidden) return;
    const cw = Math.max(240, wrap.clientWidth - 28);
    const w = Math.round(cw * Math.max(0.4, Math.min(1.6, board.zoom || 1)));
    wrap.querySelectorAll('.pg').forEach((d) => { d.style.width = w + 'px'; });
  }

  function closeScroll() {
    if (!scrollOn) return;
    scrollOn = false;
    const wrap = $('inkScroll');
    wrap.hidden = true;
    wrap.innerHTML = '';
    $('inkStage').hidden = false;
    $('inkScrollToggle').classList.remove('on');
    board.setZoom(scrollZoom0);
    board.layout();
  }

  async function openScroll() {
    if (!st.note || st.mode === 'md' || !st.pages.length || scrollBusy) return;
    scrollBusy = true;
    const wrap = $('inkScroll');
    const cur = st.idx;
    try {
      await saveNow();                 /* 当前页的改动先落进 st.pages，导出才是最新的 */
      const keepUndo = board.undoStack.slice();
      scrollZoom0 = board.zoom || 1;
      board.zoom = 1;                  /* 滚动视图先按「适应宽度」排，想看大再按 + */
      wrap.hidden = false;
      wrap.innerHTML = '<div class="tip">正在生成页面预览…</div>';
      $('inkStage').hidden = true;
      $('inkScrollToggle').classList.add('on');
      scrollOn = true;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < st.pages.length; i++) {
        const p = st.pages[i];
        board.setPageSize(p.pw || PAGE_W, p.ph || PAGE_H);
        board.loadPage({ template: p.template, bg: p.bg, strokes: p.strokes, items: p.items });
        const url = await board.exportPng(1.3);
        const d = document.createElement('div');
        d.className = 'pg' + (i === cur ? ' on' : '');
        d.innerHTML = `<img src="${url}" alt="第 ${p.no + 1} 页"><span class="no">${p.no + 1} / ${st.pages.length}</span>`;
        d.onclick = () => { closeScroll(); loadPage(i); };
        frag.appendChild(d);
      }
      wrap.innerHTML = '';
      wrap.appendChild(frag);
      /* 导出时在 board 上换来换去，恢复当前页 */
      const cp = st.pages[cur];
      board.setPageSize(cp.pw || PAGE_W, cp.ph || PAGE_H);
      board.loadPage({ template: cp.template, bg: cp.bg, strokes: cp.strokes, items: cp.items });
      board.undoStack = keepUndo;      /* 只是看了下整本，撤销历史别丢 */
      renderItems();
      applyScrollZoom();
      const on = wrap.querySelector('.pg.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'start' });
    } catch (e) {
      toast('生成预览失败：' + (e && e.message ? e.message : e), true);
      closeScroll();
    } finally {
      scrollBusy = false;
    }
  }

  $('inkScrollToggle').onclick = () => { if (scrollOn) closeScroll(); else openScroll(); };

  function curIdx() { return (P.on && P.act === 1) ? P.i2 : st.idx; }

  /* 双栏：元素层 / 选中层只有一个实例，切栏时把它们搬到活动栏的纸面上，
     这样「圈选 → 转文字」和插入的图片/文字都作用在用户正在看的那一页。 */
  function adoptLayers() {
    const right = P.on && P.act === 1 && P.paper2;
    const paper = right ? P.paper2 : paperA;
    const cv = right ? P.cv2 : cvA;
    if (!paper || !cv) return;
    if (layerBelow.parentNode !== paper) paper.insertBefore(layerBelow, cv);
    if (layerAbove.parentNode !== paper) paper.insertBefore(layerAbove, cv.nextSibling);
    const sl = $('inkSelLayer');
    if (sl && sl.parentNode !== paper) paper.appendChild(sl);
    const k = (paper.clientWidth || PAGE_W) / PAGE_W;
    layerBelow.style.transform = `scale(${k})`;
    layerAbove.style.transform = `scale(${k})`;
    if (sl) sl.style.transform = `scale(${k})`;
  }
  // 双栏：点哪一栏哪一栏就是活动栏
  function onPaneDown(k) {
    if (!P.on) return;
    P.act = k;
    board = (k === 1 && P.b2) ? P.b2 : boardA;
    boardA.stage.classList.toggle('pane-act', k === 0);
    if (P.stage2) P.stage2.classList.toggle('pane-act', k === 1);
    board.tool = st.tool;
    board.color = st.color;
    board.size = st.size;
    adoptLayers();
    try { renderItems(); } catch (e) { /* 早期还没定义 */ }
    syncInfo();
  }
  function syncInfo() {
    if (!P.on) pageInfo.textContent = `第 ${st.idx + 1} / ${st.pages.length} 页`;
    else pageInfo.textContent = `左 ${st.idx + 1} · 右 ${P.i2 + 1} / ${st.pages.length}`;
  }
  function splitOn() {
    if (P.on || !st.note) return;
    const ed = $('inkStage');
    const host = ed.parentNode;
    const wrap = document.createElement('div');
    wrap.className = 'split-wrap';
    host.insertBefore(wrap, ed);
    wrap.appendChild(ed);
    const s2 = ed.cloneNode(true);
    s2.id = 'inkStage2';
    s2.className = 'stage';
    const cv2 = s2.querySelector('canvas');
    const paper2 = cv2 ? cv2.parentNode : null;
    const spot = function (node) { return node; };
    /* 清掉重复 id，免得 $() 取到右栏 */
    [s2, paper2, cv2].forEach(function (el) { if (el) el.removeAttribute('id'); });
    s2.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
    wrap.appendChild(s2);
    P.stage2 = s2;
    P.on = true;
    P.wrap = wrap;
    P.b2 = new InkBoard(cv2, paper2, s2);
    P.paper2 = paper2;
    P.cv2 = cv2;
    P.b2.tool = st.tool; P.b2.color = st.color; P.b2.size = st.size;
    P.b2.zoom = boardA.zoom;
    P.i2 = (st.idx + 1 < st.pages.length) ? (st.idx + 1)
      : Math.max(0, Math.min(st.pages.length - 1, st.idx - 1 !== st.idx ? st.idx - 1 : st.idx));
    if (st.pages.length > 1 && P.i2 === st.idx) P.i2 = (st.idx === 0) ? 1 : st.idx - 1;
    board = P.b2;
    P.act = 1;
    s2.classList.add('pane-act');
    boardA.stage.classList.remove('pane-act');
    s2.addEventListener('pointerdown', () => onPaneDown(1), true);
    if (!P.bound) {
      boardA.stage.addEventListener('pointerdown', () => onPaneDown(0), true);
      P.bound = true;
    }
    loadPage(P.i2);
    adoptLayers();
    if (typeof toast === 'function') toast('双栏：左边第 ' + (st.idx + 1) + ' 页，右边第 ' + (P.i2 + 1) + ' 页；点哪栏画哪栏');
  }
  function splitOff() {
    if (!P.on) return;
    try { saveNow(); } catch (e) { /* 关栏时存不上不影响退出 */ }
    const ed = $('inkStage');
    const wrap = P.wrap;
    if (wrap && wrap.parentNode) {
      wrap.parentNode.insertBefore(ed, wrap);
      wrap.remove();
    }
    P.on = false;
    P.act = 0;
    P.b2 = null;
    P.stage2 = null;
    P.wrap = null;
    board = boardA;
    boardA.stage.classList.remove('pane-act');
    /* 顺序要紧：先把元素层/选中层搬回左栏，再切页。
       切页可能因为没有页而抛错，搬层不能跟着一起跳过（否则图层留在被删掉的 wrap 里，页面就空了）。 */
    try { adoptLayers(); } catch (e) { /* 搬层失败不影响退出双栏 */ }
    try { if (st.pages.length) loadPage(st.idx); } catch (e2) { /* 没有页就不切 */ }
  }
  const splitBtn = $('inkSplit');
  if (splitBtn) splitBtn.onclick = () => { if (P.on) splitOff(); else splitOn(); };

  $('inkPrev').onclick = () => { const i = curIdx(); if (i > 0) { saveNow(); loadPage(i - 1); } };
  $('inkNext').onclick = () => { const i = curIdx(); if (i < st.pages.length - 1) { saveNow(); loadPage(i + 1); } };
  $('inkAddPage').onclick = async () => {
    await saveNow();
    st.pages.push({ no: st.pages.length, template: 'blank', strokes: [], items: [], bg: null });
    loadPage(st.pages.length - 1);
    saveSoon(true);
  };

  /* ---------- 打开 / 新建 / 删除 ---------- */
  /* 来源行：从 PDF / 图片批注、拍题存下来的笔记显示一行「来源：…」，点它回对应标签页 */
  function renderSrc(src) {
    if (!src || !src.kind) { srcBar.hidden = true; srcBar.innerHTML = ''; return; }
    const label = src.kind === 'shot' ? '拍题' : (src.name || '未命名');
    srcBar.innerHTML = `来源：<span class="nm" title="${escapeHtml(srcFull(src))}">${srcIcon(src)} ${escapeHtml(label)}</span>`
      + (src.page ? `（第 ${src.page} 页）` : '')
      + `<button id="inkSrcGo">${src.kind === 'pdf' ? '回到 PDF 批注' : src.kind === 'img' ? '回到图片批注' : '回到拍题'}</button>`;
    srcBar.hidden = false;
    srcBar.querySelector('#inkSrcGo').onclick = () => {
      const tab = document.querySelector(`.tab[data-tab="${src.kind === 'shot' ? 'shot' : 'annot'}"]`);
      if (tab) tab.click();
    };
  }

  /* ---------- 文字笔记（markdown） ---------- */
  /* 文档上的手写批注层。
     文档是流式排版（高度随内容变），所以笔迹存「文档坐标」；
     canvas 只盖住可视区域，滚动时跟着走，重绘时整体上移 scrollTop。
     只认笔（pointerType==='pen'），手指不拦 —— 这样一只手写、一只手滑动翻页。 */
  class MdInk {
    constructor(body, cv) {
      this.body = body;
      this.cv = cv;
      this.ctx = cv.getContext('2d');
      this.strokes = [];
      this.undoStack = [];
      this.tool = 'pen';                 /* 'pen' | 'er' */
      this.color = '#c0392b';            /* 批注默认红笔，跟正文区分 */
      this.size = 2.2;
      this.on = false;
      this._st = null;
      this.z = 1;                        /* 文档当前的缩放比例（跟着 md-view 的 zoom 走） */
      this.onChange = null;
      this.bind();
      try { new ResizeObserver(() => this.draw()).observe(body); } catch (e) { /* 老内核 */ }
    }

    /* 这支笔算不算「笔」。
       坑：华为 M-Pencil 在安卓 WebView 里上报的 pointerType 是 'touch'
       （不是 'pen'），但压力值是真实的（实测 3.2）；手指的压力只有 0 或 1。
       只认 pointerType==='pen' 会导致笔被当成手指 → 只会滚动、写不了字。 */
    _isPen(e) {
      if (e.pointerType === 'pen') return true;
      const p = Number(e.pressure) || 0;
      if (p > 1.05) return true;
      return false;
    }

    /* 视口坐标 → 文档坐标。
       canvas 只盖住可视区，文档被 zoom 放大、还能左右上下滚，
       所以要先加回滚动量，再除以缩放比例，换算到「未缩放的文档坐标」。 */
    _pt(e) {
      const r = this.cv.getBoundingClientRect();
      const z = this.z || 1;
      return [(e.clientX - r.left + this.body.scrollLeft) / z,
              (e.clientY - r.top + this.body.scrollTop) / z];
    }

    load(data) {
      const list = data && Array.isArray(data.strokes) ? data.strokes : [];
      this.strokes = list.filter((s) => s && Array.isArray(s.pts) && s.pts.length >= 2);
      this.undoStack.length = 0;
      this.draw();
    }

    serialize() { return { v: 1, strokes: this.strokes }; }

    setOn(on) {
      this.on = !!on;
      const stage = this.body.closest('.md-stage') || this.body;
      stage.classList.toggle('pen', this.on);
      this.draw();
    }

    setTool(t) { this.tool = t; }

    undo() {
      if (!this.undoStack.length) return false;
      this.strokes = this.undoStack.pop();
      this.draw();
      this._changed();
      return true;
    }

    clear() {
      if (!this.strokes.length) return false;
      this.undoStack.push(this.strokes.slice());
      this.strokes = [];
      this.draw();
      this._changed();
      return true;
    }

    _changed() { if (this.onChange) this.onChange(); }

    _paint(s) {
      const ctx = this.ctx;
      const pts = s.pts;
      const n = Math.floor(pts.length / 3);
      if (!n) return;
      ctx.strokeStyle = s.c || '#c0392b';
      ctx.fillStyle = ctx.strokeStyle;
      /* 画布整体按缩放比例放大了，线宽除回去 —— 笔迹视觉粗细不跟着变 */
      ctx.lineWidth = Math.max(0.4, (s.w || 2) / (this.z || 1));
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (n === 1 || (n === 2 && Math.hypot(pts[3] - pts[0], pts[4] - pts[1]) < 1)) {
        ctx.beginPath();
        ctx.arc(pts[0], pts[1], ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      if (n === 2) {
        ctx.lineTo(pts[3], pts[4]);
      } else {
        /* 二次曲线 + 中点平滑，跟画板一个口径 */
        for (let i = 3; i + 3 < pts.length; i += 3) {
          const xc = (pts[i] + pts[i + 3]) / 2;
          const yc = (pts[i + 1] + pts[i + 4]) / 2;
          ctx.quadraticCurveTo(pts[i], pts[i + 1], xc, yc);
        }
        ctx.lineTo(pts[pts.length - 3], pts[pts.length - 2]);
      }
      ctx.stroke();
    }

    draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, this.body.clientWidth);
      const h = Math.max(1, this.body.clientHeight);
      if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
        this.cv.width = Math.round(w * dpr);
        this.cv.height = Math.round(h * dpr);
      }
      const ctx = this.ctx;
      const z = this.z || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.cv.width, this.cv.height);
      ctx.setTransform(dpr * z, 0, 0, dpr * z,
        -this.body.scrollLeft * dpr, -this.body.scrollTop * dpr);
      for (const s of this.strokes) this._paint(s);
      if (this._st) this._paint(this._st);
    }

    /** 点到线段的距离：橡皮按「整笔删除」处理（跟画板一致） */
    _hit(s, x, y, tol) {
      const pts = s.pts;
      for (let i = 0; i + 4 < pts.length; i += 3) {
        const x1 = pts[i], y1 = pts[i + 1], x2 = pts[i + 3], y2 = pts[i + 4];
        const dx = x2 - x1, dy = y2 - y1;
        const L2 = dx * dx + dy * dy;
        let t = L2 ? ((x - x1) * dx + (y - y1) * dy) / L2 : 0;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) < tol) return true;
      }
      return false;
    }

    bind() {
      const cv = this.cv;
      /* 手指拖动 = 翻页滚动。canvas 盖在文档上，touch-action:none 会连手指滚动一起
         禁掉（这就是「放大以后拖不动」的原因），所以这里自己接管滚动。
         笔（pointerType==='pen'）才写字，手指一律只滚。 */
      let drag = null;
      const down = (e) => {
        if (!this.on) return;
        if (!this._isPen(e)) {
          if (this._st) return;
          if (drag && drag.id !== e.pointerId) { drag = null; return; }   /* 第二根手指：捏合缩放 */
          drag = { id: e.pointerId, x: e.clientX, y: e.clientY,
                   st: this.body.scrollTop, sl: this.body.scrollLeft, moved: false };
          try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件会抛 */ }
          return;
        }
        if (this._st) return;
        e.preventDefault();
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件会抛 */ }
        const [x, y] = this._pt(e);
        this._st = { t: this.tool, c: this.color, w: this.size, pts: [x, y, 0.5], pid: e.pointerId };
        this.draw();
      };
      const move = (e) => {
        if (drag && e.pointerId === drag.id) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
          this.body.scrollTop = drag.st - dy;
          this.body.scrollLeft = drag.sl - dx;
          this.draw();
          return;
        }
        if (!this._st || e.pointerId !== this._st.pid) return;
        e.preventDefault();
        const [x, y] = this._pt(e);
        const p = this._st.pts;
        if (Math.hypot(x - p[p.length - 3], y - p[p.length - 2]) < 0.8) return;
        p.push(x, y, typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5);
        this.draw();
      };
      const up = (e) => {
        if (drag && e.pointerId === drag.id) { drag = null; return; }
        if (!this._st || e.pointerId !== this._st.pid) return;
        const s = this._st;
        this._st = null;
        if (this.tool === 'er') {
          const before = this.strokes.length;
          const kept = this.strokes.filter((q) => !this._hit(q, s.pts[0], s.pts[1], Math.max(8, this.size * 3)));
          if (kept.length !== before) {
            this.undoStack.push(this.strokes.slice());
            this.strokes = kept;
            this._changed();
          }
        } else {
          this.undoStack.push(this.strokes.slice());
          this.strokes.push(s);
          this._changed();
        }
        this.draw();
      };
      cv.addEventListener('pointerdown', down);
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      /* canvas 放在滚动容器外面（不跟着内容滚），滚动只触发重绘 */
      this.body.addEventListener('scroll', () => this.draw(), { passive: true });
    }
  }

  const mdInk = new MdInk($('mdBody'), $('mdInk'));
  mdInk.onChange = () => {
    if (st.note) { st.note.mdInk = mdInk.serialize(); saveSoon(false); }
  };

  /* 文字笔记的「页面缩放」：整篇文档一起放大（字号、行距、标题、表格全都变），
     放大后可以上下左右拖着看 —— 跟看 PDF 一样。
     不再用改字号的办法：那样只有正文变大，页面和标题比例都乱。 */
  const MD_ZOOM_KEY = 'kynb_mdzoom';
  let mdZoom = 1;
  try {
    const v = Number(localStorage.getItem(MD_ZOOM_KEY));
    mdZoom = Math.max(0.6, Math.min(2.6, v || 1));
  } catch (e) { mdZoom = 1; }

  function applyMdZoom(keepCenter) {
    const body = $('mdBody');
    const oldH = body.scrollHeight || 1;
    const cy = (body.scrollTop + body.clientHeight / 2) / oldH;
    const cx = (body.scrollLeft + body.clientWidth / 2) / (body.scrollWidth || 1);
    $('inkMdView').style.zoom = mdZoom;
    mdInk.z = mdZoom;
    try { localStorage.setItem(MD_ZOOM_KEY, String(mdZoom)); } catch (e) { /* 无痕 */ }
    if (keepCenter) {
      /* 缩放前后尽量停在原来的位置（不然一跳就到别处去了） */
      requestAnimationFrame(() => {
        body.scrollTop = Math.max(0, cy * body.scrollHeight - body.clientHeight / 2);
        body.scrollLeft = Math.max(0, cx * body.scrollWidth - body.clientWidth / 2);
        mdInk.draw();
      });
    }
    paintMdZoom();
  }
  function paintMdZoom() {
    const pct = Math.round(mdZoom * 100);
    $('inkMdZoomVal').textContent = pct + '%';
    const zi = document.getElementById('inkZoomInfo');
    if (zi) zi.textContent = pct + '%';
    $('inkMdFontOut').disabled = mdZoom <= 0.6;
    $('inkMdFontIn').disabled = mdZoom >= 2.6;
    if (!st.mdEditing) $('inkMdInfo').textContent = `${(st.md || '').length} 字 · ${pct}%`;
  }
  function bumpMdZoom(d) {
    mdZoom = Math.max(0.6, Math.min(2.6, Math.round((mdZoom + d) * 100) / 100));
    applyMdZoom(true);
    mdInk.draw();
  }
  $('inkMdFontIn').onclick = () => bumpMdZoom(0.1);
  $('inkMdFontOut').onclick = () => bumpMdZoom(-0.1);
  $('inkMdZoomFit').onclick = () => { mdZoom = 1; applyMdZoom(true); mdInk.draw(); };
  /* 双指捏合缩放（笔写的时候不拦，手指两指才拦） */
  (function bindMdPinch() {
    const body = $('mdStage') || $('mdBody');   /* canvas 盖在 body 上，绑 body 收不到 */
    let d0 = 0, z0 = 1, pinching = false;
    body.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      const [a, b] = e.touches;
      d0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      z0 = mdZoom;
      pinching = true;
    }, { passive: true });
    body.addEventListener('touchmove', (e) => {
      if (!pinching || e.touches.length !== 2) return;
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      const z = Math.max(0.6, Math.min(2.6, Math.round(z0 * d / d0 * 100) / 100));
      if (z !== mdZoom) { mdZoom = z; applyMdZoom(true); }
    }, { passive: true });
    body.addEventListener('touchend', () => {
      if (!pinching) return;
      pinching = false;
      mdInk.draw();
    }, { passive: true });
  })();

  function paintMdPenBtn() {
    $('inkMdPen').classList.toggle('on', mdInk.on);
    $('inkMdPen').textContent = mdInk.on ? '✍ 批注：开' : '✍ 批注：关';
  }
  $('inkMdPen').onclick = () => {
    mdInk.setOn(!mdInk.on);
    st.mdInkOn = mdInk.on;
    paintMdPenBtn();
    toast(mdInk.on ? '批注已开：用笔直接在文档上写' : '批注已关：手指可以选中文字、复制');
  };
  $('inkMdErase').onclick = () => {
    const er = mdInk.tool !== 'er';
    mdInk.setTool(er ? 'er' : 'pen');
    $('inkMdErase').classList.toggle('on', er);
    toast(er ? '橡皮：点一下要删的那一笔' : '回到红笔');
  };
  $('inkMdUndo').onclick = () => { if (!mdInk.undo()) toast('没有可撤销的笔迹'); };
  $('inkMdClear').onclick = () => {
    if (!mdInk.strokes.length) { toast('这一篇还没有手写笔迹'); return; }
    if (!confirm('清空这一篇上的手写笔迹？文字不受影响。')) return;
    mdInk.clear();
  };

  /* 导入 .md / .txt：进来就是「排好版的文档 + 可以手写」的状态，
     不是丢进一个源码框里让用户自己对着改 */
  $('inkImportMd').onclick = () => { $('inkImportMdFile').value = ''; $('inkImportMdFile').click(); };
  $('inkImportMdFile').onchange = async () => {
    const f = $('inkImportMdFile').files && $('inkImportMdFile').files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const title = f.name.replace(/\.[^.]+$/, '') || '导入的文档';
      await addMdNote(title, text);
      toast(`已导入「${title}」：文档保持排版，直接用笔在上面写就行`);
    } catch (e) {
      toast('导入失败：' + (e && e.message ? e.message : e), true);
    }
  };


  function setMdEditing(on) {
    st.mdEditing = !!on;
    $('inkMdSrc').hidden = !on;
    $('inkMdEdit').hidden = !!on;
    $('inkMdSave').hidden = !on;
    $('inkMdCancel').hidden = !on;
    $('inkMdInfo').hidden = !!on;
    /* 编辑时**不丢掉渲染**：上面继续显示排好版的文档，下面才是源码。
       以前一进编辑就把渲染视图 hidden，看起来像「文档没了」，很难对着改 */
    $('inkMd').classList.toggle('editing', !!on);
    if (on) {
      mdInk.setOn(false);
      paintMdPenBtn();
      $('inkMdSrc').value = st.md;
      $('inkMdSrc').scrollTop = 0;
      $('inkMdSrc').setSelectionRange(0, 0);
      $('inkMdSrc').focus();
    } else {
      mdInk.setOn(true);
      st.mdInkOn = true;
      paintMdPenBtn();
      mdInk.draw();
    }
  }

  async function openMdNote(n) {
    if (scrollOn) closeScroll();
    st.mode = 'md';
    st.md = n.md || '';
    st.pages = [];
    st.note = n;
    titleEl.value = n.title || '未命名笔记';
    starBtn.textContent = n.star ? '★' : '☆';
    starBtn.style.color = n.star ? '#c9a227' : '';
    edEl.hidden = false;
    libEl.parentElement.style.display = 'none';
    const view = libEl.closest('.view');
    if (view) view.classList.add('editing');
    $('inkTools').hidden = true;
    $('inkStage').hidden = true;
    $('inkMd').hidden = false;
    hwr.show(false);
    $('inkToMap').hidden = false;
    $('inkExportPng').hidden = true;
    pageInfo.textContent = '文字笔记';
    setMdEditing(false);
    /* 批注默认开着：以前从 note.mdInkOn 读，一旦被存成 false 就再也写不了 */
    st.mdInkOn = true;
    mdInk.load(n.mdInk || null);
    mdInk.setOn(true);
    paintMdPenBtn();
    await mdInto($('inkMdView'), st.md);
    mdInk.draw();
    applyMdZoom(false);
    $('inkMdInfo').textContent = `${(st.md || '').length} 字`;
    renderSrc(n.src || null);
  }

  $('inkMdEdit').onclick = () => setMdEditing(true);
  $('inkMdCancel').onclick = () => setMdEditing(false);
  $('inkMdSave').onclick = async () => {
    st.md = $('inkMdSrc').value;
    setMdEditing(false);
    $('inkMdInfo').textContent = `${st.md.length} 字`;
    await mdInto($('inkMdView'), st.md);
    await saveNow();
    renderLib();
    toast('已保存');
  };

  async function openNote(id) {
    if (scrollOn) closeScroll();
    if (P.on) splitOff();
    const n = await store.getNote(id);
    if (!n) return;
    if (n.kind === 'md') { await openMdNote(n); localStorage.setItem(LS_LAST, id); return; }
    const pages = await store.pagesOf(id);
    st.note = n;
    st.mode = 'ink';
    st.md = '';
    $('inkTools').hidden = false;
    $('inkStage').hidden = false;
    $('inkMd').hidden = true;
    $('inkExportPng').hidden = false;
    $('inkToMap').hidden = !n.src;
    st.pages = pages.length ? pages.map((p) => ({
      no: p.no, template: p.template || 'blank', strokes: p.strokes || [],
      items: Array.isArray(p.items) ? p.items : [],   /* 重开笔记要带上插入的图片/文字 */
      bg: p.bg || null,
      pw: p.pw || 0, ph: p.ph || 0,                   /* 每页自己的版式（PDF 页可能是纵向） */
    })) : [{ no: 0, template: 'blank', strokes: [], items: [], bg: null }];
    st.pages.sort((a, b) => a.no - b.no);
    st.idx = 0;
    titleEl.value = n.title || '未命名笔记';
    starBtn.textContent = n.star ? '★' : '☆';
    starBtn.style.color = n.star ? '#c9a227' : '';
    edEl.hidden = false;
    libEl.parentElement.style.display = 'none';
    const view = libEl.closest('.view-ink') || libEl.closest('.view');
    if (view) view.classList.add('editing');
    tplSel.value = st.pages[0].template;
    renderSrc(n.src || null);
    loadPage(0);
    requestAnimationFrame(() => board.layout());
    const z = Number(localStorage.getItem(ZOOM_KEY) || 1);
    if (z && z !== board.zoom) board.setZoom(z);
    paintZoom();
    localStorage.setItem(LS_LAST, id);
  }

  async function closeNote() {
    if (P.on) splitOff();
    /* 先等这一页存完再清状态：saveNow 后半段还要写 note.thumb / updatedAt */
    const opened = st.note;
    await saveNow();
    /* 等保存的这段时间里用户又点开了笔记：别把它的状态清掉（否则 pages 会被清空） */
    if (st.note !== opened) return;
    st.note = null;
    st.pages = [];
    st.mode = 'ink';
    st.md = '';
    activeTextId = null;
    lastPara = null;
    closeBar();
    try { hideCandBar(); } catch (e) { /* 还没定义 */ }
    hwr.show(false);
    $('inkMd').hidden = true;
    $('inkTools').hidden = false;
    $('inkStage').hidden = false;
    $('inkToMap').hidden = true;
    edEl.hidden = true;
    renderSrc(null);
    libEl.parentElement.style.display = '';
    const view = libEl.closest('.view-ink') || libEl.closest('.view');
    if (view) view.classList.remove('editing');
    renderLib();
  }

  async function newNote(withBg) {
    const id = uid('note');
    const note = {
      id, title: '未命名笔记', kind: 'ink', star: 0,
      createdAt: Date.now(), updatedAt: Date.now(), pageCount: 1, thumb: '',
    };
    await store.putNote(note);
    await store.putPage({ id: `${id}#0`, noteId: id, no: 0, template: 'blank', strokes: [], items: [], bg: withBg || null });
    await openNote(id);
  }

  $('inkBack').onclick = () => closeNote();
  $('inkNew').onclick = () => newNote();

  titleEl.oninput = () => { if (st.note) { st.note.title = titleEl.value; saveSoon(false); } };

  starBtn.onclick = async () => {
    if (!st.note) return;
    st.note.star = st.note.star ? 0 : 1;
    starBtn.textContent = st.note.star ? '★' : '☆';
    starBtn.style.color = st.note.star ? '#c9a227' : '';
    await saveNow();
  };

  $('inkDel').onclick = async () => {
    if (!st.note) return;
    if (!confirm(`删除「${st.note.title || '未命名笔记'}」？删除后不可恢复。`)) return;
    await store.delNote(st.note.id);
    st.note = null;
    st.pages = [];
    closeNote();
  };

  $('inkExportPng').onclick = async () => {
    if (st.mode === 'md') { toast('文字笔记没有画布，用「→ 导图」或导出 JSON 保存内容', true); return; }
    const url = await board.exportPng(2);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(st.note && st.note.title) || 'note'}-p${st.idx + 1}.png`;
    a.click();
  };

  /* ---------- 导出 JSON（可选带底图） ---------- */
  const expDlg = $('dlgExportJson');
  const expBg = $('expWithBg');

  $('inkExportJson').onclick = () => {
    if (!st.note) return;
    expDlg.returnValue = '';
    expDlg.showModal();
  };

  expDlg.addEventListener('close', async () => {
    if (expDlg.returnValue !== 'go' || !st.note) return;
    const withBg = !!expBg.checked;
    await saveNow();
    const note = await store.getNote(st.note.id);
    const pages = [];
    let bgN = 0;
    for (const p of (st.mode === 'md' ? [] : st.pages)) {
      let bg = false;
      if (withBg && p.bg) { bg = await shrinkBgDataUrl(p.bg); bgN++; }
      pages.push({ no: p.no, template: p.template, bg, strokes: p.strokes });
    }
    const data = buildNoteJson(note || st.note, pages);   /* 带 v / exportedAt / src，导入靠它判断版本 */
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(note && note.title) || 'note'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(withBg ? `已导出 JSON（含 ${bgN} 页底图）` : '已导出 JSON（不含底图）');
  });

  /* ---------- 导入 JSON：选文件 → 校验 → 新建一本笔记（不动已有笔记） ---------- */
  const importFile = $('inkImportFile');
  $('inkImportJson').onclick = () => { importFile.value = ''; importFile.click(); };

  importFile.onchange = async () => {
    const f = importFile.files && importFile.files[0];
    if (!f) return;
    let text;
    try {
      text = await f.text();
    } catch (e) {
      toast('读取文件失败：' + (e.message || e), true);
      return;
    }
    const r = parseNoteJson(text);
    if (!r.ok) { toast('导入失败：' + r.error, true); return; }

    const id = uid('note');
    const fallback = f.name.replace(/\.json$/i, '').trim() || '导入的笔记';

    if (r.kind === 'md') {
      const doc = {
        id, title: r.title || fallback, kind: 'md', md: r.md, star: r.star,
        createdAt: r.createdAt, updatedAt: Date.now(), pageCount: 1, thumb: '',
      };
      if (r.src) doc.src = r.src;
      try {
        await store.putNote(doc);
      } catch (e) {
        toast('写入失败：' + (e.message || e), true);
        return;
      }
      await renderLib();
      toast(`已导入文字笔记「${doc.title}」`);
      return;
    }

    const note = {
      id, title: r.title || fallback, kind: 'ink', star: r.star,
      createdAt: r.createdAt, updatedAt: Date.now(), pageCount: r.pages.length, thumb: '',
    };
    if (r.src) note.src = r.src;
    let bgN = 0;
    try {
      await store.putNote(note);
      for (const p of r.pages) {
        if (p.bg) bgN++;
        await store.putPage({
          id: `${id}#${p.no}`, noteId: id, no: p.no,
          template: p.template, strokes: p.strokes, bg: p.bg || null,
        });
      }
    } catch (e) {
      /* 写了一半失败：把这本刚建的删掉，别留半成品；已有笔记不受影响 */
      await store.delNote(id).catch(() => {});
      toast('写入失败：' + (e.message || e), true);
      return;
    }
    await renderLib();
    toast(`已导入「${note.title}」：${note.pageCount} 页` + (bgN ? ` · 已恢复 ${bgN} 页底图` : ''));
  };

  /* ---------- 笔记库（按分组） ---------- */
  const FOLD_KEY = 'kynb_lib_fold';

  function foldedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch (e) { return new Set(); }
  }
  function saveFold(set) {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...set])); } catch (e) { /* 无痕模式就算了 */ }
  }

  /* 起名 / 改名：用对话框而不是 prompt()，无头测试和手机上都更稳 */
  function askName(title, value) {
    return new Promise((resolve) => {
      const dlg = $('dlgName');
      $('nameTitle').textContent = title;
      $('nameInput').value = value || '';
      const done = () => {
        dlg.removeEventListener('close', done);
        resolve(dlg.returnValue === 'ok' ? $('nameInput').value.trim() : null);
      };
      dlg.addEventListener('close', done);
      dlg.showModal();
      setTimeout(() => $('nameInput').select(), 30);
    });
  }

  async function moveNote(noteId, groupId) {
    const n = await store.getNote(noteId);
    if (!n) return;
    if (groupId) n.groupId = groupId; else delete n.groupId;
    await store.putNote(n);
    await renderLib();
    toast(groupId ? '已移到分组' : '已移出分组');
  }

  async function removeGroup(id, name) {
    const list = await store.allNotes();
    const inside = list.filter((x) => x.groupId === id);
    if (!confirm(`删除分组「${name}」？` + (inside.length
      ? `里面的 ${inside.length} 本笔记会回到「未分组」，不会被删掉。` : ''))) return;
    for (const x of inside) {
      delete x.groupId;
      await store.putNote(x);
    }
    await store.delGroup(id);
    await renderLib();
    toast(`已删除分组「${name}」` + (inside.length ? `，${inside.length} 本回到未分组` : ''));
  }

  function openMove(n, groups) {
    const dlg = $('dlgMove');
    $('moveWho').textContent = `「${n.title || '未命名笔记'}」`;
    const box = $('moveList');
    box.innerHTML = '';
    const add = (gid, name) => {
      const cur = (n.groupId || '') === gid;
      const b = document.createElement('button');
      b.className = 'btn' + (cur ? ' primary' : '');
      b.type = 'button';
      b.textContent = (cur ? '✓ ' : '') + name;
      b.onclick = async () => { dlg.close(); await moveNote(n.id, gid); };
      box.appendChild(b);
    };
    add('', '不分组');
    groups.forEach((g) => add(g.id, g.name));
    dlg.showModal();
  }

  function cardEl(n, groups) {
    const c = document.createElement('div');
    c.className = 'card';
    c.draggable = true;
    c.dataset.id = n.id;
    const isDoc = n.kind === 'md';
    c.innerHTML = `
        <div class="thumb${isDoc ? ' doc' : ''}" style="${n.thumb ? `background-image:url('${n.thumb}')` : ''}">${isDoc ? '📝' : ''}</div>
        <div class="meta">
          <div class="name">${escapeHtml(n.title || '未命名笔记')}</div>
          <div class="sub">${isDoc ? '文字笔记' : (n.pageCount || 1) + ' 页'} · ${fmtTime(n.updatedAt)}</div>
        </div>
        ${n.src && n.src.kind ? `<div class="src" title="${escapeHtml(srcFull(n.src))}">${escapeHtml(srcBadge(n.src))}</div>` : ''}
        ${n.star ? '<div class="star">★</div>' : ''}
        <button class="mv" title="移动到分组">📁</button>
        <button class="x" title="删除">✕</button>`;
    c.onclick = (e) => {
      if (e.target.closest('button')) return;
      openNote(n.id);
    };
    c.querySelector('.x').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`删除「${n.title || '未命名笔记'}」？`)) return;
      await store.delNote(n.id);
      renderLib();
    };
    c.querySelector('.mv').onclick = (e) => {
      e.stopPropagation();
      openMove(n, groups);
    };
    c.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', n.id);
      e.dataTransfer.effectAllowed = 'move';
      c.classList.add('dragging');
    });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
    return c;
  }

  function groupHead(g, isLoose) {
    const key = isLoose ? '@loose' : g.id;
    const fold = foldedSet();
    const open = !fold.has(key);
    const d = document.createElement('div');
    d.className = 'grp';
    d.dataset.gid = isLoose ? '' : g.id;
    d.innerHTML = `
        <span class="car">${open ? '▾' : '▸'}</span>
        <span class="nm" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
        <span class="cnt">${g.count}</span>
        <span class="acts">${isLoose ? '' : '<button data-act="ren" title="重命名">改名</button><button data-act="del" title="删除分组（不动笔记）">删除</button>'}</span>`;
    const toggle = () => {
      const s2 = foldedSet();
      if (s2.has(key)) s2.delete(key); else s2.add(key);
      saveFold(s2);
      renderLib();
    };
    d.querySelector('.car').onclick = toggle;
    d.querySelector('.nm').onclick = toggle;
    if (!isLoose) {
      d.querySelector('[data-act="ren"]').onclick = async (e) => {
        e.stopPropagation();
        const name = await askName('重命名分组', g.name);
        if (!name) return;
        await store.putGroup({ ...g, name });
        await renderLib();
      };
      d.querySelector('[data-act="del"]').onclick = (e) => {
        e.stopPropagation();
        removeGroup(g.id, g.name);
      };
    }
    d.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault();
      d.classList.add('drag');
    });
    d.addEventListener('dragleave', () => d.classList.remove('drag'));
    d.addEventListener('drop', (e) => {
      e.preventDefault();
      d.classList.remove('drag');
      const id = e.dataTransfer.getData('text/plain');
      if (id) moveNote(id, isLoose ? '' : g.id);
    });
    return d;
  }

  async function renderLib() {
    const [list, groups] = await Promise.all([store.allNotes(), store.allGroups()]);
    libEl.innerHTML = '';
    emptyEl.hidden = list.length > 0;
    const known = new Set(groups.map((g) => g.id));
    const loose = list.filter((n) => !n.groupId || !known.has(n.groupId));
    const fold = foldedSet();

    /* 一个分组都没有：保持原来的平铺，不打扰 */
    if (!groups.length) {
      loose.forEach((n) => libEl.appendChild(cardEl(n, groups)));
      return;
    }

    if (loose.length) {
      libEl.appendChild(groupHead({ id: '', name: '未分组', count: loose.length }, true));
      if (!fold.has('@loose')) loose.forEach((n) => libEl.appendChild(cardEl(n, groups)));
    }
    groups.forEach((g) => {
      const items = list.filter((n) => n.groupId === g.id);
      libEl.appendChild(groupHead({ ...g, count: items.length }, false));
      if (!fold.has(g.id)) items.forEach((n) => libEl.appendChild(cardEl(n, groups)));
    });
  }

  $('inkNewGroup').onclick = async () => {
    const name = await askName('新建分组', '');
    if (!name) return;
    const groups = await store.allGroups();
    await store.putGroup({ id: uid('g'), name, order: groups.length, createdAt: Date.now() });
    await renderLib();
    toast(`已建分组「${name}」：把笔记卡片拖到分组标题上，或点卡片右下角 📁`);
  };

  renderLib();

  /* 刚写过（10 分钟内）就自动回到那本：安卓转屏会重建 WebView，靠这个保持连续 */
  (function resumeLast() {
    const id = localStorage.getItem(LS_LAST);
    const at = Number(localStorage.getItem(LS_LAST_AT) || 0);
    if (!id || !at || Date.now() - at > 10 * 60 * 1000) return;
    store.getNote(id).then((n) => { if (n && !st.note) openNote(id); }).catch(() => {});
  })();

  /* 安卓返回键（原生会先问这里），一次退一层「看得见的」层：
     弹窗 → 关弹窗；不在笔记本标签 → 切回笔记本；编辑器 → 笔记库；都没有则返回 false 交给系统退出 */
  window.__kynbHandleBack = function handleBack() {
    const dlg = Array.prototype.find.call(document.querySelectorAll('dialog'), (d) => d.open);
    if (dlg) { dlg.close('cancel'); return true; }
    const on = document.querySelector('.tab.on');
    if (on && on.dataset.tab !== 'ink') {
      const ink = document.querySelector('.tab[data-tab="ink"]');
      if (ink) { ink.click(); return true; }
    }
    if (st.note) { closeNote(); return true; }
    return false;
  };

  /* 单独新建一本「一页底图」的笔记（导图页用：导图不该追加到上次打开的那本里） */
  async function addBgNote(dataUrl, title, src, strokes) {
    const from = src || { kind: 'shot', name: title || '拍题', page: 1 };
    const id = uid('note');
    const note = {
      id, title: title || '新笔记', kind: from.kind === 'shot' ? 'shot' : 'ink', star: 0, src: from,
      createdAt: Date.now(), updatedAt: Date.now(), pageCount: 1, thumb: '',
    };
    await store.putNote(note);
    await store.putPage({
      id: `${id}#0`, noteId: id, no: 0, template: 'blank',
      strokes: Array.isArray(strokes) ? strokes : [], bg: dataUrl,
    });
    await renderLib();
    await openNote(id);
    return id;
  }

  /* 新建一篇文字笔记（AI 生成的结果落到这里） */
  async function addMdNote(title, md, src) {
    const id = uid('note');
    const note = {
      id, title: title || 'AI 笔记', kind: 'md', md: String(md || ''), star: 0,
      createdAt: Date.now(), updatedAt: Date.now(), pageCount: 1, thumb: '',
    };
    if (src) note.src = src;
    await store.putNote(note);
    await renderLib();
    await openNote(id);
    return id;
  }

  /* 用这本笔记的文字生成导图：文字笔记用正文，手写笔记用来源 PDF 的那一页文字 */
  $('inkToMap').onclick = () => {
    const title = (titleEl.value || '').trim() || '思维导图';
    let text = '';
    if (st.mode === 'md') {
      text = st.md || '';
    } else if (st.note && st.note.src && typeof window.__kynbPageText === 'function') {
      text = window.__kynbPageText(st.note.src.name, st.note.src.page) || '';
    }
    if (window.__kynbMapFeed) window.__kynbMapFeed(text, title);
  };

  /* 拍题 / 批注页「存为笔记」：把一张底图存成一页，并记下来源 */
  async function addBgPage(dataUrl, title, src, strokes) {
    const from = src || { kind: 'shot', name: title || '拍题', page: 1 };
    const ink = Array.isArray(strokes) ? strokes : [];
    if (st.note) {
      await saveNow();
      st.pages.push({ no: st.pages.length, template: 'blank', strokes: ink, bg: dataUrl });
      if (!st.note.src) st.note.src = from;
      titleEl.value = titleEl.value || title;
      loadPage(st.pages.length - 1);
      saveSoon(true);
      return st.note.id;
    }
    const id = uid('note');
    const note = {
      id, title: title || '拍题笔记', kind: from.kind === 'shot' ? 'shot' : 'ink', star: 0, src: from,
      createdAt: Date.now(), updatedAt: Date.now(), pageCount: 1, thumb: '',
    };
    await store.putNote(note);
    await store.putPage({ id: `${id}#0`, noteId: id, no: 0, template: 'blank', strokes: ink, bg: dataUrl });
    await openNote(id);
    return id;
  }

  const api = { renderLib, newNote, openNote, get board() { return board; }, hwr, state: st, addBgPage, addBgNote, addMdNote, toast,
    renderItems, openHandPad, convertInk, setHwrMode, refreshFont, setHud: (on) => board.setHud(on),
    getLayout, setLayout, applyLayoutToPage, tidyPage, openFmt };
  noteApi = api;
  /* 上次开了延迟面板就继续开着（调试用，不影响写字） */
  try { if (localStorage.getItem('kynb_hud') === '1') board.setHud(true); } catch (e) { /* 无痕模式 */ }
  api.paneStrokes = () => ({
    act: P.act,
    on: P.on,
    a: boardA.getStrokes().length,
    b: P.b2 ? P.b2.getStrokes().length : -1,
    aIdx: st.idx,
    bIdx: P.i2,
    info: pageInfo.textContent,
  });
  return api;
}

const SRC_ICON = { pdf: '📄', img: '🖼', shot: '📷', map: '🧠' };
const srcIcon = (s) => SRC_ICON[s && s.kind] || '📄';

/** 卡片徽标：📄 文件名 p3 / 🖼 图片名 / 📷 拍题 */
function srcBadge(src) {
  if (!src || !src.kind) return '';
  if (src.kind === 'shot') return '📷 拍题';
  if (src.kind === 'map') return `🧠 ${src.name || '思维导图'}`;
  const name = src.name || '未命名';
  return `${srcIcon(src)} ${name}${src.page ? ' p' + src.page : ''}`;
}

/** 悬停 title：全名 + 页码 */
function srcFull(src) {
  if (!src || !src.kind) return '';
  if (src.kind === 'shot') return '拍题';
  if (src.kind === 'map') return `思维导图：${src.name || ''}`;
  return `${src.name || '未命名'}${src.page ? ` 第 ${src.page} 页` : ''}`;
}

/** 底图压到长边 ≤1400、JPEG q0.7；单页 >250 KB 再降一档（0.55 → 0.4） */
function shrinkBgDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 1400;
        const LIMIT = 250 * 1024;
        const iw = img.naturalWidth || 1;
        const ih = img.naturalHeight || 1;
        const k = Math.min(1, MAX / Math.max(iw, ih));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(iw * k));
        c.height = Math.max(1, Math.round(ih * k));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        let q = 0.7;
        let out = c.toDataURL('image/jpeg', q);
        while (out.length * 0.75 > LIMIT && q > 0.35) {   /* base64 长度 × 0.75 ≈ 字节数 */
          q = Math.round((q - 0.15) * 100) / 100;
          out = c.toDataURL('image/jpeg', q);
        }
        resolve(out);
      } catch (e) {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* 轻提示：底部一条，几秒后自己淡出（导入结果 / 错误都用它） */
let toastT = 0;
function toast(msg, isBad) {
  let el = document.getElementById('kynbToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kynbToast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast' + (isBad ? ' bad' : '');
  void el.offsetWidth;              /* 先落在收起态，淡入才会动 */
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), isBad ? 4500 : 2200);
}
