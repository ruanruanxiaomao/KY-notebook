/* 入口：标签页切换、设置、提示词管理 */
import { initNotebook } from './notebook.js';
import { initShot } from './shot.js';
import { initAnnot } from './annot.js';
import { initMap } from './mapview.js';
import { getCfg, setCfg, listModels } from './ai.js';
import { getHwrCfg, setHwrCfg } from './hwr.js';
import { getPrompts, setPrompts, resetPrompts, DEFAULT_PROMPTS } from './prompts.js';
import { initAgent, getAgentCfg, setAgentCfg } from './agent.js';

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
const agent = initAgent(notebook, map);      /* 连电脑：用电脑上的语料生成笔记 */
window.__kynb = { notebook, shot, annot, map, agent };   /* 调试 / 冒烟测试用 */

/* ---------- 笔记文字字体 ---------- */
const FONT_KEY = 'kynb_font';              /* 文字块字体（黑体/宋体/楷体…，'' = 默认） */
const SYSFONT_KEY = 'kynb_sysfont';        /* 'auto' | 'none' | 字体文件路径 */
const DEFAULT_TEXT = (getComputedStyle(document.documentElement).getPropertyValue('--text-font').trim())
  || 'system-ui, sans-serif';
const DEFAULT_UI = (getComputedStyle(document.documentElement).getPropertyValue('--ui-font').trim())
  || DEFAULT_TEXT;

let fontSaved = '';
let sysChoice = 'auto';        /* auto=跟随手机主题字体 */
let sysFontPath = '';          /* 当前真正在用的字体文件 */
let themeFont = '';            /* 检测到的「主题字体」文件（/data/skin/fonts/ 下那个） */
let fontList = null;
try {
  fontSaved = localStorage.getItem(FONT_KEY) || '';
  sysChoice = localStorage.getItem(SYSFONT_KEY) || 'auto';
} catch (e) { /* 无痕模式 */ }

let sysFace = null;

/** 把字体栈拼出来：装上了手机字体就排在第一位，后面的照旧兜底 */
function applyFont() {
  const root = document.documentElement;
  const textBase = fontSaved || DEFAULT_TEXT;
  const textStack = sysFace ? `"KYPhoneFont", ${textBase}` : (fontSaved || '');
  if (textStack) root.style.setProperty('--text-font', textStack);
  else root.style.removeProperty('--text-font');
  /* 界面文字也跟着手机字体走（用户既然在主题里换过字体，整个 App 都该长一样） */
  root.style.setProperty('--ui-font', sysFace ? `"KYPhoneFont", ${DEFAULT_UI}` : DEFAULT_UI);
  try { if (notebook && notebook.refreshFont) notebook.refreshFont(); } catch (e) { /* 早期调用 */ }
  const prev = document.getElementById('fontPrev');
  if (prev) {
    prev.textContent = '中英混排 Handwriting 123 · ' + (sysFace ? '手机字体' : (fontSaved ? '自定义字体' : '系统字体'));
  }
}

/**
 * 把字体文件装进页面。
 * 手机上「设置→字体样式」换的字体，WebView 里用 font-family 名字是拿不到的，
 * 所以走壳层的 /sysfont 把字体文件本身取回来，用 FontFace 装上。
 */
async function useSysFont(pathOrUrl) {
  try {
    const url = /^(blob:|data:)/.test(pathOrUrl)
      ? pathOrUrl
      : '/sysfont?path=' + encodeURIComponent(pathOrUrl);
    const face = new FontFace('KYPhoneFont', `url("${url}")`);
    await face.load();
    if (sysFace) { try { document.fonts.delete(sysFace); } catch (e) { /* 忽略 */ } }
    document.fonts.add(face);
    sysFace = face;
    sysFontPath = pathOrUrl;
    applyFont();
    return true;
  } catch (e) {
    return false;
  }
}

function dropSysFont() {
  if (sysFace) { try { document.fonts.delete(sysFace); } catch (e) { /* 忽略 */ } }
  sysFace = null;
  sysFontPath = '';
  applyFont();
}

applyFont();

async function getFontList() {
  if (fontList) return fontList;
  const r = await fetch('/sysfonts', { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  fontList = await r.json();
  return fontList;
}

/** 主题字体 = /data/skin/fonts/ 下体积最大的那个（主题换的字体就放这儿） */
function pickThemeFont(list) {
  const ts = list.filter((f) => f.theme);
  if (!ts.length) return '';
  ts.sort((a, b) => (b.size || 0) - (a.size || 0));
  return ts[0].path;
}

/** 启动时按保存的选择把字体装上 */
(async function bootFont() {
  try {
    const list = await getFontList();
    themeFont = pickThemeFont(list);
  } catch (e) { /* 网页版没有这个接口 */ }
  let want = '';
  if (sysChoice === 'auto') want = themeFont;
  else if (sysChoice !== 'none') want = sysChoice;
  if (want) await useSysFont(want);
})();

let sysFontsLoaded = false;
async function fillSysFonts(force) {
  const sel = $('cfgSysFont');
  const st = $('cfgSysFontStatus');
  if (!sel) return;
  if (sysFontsLoaded && !force) { sel.value = sysChoice; return; }
  st.className = 'status';
  st.textContent = '读取中…';
  try {
    if (force) fontList = null;
    const list = await getFontList();
    themeFont = pickThemeFont(list);
    sel.innerHTML = '<option value="auto">跟随手机主题字体（默认）</option>'
      + '<option value="none">不用，使用 App 默认字体</option>';
    for (const f of list) {
      const o = document.createElement('option');
      o.value = f.path;
      o.textContent = f.label + (f.theme ? '（主题字体）' : '');
      sel.appendChild(o);
    }
    sysFontsLoaded = true;
    sel.value = sysChoice;
    st.textContent = themeFont
      ? '当前主题字体：' + themeFont.replace('/data/skin/fonts/', '')
      : `读到 ${list.length} 个字体文件，没找到主题字体`;
  } catch (e) {
    sel.innerHTML = '<option value="auto">跟随手机主题字体</option>'
      + '<option value="none">不用，使用 App 默认字体</option>';
    sel.value = sysChoice;
    st.textContent = '这个版本读不到手机字体（网页版没有这个接口，装成 App 才有）';
  }
}

/* 点对话框外面的暗色区域也能关掉：手机上比找按钮顺手（返回键也可以） */
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); });
});

/* ---------- 设置 ---------- */
const dlgSettings = $('dlgSettings');
$('btnSettings').onclick = () => {
  const c = getCfg();
  $('cfgBase').value = c.baseUrl || '';
  $('cfgKey').value = c.apiKey || '';
  $('cfgModel').value = c.model || '';
  $('cfgVision').checked = !!c.vision;
  $('cfgIdle').value = String(getHwrCfg().idle);
  const commitMs = getHwrCfg().commit || 8000;
  const commitOpts = [...$('cfgCommit').options].map((o) => Number(o.value));
  const commitNear = commitOpts.reduce((a, b) => (Math.abs(b - commitMs) < Math.abs(a - commitMs) ? b : a), commitOpts[0]);
  $('cfgCommit').value = String(commitNear);
  /* 排版：字号 / 行距 / 对齐 */
  const lo = notebook.getLayout ? notebook.getLayout() : { size: 0, gap: 1.35, align: 'left' };
  const sizeVal = String(lo.size);
  const hasOpt = [...$('cfgHwrSize').options].some((o) => o.value === sizeVal);
  $('cfgHwrSize').value = hasOpt ? sizeVal : '-1';
  $('cfgHwrSizeCustom').hidden = hasOpt;
  $('cfgHwrSizeCustom').value = hasOpt ? '' : String(lo.size || '');
  $('cfgHwrGap').value = String(lo.gap);
  /* 排版面板的「行距±」会做出 1.45 这种值，下拉里没有就归到最近的一档，别让框空着 */
  if (!$('cfgHwrGap').value) {
    const gaps = [...$('cfgHwrGap').options].map((o) => Number(o.value));
    const near = gaps.reduce((a, b) => (Math.abs(b - lo.gap) < Math.abs(a - lo.gap) ? b : a), gaps[0]);
    $('cfgHwrGap').value = String(near);
  }
  $('cfgHwrAlign').value = lo.align || 'left';
  /* 电脑 Agent */
  const ag = getAgentCfg();
  $('cfgAgUrl').value = ag.url || '';
  $('cfgAgToken').value = ag.token || '';
  $('cfgAgStatus').textContent = '';
  $('cfgAgStatus').className = 'status';
  $('cfgHwrApplyStatus').textContent = '';
  $('cfgFont').value = fontSaved;
  applyFont();
  fillSysFonts(false);
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
  hc.idle = Number($('cfgIdle').value) || 800;
  hc.commit = Number($('cfgCommit').value) || 8000;
  setHwrCfg(hc);
  if (notebook.hwr) notebook.hwr.idle = hc.idle;
  const hud = !!$('cfgHud').checked;
  try { localStorage.setItem('kynb_hud', hud ? '1' : '0'); } catch (e) { /* 忽略 */ }
  notebook.setHud(hud);
  /* 排版：字号（-1 = 自定义，读右边那个数字框）/ 行距 / 对齐 */
  if (notebook.setLayout) notebook.setLayout(readLayoutForm());
  /* 电脑 Agent 地址 / 口令 */
  setAgentCfg({ url: $('cfgAgUrl').value, token: $('cfgAgToken').value });
  /* 字体：选中项即保存（''=系统默认） */
  fontSaved = $('cfgFont').value || '';
  try { localStorage.setItem(FONT_KEY, fontSaved); } catch (e) { /* 忽略 */ }
  applyFont();
};

/* 设置里换字体立刻能看见效果；点「取消」则回到已保存的那个 */
$('cfgFont').onchange = () => { applyFont(); };
dlgSettings.addEventListener('close', () => { applyFont(); });

/* ---------- 排版设置 ---------- */
function readLayoutForm() {
  const selSize = Number($('cfgHwrSize').value);
  const customSize = Number($('cfgHwrSizeCustom').value);
  const wantSize = selSize === -1 ? customSize : selSize;
  return {
    size: Math.max(0, Math.min(160, Math.round(wantSize) || 0)),
    gap: Number($('cfgHwrGap').value) || 1.35,
    align: $('cfgHwrAlign').value,
  };
}
$('cfgHwrSize').onchange = () => {
  const custom = $('cfgHwrSize').value === '-1';
  $('cfgHwrSizeCustom').hidden = !custom;
  if (custom) $('cfgHwrSizeCustom').focus();
};
$('cfgHwrApply').onclick = () => {
  /* 先把表单里的值存进设置（用户可能还没点保存），再套到本页 */
  if (notebook.setLayout) notebook.setLayout(readLayoutForm());
  const st = $('cfgHwrApplyStatus');
  const n = notebook.applyLayoutToPage ? notebook.applyLayoutToPage() : 0;
  st.className = 'status';
  st.textContent = n ? `已把这一页 ${n} 块文字改成这个字号 / 行距` : '这一页还没有文字';
};

/* ---------- 手机里的字体（含主题换的字体） ---------- */
$('cfgSysFontReload').onclick = () => fillSysFonts(true);
$('cfgSysFont').onchange = async () => {
  const v = $('cfgSysFont').value;
  const st = $('cfgSysFontStatus');
  st.className = 'status';
  sysChoice = v || 'auto';
  try { localStorage.setItem(SYSFONT_KEY, sysChoice); } catch (e) { /* 忽略 */ }
  if (sysChoice === 'none') {
    dropSysFont();
    st.textContent = '已回到 App 默认字体';
    return;
  }
  const want = sysChoice === 'auto' ? themeFont : sysChoice;
  if (!want) { dropSysFont(); st.textContent = '没找到主题字体，已用默认字体'; return; }
  st.textContent = '正在加载字体文件…';
  const ok = await useSysFont(want);
  st.textContent = ok ? '已换成手机里的这个字体（整个 App 都生效）' : '这个字体文件加载失败';
  if (!ok) st.className = 'status bad';
};
$('cfgSysFontFile').onclick = () => { $('cfgSysFontInput').value = ''; $('cfgSysFontInput').click(); };
$('cfgSysFontInput').onchange = async () => {
  const f = $('cfgSysFontInput').files && $('cfgSysFontInput').files[0];
  if (!f) return;
  const st = $('cfgSysFontStatus');
  st.className = 'status';
  st.textContent = '正在加载 ' + f.name + ' …';
  const ok = await useSysFont(URL.createObjectURL(f));
  if (ok) {
    st.textContent = `已用「${f.name}」渲染（只在这次打开有效，重开 App 要再选）`;
    $('cfgSysFont').value = '';
  } else {
    st.className = 'status bad';
    st.textContent = '这个文件不是字体（要 .ttf / .otf）';
  }
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
