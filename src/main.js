/* 入口：标签页切换、设置、提示词管理 */
import { initNotebook } from './notebook.js';
import { initShot } from './shot.js';
import { initAnnot } from './annot.js';
import { initMap } from './mapview.js';
import { getCfg, setCfg, listModels } from './ai.js';
import { getHwrCfg, setHwrCfg } from './hwr.js';
import { getPrompts, setPrompts, resetPrompts, DEFAULT_PROMPTS } from './prompts.js';

const $ = (id) => document.getElementById(id);

/* ---------- 标签页 ---------- */
const views = {
  ink: $('view-ink'),
  shot: $('view-shot'),
  annot: $('view-annot'),
  map: $('view-map'),
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
const map = initMap();
window.__kynb = { notebook, shot, annot, map };   /* 调试 / 冒烟测试用 */

/* ---------- 设置 ---------- */
const dlgSettings = $('dlgSettings');
$('btnSettings').onclick = () => {
  const c = getCfg();
  $('cfgBase').value = c.baseUrl || '';
  $('cfgKey').value = c.apiKey || '';
  $('cfgModel').value = c.model || '';
  $('cfgVision').checked = !!c.vision;
  $('cfgIdle').value = String(getHwrCfg().idle);
  try { $('cfgHud').checked = localStorage.getItem('kynb_hud') === '1'; } catch (e) { $('cfgHud').checked = false; }
  $('cfgModelList').innerHTML = '';
  $('cfgFetchStatus').textContent = '';
  dlgSettings.showModal();
  if (c.baseUrl && c.apiKey && !c.model) fetchModels(true);
};
$('cfgSave').onclick = () => {
  setCfg({
    baseUrl: $('cfgBase').value,
    apiKey: $('cfgKey').value,
    model: $('cfgModel').value,
    vision: $('cfgVision').checked,
  });
  const hc = getHwrCfg();
  hc.idle = Number($('cfgIdle').value) || 600;
  setHwrCfg(hc);
  if (notebook.hwr) notebook.hwr.idle = hc.idle;
  const hud = !!$('cfgHud').checked;
  try { localStorage.setItem('kynb_hud', hud ? '1' : '0'); } catch (e) { /* 忽略 */ }
  notebook.setHud(hud);
};

/* 从接口拉模型列表：填进 datalist，输入框可直接下拉选 */
async function fetchModels(auto) {
  const st = $('cfgFetchStatus');
  const dl = $('cfgModelList');
  const base = $('cfgBase').value.trim();
  const key = $('cfgKey').value.trim();
  if (!base) { st.className = 'status bad'; st.textContent = '先填 Base URL'; return; }
  st.className = 'status';
  st.textContent = '正在拉取模型列表…';
  try {
    const ids = await listModels(base, key);
    dl.innerHTML = '';
    ids.forEach((id) => {
      const o = document.createElement('option');
      o.value = id;
      dl.appendChild(o);
    });
    st.className = 'status ok';
    st.textContent = `拿到 ${ids.length} 个模型，点「模型」输入框可下拉选`;
    if (ids.length === 1 && !$('cfgModel').value.trim()) $('cfgModel').value = ids[0];
  } catch (e) {
    st.className = 'status bad';
    st.textContent = e && e.message ? e.message : String(e);
  }
}

$('cfgFetch').onclick = () => fetchModels(false);

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
