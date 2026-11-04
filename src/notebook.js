/* 笔记本：笔记库 + 编辑器 */
import { store, uid, fmtTime } from './store.js';
import { InkBoard, COLORS, SIZES } from './inkboard.js';
import { buildNoteJson, parseNoteJson } from './notejson.js';

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
  const st = { note: null, pages: [], idx: 0, tool: 'pen', color: COLORS[0], size: SIZES[1], saveT: 0 };

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
      st.tool = b.dataset.tool;
      board.tool = st.tool;
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

  board.onChange = () => saveSoon(false);

  /* ---------- 保存 ---------- */
  function saveSoon(force) {
    clearTimeout(st.saveT);
    st.saveT = setTimeout(() => saveNow(), force ? 120 : 700);
  }

  /** quick=true：只写页面和元数据、跳过缩略图与重绘列表——切后台 / 转屏时用，越快落盘越好 */
  async function saveNow(quick) {
    if (!st.note || !st.pages.length) return;
    const page = st.pages[st.idx];
    page.strokes = board.getStrokes();
    page.template = board.template;
    await store.putPage({
      id: `${st.note.id}#${page.no}`,
      noteId: st.note.id,
      no: page.no,
      template: page.template,
      strokes: page.strokes,
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
    if (!st.note || !st.pages.length) return;
    clearTimeout(st.saveT);
    saveNow(true);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('pagehide', flushSave);

  /* ---------- 页面 ---------- */
  function loadPage(i) {
    st.idx = Math.max(0, Math.min(st.pages.length - 1, i));
    const p = st.pages[st.idx];
    board.loadPage({ template: p.template, bg: p.bg, strokes: p.strokes });
    tplSel.value = p.template || 'blank';
    pageInfo.textContent = `第 ${st.idx + 1} / ${st.pages.length} 页`;
  }

  $('inkPrev').onclick = () => { if (st.idx > 0) { saveNow(); loadPage(st.idx - 1); } };
  $('inkNext').onclick = () => { if (st.idx < st.pages.length - 1) { saveNow(); loadPage(st.idx + 1); } };
  $('inkAddPage').onclick = async () => {
    await saveNow();
    st.pages.push({ no: st.pages.length, template: 'blank', strokes: [], bg: null });
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

  async function openNote(id) {
    const n = await store.getNote(id);
    if (!n) return;
    const pages = await store.pagesOf(id);
    st.note = n;
    st.pages = pages.length ? pages.map((p) => ({
      no: p.no, template: p.template || 'blank', strokes: p.strokes || [], bg: p.bg || null,
    })) : [{ no: 0, template: 'blank', strokes: [], bg: null }];
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
    await store.putPage({ id: `${id}#0`, noteId: id, no: 0, template: 'blank', strokes: [], bg: withBg || null });
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
    for (const p of st.pages) {
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
    c.innerHTML = `
        <div class="thumb" style="${n.thumb ? `background-image:url('${n.thumb}')` : ''}"></div>
        <div class="meta">
          <div class="name">${escapeHtml(n.title || '未命名笔记')}</div>
          <div class="sub">${n.pageCount || 1} 页 · ${fmtTime(n.updatedAt)}</div>
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

  const api = { renderLib, newNote, openNote, board, state: st, addBgPage, addBgNote, toast };
  noteApi = api;
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
