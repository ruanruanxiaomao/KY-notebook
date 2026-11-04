/* 笔记本：笔记库 + 编辑器 */
import { store, uid, fmtTime } from './store.js';
import { InkBoard, PAGE_W, PAGE_H, COLORS, SIZES, imageToDataUrl, loadImageFile } from './inkboard.js';
import { buildNoteJson, parseNoteJson } from './notejson.js';
import { mdInto } from './md.js';
import { HwrPad } from './hwrpad.js';
import { bboxOf, groupLines, looksLikeFormula, recognizeLocal, recognizeFormula, texToImage, inkToCanvas } from './hwr.js';
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

  const board = new InkBoard($('inkCv'), $('inkPaper'), $('inkStage'));
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
    const cur = st.pages[st.idx];
    if (cur) cur.strokes = board.getStrokes();
    saveSoon(false);
  };

  /* ---------- 画布缩放 / 拖拽平移 ---------- */
  const stageEl = $('inkStage');
  const zoomInfo = $('inkZoomInfo');
  const ZOOM_KEY = 'kynb_zoom';

  function paintZoom() {
    zoomInfo.textContent = Math.round((board.zoom || 1) * 100) + '%';
    try { localStorage.setItem(ZOOM_KEY, String(board.zoom || 1)); } catch (e) { /* 无痕模式忽略 */ }
  }

  /* 以 (cx, cy) 为锚点缩放：缩放前后让这个点在屏幕上不动 */
  function setZoom(z, cx, cy) {
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

  $('inkZoomIn').onclick = () => setZoom((board.zoom || 1) + 0.15);
  $('inkZoomOut').onclick = () => setZoom((board.zoom || 1) - 0.15);
  $('inkZoomFit').onclick = () => {
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
  let selId = null;
  let editingId = null;
  let activeTextId = null;      /* 手写转文字往哪个文本框里写 */

  const pageNow = () => st.pages[st.idx];

  function setTool(t) {
    st.tool = t;
    board.tool = t;
    document.querySelectorAll('#inkTools [data-tool]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tool === t);
    });
    $('inkStage').classList.toggle('grab', t === 'pan');
    $('inkStage').classList.toggle('selecting', t === 'sel');
    $('inkStage').classList.toggle('lassoing', t === 'lasso');
    if (t !== 'lasso') { try { clearLasso(); } catch (e) { /* 初始化早期还没定义 */ } }
    if (t !== 'sel') { selId = null; renderItems(); }
  }

  /* 元素层是 1414×1000 的页面坐标系，整体缩放跟纸面对齐，缩放/转屏都不用重算每个元素 */
  function syncItemsScale() {
    const k = (board.paper.clientWidth || PAGE_W) / PAGE_W;
    layerBelow.style.transform = `scale(${k})`;
    layerAbove.style.transform = `scale(${k})`;
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
        + (it.id === selId ? ' on' : '') + (it.id === activeTextId ? ' cur' : '');
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
  }

  function pickItem(id) {
    selId = id;
    document.querySelectorAll('.ink-items .it').forEach((x) => {
      x.classList.toggle('on', x.dataset.id === id);
    });
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
    pickItem(it.id);
    const k = (board.paper.clientWidth || PAGE_W) / PAGE_W;
    const s0 = { x: e.clientX, y: e.clientY, ox: it.x, oy: it.y };
    const move = (ev) => {
      it.x = Math.round(s0.ox + (ev.clientX - s0.x) / k);
      it.y = Math.round(s0.oy + (ev.clientY - s0.y) / k);
      el.style.left = it.x + 'px';
      el.style.top = it.y + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveSoon(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startResize(e, it, el) {
    e.preventDefault();
    e.stopPropagation();
    pickItem(it.id);
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
    pickItem(it.id);
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
    if (selId === id) selId = null;
    renderItems();
    saveSoon(true);
    toast('已删除元素');
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
  let live = null;                     // 正在写的那一行：{ strokes, item, gen, pt, ct }
  let pendingTex = new Set();          // 公式模式攒的笔画
  let texTimer = 0;
  let busyConv = false;

  try { hwrMode = localStorage.getItem(HWR_MODE_KEY) || 'off'; } catch (e) { hwrMode = 'off'; }
  if (hwrMode !== 'text' && hwrMode !== 'formula') hwrMode = 'off';

  function paintHwrBtns() {
    $('inkHwrText').classList.toggle('on', hwrMode === 'text');
    $('inkHwrTex').classList.toggle('on', hwrMode === 'formula');
  }
  paintHwrBtns();

  function setHwrMode(m) {
    hwrMode = hwrMode === m ? 'off' : m;
    try { localStorage.setItem(HWR_MODE_KEY, hwrMode); } catch (e) { /* 无痕 */ }
    paintHwrBtns();
    try { commitLine(); } catch (e) { /* 还没定义 */ }
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
    if (L.item) {
      const p = pageNow();
      if (p && Array.isArray(p.items)) {
        p.items = p.items.filter((x) => x.id !== L.item.id);
        board.items = p.items;
        renderItems();
      }
    }
  };

  /** 一行笔迹 → 原位文字块（字号按笔迹高度，颜色跟着笔走） */
  function insertTextFromInk(list, text) {
    const bb = bboxOf(list);
    if (!bb) return null;
    const p = pageNow();
    if (!p) return null;
    if (!Array.isArray(p.items)) p.items = [];
    const size = Math.round(Math.max(14, Math.min(160, bb.h * 1.15)));
    const it = {
      id: uid('it'), type: 'text', z: 'above', text,
      size, color: (list[0] && list[0].c) || '#1f1c18',
      x: Math.round(bb.x - size * 0.16),
      y: Math.round(bb.y - size * 0.18),
      w: Math.round(Math.max(bb.w + size * 0.8, size * 2)),
      h: Math.round(size * 1.5),
    };
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
      if (r.score < 0.45) {
        toast('这段不太确定，先没动它；想硬认就用 ⬚ 圈住后点「转文字」', true);
        return false;
      }
      made = insertTextFromInk(list, r.text);
      if (made) {
        const hint = looksLikeFormula(list) ? '（看着像公式？切到 ∑ 重写一次，或用 ⬚ 圈住点「转公式」）' : '';
        toast(`已转成文字「${r.text.slice(0, 12)}」· 点 ↶ 可退回笔迹${hint}`);
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
  /* 做法：抬笔 300ms 就把「这一行到目前为止的墨迹」整行认一次，认出来的字原位铺成文字块，
     同时把这一行墨迹临时藏起来（数据还在，只是不画）。接着写的字照常落在后面，
     下一次再整行认一遍、整体刷新 —— 所以越写越准，而不是一个字一个结果。
     停笔 1.5s、换行、或关掉模式 → 定稿：把这一行墨迹真删掉，只留文字。 */
  function newLive() {
    return { strokes: [], item: null, gen: 0, pt: 0, ct: 0 };
  }

  function breaksLine(stroke) {
    if (!live || !live.strokes.length) return false;
    const b = bboxOf([stroke]);
    const all = bboxOf(live.strokes);
    if (!b || !all) return false;
    const lineH = Math.max(16, all.h);
    return b.y > all.y + all.h + lineH * 0.45 && b.x < all.x + all.w * 0.7;
  }

  async function previewLine() {
    if (!live || busyConv || !st.note) return;
    const L = live;
    const strokes = L.strokes.slice();
    const gen = L.gen;
    if (!strokes.length) return;
    const ink = inkToCanvasCached(strokes);
    if (!ink) return;
    busyConv = true;
    try {
      const r = await recognizeLocal(ink);
      if (!live || live !== L || live.gen !== gen) return;   /* 期间又写了新的：这次结果过期 */
      if (!r.text || r.score < 0.4) return;                  /* 认不准就先不动墨迹 */
      if (!L.item) {
        L.item = insertTextFromInk(strokes, r.text);
      } else {
        L.item.text = r.text;
        const bb = bboxOf(strokes);
        if (bb) L.item.w = Math.round(Math.max(bb.w + L.item.size * 0.9, L.item.size * 2));
      }
      board.hideStrokes(strokes, true);   /* 这一行的墨迹先藏起来，屏幕上只剩文字 */
      renderItems();
      saveSoon(false);
    } catch (e) {
      /* 识别失败就当没发生，墨迹还在 */
    } finally {
      busyConv = false;
    }
  }

  /** 这一行定稿：墨迹真删掉，文字留下（已占好最后那次 pushUndo） */
  function commitLine() {
    const L = live;
    if (!L) return;
    clearTimeout(L.pt);
    clearTimeout(L.ct);
    live = null;
    if (!L.item) return;
    /* 快照里把这行文字块摘掉：撤销后回到「整行墨迹还在、还没转」的状态 */
    const snap = board._snap();
    snap.items = snap.items.filter((x) => x.id !== L.item.id);
    board.undoStack.push(snap);
    if (board.undoStack.length > 100) board.undoStack.shift();
    board.redoStack.length = 0;
    board.removeStrokes(L.strokes);
    renderItems();
    saveSoon(true);
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

  board.onStrokeEnd = (stroke) => {
    if (hwrMode === 'off' || !st.note || st.mode === 'md') return;
    if (stroke.t !== 'pen') return;          /* 荧光笔、橡皮不参与 */

    if (hwrMode === 'formula') {
      pendingTex.add(stroke);
      clearTimeout(texTimer);
      texTimer = setTimeout(() => flushFormula(), 1500);
      return;
    }

    if (breaksLine(stroke)) commitLine();
    if (!live) live = newLive();
    const L = live;
    L.strokes.push(stroke);
    L.gen++;
    const gen = L.gen;
    clearTimeout(L.pt);
    clearTimeout(L.ct);
    L.pt = setTimeout(() => { if (live === L && L.gen === gen) previewLine(); }, 300);
    L.ct = setTimeout(() => { if (live === L && L.gen === gen) commitLine(); }, 2200);
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

  $('inkAddText').onclick = () => {
    if (!st.note || st.mode === 'md') return;
    openTextDialog(null);
  };
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
      if (it) { it.text = txt; it.size = size; it.color = color; }
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
        const pg = { no: base + i - 1, template: 'blank', strokes: [], items: [], bg: url };
        st.pages.push(pg);
        await store.putPage({
          id: `${id}#${pg.no}`, noteId: id, no: pg.no,
          template: 'blank', strokes: [], items: [], bg: url,
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
    if (st.tool === 'sel' && !e.target.closest('.it') && selId) {
      selId = null;
      renderItems();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (!st.note || st.mode === 'md' || st.tool !== 'sel' || !selId) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeItem(selId);
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
    /* 还在「边写边认」的中间态就先把这一行定稿，否则存下去会留下「隐藏的墨迹 + 文字」，重开就重影了 */
    if (live) {
      try { commitLine(); } catch (e) { /* 初始化早期 */ }
    }
    if (st.mode === 'md') {
      st.note.title = titleEl.value.trim() || '未命名笔记';
      st.note.md = st.md || '';
      st.note.pageCount = 1;
      st.note.updatedAt = Date.now();
      await store.putNote({ ...st.note });
      localStorage.setItem(LS_LAST, st.note.id);
      localStorage.setItem(LS_LAST_AT, String(Date.now()));
      if (!quick) renderLib();
      return;
    }
    if (!st.pages.length) return;
    const page = st.pages[st.idx];
    page.strokes = board.getStrokes();
    page.template = board.template;
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
    st.idx = Math.max(0, Math.min(st.pages.length - 1, i));
    const p = st.pages[st.idx];
    if (!Array.isArray(p.items)) p.items = [];
    selId = null;
    activeTextId = null;      /* 换页了，手写文字重新找个框 */
    try { commitLine(); } catch (e) { /* 初始化早期还没定义 */ }
    pendingTex.clear();
    clearTimeout(texTimer);
    try { clearLasso(); } catch (e) { /* 初始化早期还没定义 */ }
    board.loadPage({ template: p.template, bg: p.bg, strokes: p.strokes, items: p.items });
    renderItems();
    tplSel.value = p.template || 'blank';
    pageInfo.textContent = `第 ${st.idx + 1} / ${st.pages.length} 页`;
  }

  $('inkPrev').onclick = () => { if (st.idx > 0) { saveNow(); loadPage(st.idx - 1); } };
  $('inkNext').onclick = () => { if (st.idx < st.pages.length - 1) { saveNow(); loadPage(st.idx + 1); } };
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
  function setMdEditing(on) {
    st.mdEditing = !!on;
    $('inkMdSrc').hidden = !on;
    $('inkMdView').hidden = !!on;
    $('inkMdEdit').hidden = !!on;
    $('inkMdSave').hidden = !on;
    $('inkMdCancel').hidden = !on;
    $('inkMdInfo').hidden = !!on;
    if (on) {
      $('inkMdSrc').value = st.md;
      $('inkMdSrc').focus();
    }
  }

  async function openMdNote(n) {
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
    mdInto($('inkMdView'), st.md);
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

  const api = { renderLib, newNote, openNote, board, hwr, state: st, addBgPage, addBgNote, addMdNote, toast,
    renderItems, openHandPad, convertInk, setHwrMode, setHud: (on) => board.setHud(on) };
  noteApi = api;
  /* 上次开了延迟面板就继续开着（调试用，不影响写字） */
  try { if (localStorage.getItem('kynb_hud') === '1') board.setHud(true); } catch (e) { /* 无痕模式 */ }
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
