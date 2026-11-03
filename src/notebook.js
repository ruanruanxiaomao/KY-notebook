/* 笔记本：笔记库 + 编辑器 */
import { store, uid, fmtTime } from './store.js';
import { InkBoard, COLORS, SIZES } from './inkboard.js';

const LS_LAST = 'kynb_last_note';

export function initNotebook() {
  const $ = (id) => document.getElementById(id);
  const libEl = $('inkLib');
  const emptyEl = $('inkEmpty');
  const edEl = $('inkEditor');
  const titleEl = $('inkTitle');
  const pageInfo = $('inkPageInfo');
  const tplSel = $('inkTemplate');
  const starBtn = $('inkStar');

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

  async function saveNow() {
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
    st.note.thumb = await board.thumb(320);
    await store.putNote({ ...st.note });
    renderLib();
  }

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
    loadPage(0);
    requestAnimationFrame(() => board.layout());
    localStorage.setItem(LS_LAST, id);
  }

  async function closeNote() {
    /* 先等这一页存完再清状态：saveNow 后半段还要写 note.thumb / updatedAt */
    await saveNow();
    st.note = null;
    st.pages = [];
    edEl.hidden = true;
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

  $('inkExportJson').onclick = async () => {
    await saveNow();
    const note = await store.getNote(st.note.id);
    const pages = st.pages.map((p) => ({
      no: p.no, template: p.template, bg: !!p.bg, strokes: p.strokes,
    }));
    const blob = new Blob([JSON.stringify({ app: 'KY-notebook', version: 1, note, pages }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(note && note.title) || 'note'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  /* ---------- 笔记库 ---------- */
  async function renderLib() {
    const list = await store.allNotes();
    libEl.innerHTML = '';
    emptyEl.hidden = list.length > 0;
    list.forEach((n) => {
      const c = document.createElement('div');
      c.className = 'card';
      c.innerHTML = `
        <div class="thumb" style="${n.thumb ? `background-image:url('${n.thumb}')` : ''}"></div>
        <div class="meta">
          <div class="name">${escapeHtml(n.title || '未命名笔记')}</div>
          <div class="sub">${n.pageCount || 1} 页 · ${fmtTime(n.updatedAt)}</div>
        </div>
        ${n.star ? '<div class="star">★</div>' : ''}
        <button class="x" title="删除">✕</button>`;
      c.onclick = (e) => {
        if (e.target.classList.contains('x')) return;
        openNote(n.id);
      };
      c.querySelector('.x').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`删除「${n.title || '未命名笔记'}」？`)) return;
        await store.delNote(n.id);
        renderLib();
      };
      libEl.appendChild(c);
    });
  }

  renderLib();

  return {
    renderLib,
    newNote,
    openNote,
    board,
    state: st,
    /* 拍题「存为笔记底图」用 */
    async addBgPage(dataUrl, title) {
      if (st.note) {
        await saveNow();
        st.pages.push({ no: st.pages.length, template: 'blank', strokes: [], bg: dataUrl });
        titleEl.value = titleEl.value || title;
        loadPage(st.pages.length - 1);
        saveSoon(true);
        return st.note.id;
      }
      const id = uid('note');
      const note = {
        id, title: title || '拍题笔记', kind: 'shot', star: 0,
        createdAt: Date.now(), updatedAt: Date.now(), pageCount: 1, thumb: '',
      };
      await store.putNote(note);
      await store.putPage({ id: `${id}#0`, noteId: id, no: 0, template: 'blank', strokes: [], bg: dataUrl });
      await openNote(id);
      return id;
    },
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
