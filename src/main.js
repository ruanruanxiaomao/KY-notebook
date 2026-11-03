/* 入口：标签页切换、设置、提示词管理 */
import { initNotebook } from './notebook.js';
import { initShot } from './shot.js';
import { initAnnot } from './annot.js';
import { getCfg, setCfg } from './ai.js';
import { getPrompts, setPrompts, resetPrompts, DEFAULT_PROMPTS } from './prompts.js';

const $ = (id) => document.getElementById(id);

/* ---------- 标签页 ---------- */
const views = {
  ink: $('view-ink'),
  shot: $('view-shot'),
  annot: $('view-annot'),
};
document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
    Object.keys(views).forEach((k) => { views[k].hidden = k !== b.dataset.tab; });
    /* 显示后重排画板（隐藏时尺寸是 0） */
    setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
  };
});

/* ---------- 模块 ---------- */
const notebook = initNotebook();
const shot = initShot(notebook);
const annot = initAnnot();
window.__kynb = { notebook, shot, annot };   /* 调试 / 冒烟测试用 */

/* ---------- 设置 ---------- */
const dlgSettings = $('dlgSettings');
$('btnSettings').onclick = () => {
  const c = getCfg();
  $('cfgBase').value = c.baseUrl || '';
  $('cfgKey').value = c.apiKey || '';
  $('cfgModel').value = c.model || '';
  $('cfgVision').checked = !!c.vision;
  dlgSettings.showModal();
};
$('cfgSave').onclick = () => {
  setCfg({
    baseUrl: $('cfgBase').value,
    apiKey: $('cfgKey').value,
    model: $('cfgModel').value,
    vision: $('cfgVision').checked,
  });
};

/* ---------- 提示词 ---------- */
const dlgPrompts = $('dlgPrompts');
const listEl = $('promptList');
let editingId = '';

function drawPromptList() {
  const list = getPrompts();
  listEl.innerHTML = '';
  list.forEach((p) => {
    const it = document.createElement('div');
    it.className = 'prompt-item' + (p.id === editingId ? ' on' : '');
    it.innerHTML = `<span class="nm">${esc(p.name)}</span><span class="bd">${esc((p.body || '').slice(0, 40))}</span>`;
    it.onclick = () => {
      editingId = p.id;
      $('pName').value = p.name;
      $('pSys').value = p.system || '';
      $('pBody').value = p.body || '';
      drawPromptList();
    };
    listEl.appendChild(it);
  });
  /* 新建按钮 */
  const add = document.createElement('div');
  add.className = 'prompt-item';
  add.innerHTML = '<span class="nm" style="color:#8b2f2f">＋ 新建一条提示词</span>';
  add.onclick = () => {
    editingId = 'p_' + Date.now().toString(36);
    $('pName').value = '';
    $('pSys').value = '';
    $('pBody').value = '';
    drawPromptList();
  };
  listEl.appendChild(add);
}

$('btnPrompts').onclick = () => {
  const list = getPrompts();
  editingId = list[0] ? list[0].id : '';
  if (list[0]) {
    $('pName').value = list[0].name;
    $('pSys').value = list[0].system || '';
    $('pBody').value = list[0].body || '';
  }
  drawPromptList();
  dlgPrompts.showModal();
};

$('pSave').onclick = () => {
  const name = $('pName').value.trim();
  if (!name) { $('pStatus').textContent = '先起个名字'; return; }
  const list = getPrompts();
  const item = {
    id: editingId || 'p_' + Date.now().toString(36),
    name,
    system: $('pSys').value.trim(),
    body: $('pBody').value.trim(),
  };
  const i = list.findIndex((p) => p.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
  setPrompts(list);
  editingId = item.id;
  drawPromptList();
  refreshPromptSelects();
  $('pStatus').textContent = '已保存';
  setTimeout(() => { $('pStatus').textContent = ''; }, 1200);
};

$('pReset').onclick = () => {
  if (!confirm('恢复成默认的几条提示词？你自己加的会被清掉。')) return;
  resetPrompts();
  editingId = DEFAULT_PROMPTS[0].id;
  $('pName').value = DEFAULT_PROMPTS[0].name;
  $('pSys').value = DEFAULT_PROMPTS[0].system || '';
  $('pBody').value = DEFAULT_PROMPTS[0].body || '';
  drawPromptList();
  refreshPromptSelects();
  $('pStatus').textContent = '已恢复默认';
};

function refreshPromptSelects() {
  if (window.__kynbFillPrompts) window.__kynbFillPrompts();
  if (window.__kynbFillAnnotPrompts) window.__kynbFillAnnotPrompts();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 首次打开：没配置就在顶部挂一条提示（不用 confirm，避免阻塞自动化/无头预览） */
window.addEventListener('load', () => {
  const c = getCfg();
  if (c.baseUrl && c.model) return;
  setTimeout(() => {
    const bar = document.createElement('div');
    bar.className = 'notice';
    bar.innerHTML = '还没配置 AI 接口 —— 拍题和「AI 解析」需要它。' +
      '<button class="btn" id="noticeCfg">现在去填</button>' +
      '<button class="btn ghost" id="noticeClose">先不用</button>';
    document.body.appendChild(bar);
    bar.querySelector('#noticeCfg').onclick = () => { $('btnSettings').click(); bar.remove(); };
    bar.querySelector('#noticeClose').onclick = () => bar.remove();
  }, 600);
});
