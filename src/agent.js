/* 电脑 Agent：手机连电脑上的 bridge，让电脑读语料、调模型，生成笔记 / 思维导图
 *
 * 为什么这么绕：手机读不到电脑里的 PDF/课件文件夹，也跑不动大模型；
 * 笔记又存在手机本地（IndexedDB）。所以电脑负责「读 + 写」，手机负责「存」。
 * 参考 Joplin Data API / Obsidian Local REST API：本机 HTTP 服务 + token。
 *
 * App 里 WebView 会拦 http 明文（ERR_CLEARTEXT_NOT_PERMITTED），
 * 所以直连失败时自动改走壳层的 /proxy?u=（同源、由 Java 发请求）。
 */
import { mdInto } from './md.js';

const $ = (id) => document.getElementById(id);
const CFG_KEY = 'kynb_agent';

let cfg = { url: '', token: '' };
try {
  const raw = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
  if (raw && typeof raw === 'object') {
    cfg.url = String(raw.url || '');
    cfg.token = String(raw.token || '');
  }
} catch (e) { /* 无痕模式 */ }

let notebook = null;
let mapMod = null;
let curDir = '';
let picked = new Map();      /* path → name */
let last = null;             /* 最近一次生成结果 */
let busy = false;

export function getAgentCfg() { return { url: cfg.url, token: cfg.token }; }

export function setAgentCfg(next) {
  if (!next) return getAgentCfg();
  if (next.url != null) cfg.url = String(next.url).trim();
  if (next.token != null) cfg.token = String(next.token).trim();
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
  return getAgentCfg();
}

function baseUrl() {
  return String(cfg.url || '').trim().replace(/\/+$/, '');
}

async function rawFetch(url, opt) {
  try {
    return await fetch(url, opt);
  } catch (e) {
    /* 明文 http 被 WebView 拦了 → 走壳层代理（同源） */
    const via = '/proxy?u=' + encodeURIComponent(url);
    return await fetch(via, opt);
  }
}

/** 调电脑桥；失败统一抛出可读的中文错误 */
async function api(path, opt) {
  const base = baseUrl();
  if (!base) throw new Error('还没填电脑地址：设置 →「电脑 Agent」');
  const body = opt && opt.body;
  const headers = { 'X-KYNB-Token': cfg.token || '' };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await rawFetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let obj = null;
  try { obj = JSON.parse(txt); } catch (e) {
    throw new Error('电脑返回的不是 JSON（地址填错了？）：' + txt.slice(0, 100));
  }
  if (!r.ok || obj.ok === false) throw new Error(obj.error || ('HTTP ' + r.status));
  return obj;
}

export async function ping() {
  return api('/ping');
}

/* ---------------- 界面 ---------------- */

function setStatus(msg, bad) {
  const el = $('agStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'status' + (bad ? ' bad' : '');
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

function renderChosen() {
  const box = $('agChosen');
  if (!box) return;
  box.innerHTML = '';
  if (!picked.size) {
    box.innerHTML = '<span class="ag-empty">还没选语料（也可以只写指令，让电脑直接写）</span>';
    return;
  }
  for (const [path, name] of picked) {
    const chip = document.createElement('span');
    chip.className = 'ag-chip';
    chip.textContent = name;
    chip.title = path;
    const x = document.createElement('b');
    x.textContent = '✕';
    x.onclick = () => { picked.delete(path); renderChosen(); paintList(); };
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

let curItems = [];

function paintList() {
  const list = $('agList');
  if (!list) return;
  list.innerHTML = '';
  for (const it of curItems) {
    const row = document.createElement('div');
    row.className = 'ag-row' + (it.type === 'dir' ? ' dir' : '') + (picked.has(it.path) ? ' on' : '');
    row.dataset.path = it.path;
    const ic = document.createElement('span');
    ic.className = 'ag-ic';
    ic.textContent = it.type === 'dir' ? '📁' : '📄';
    const nm = document.createElement('span');
    nm.className = 'ag-nm';
    nm.textContent = it.name;
    const sz = document.createElement('span');
    sz.className = 'ag-sz';
    sz.textContent = it.type === 'dir' ? '' : (it.sizeText || fmtSize(it.size));
    row.appendChild(ic);
    row.appendChild(nm);
    row.appendChild(sz);
    if (it.type === 'file' && picked.has(it.path)) {
      const ok = document.createElement('span');
      ok.className = 'ag-ok';
      ok.textContent = '✓';
      row.appendChild(ok);
    }
    row.onclick = () => {
      if (it.type === 'dir') { loadFiles(it.path); return; }
      if (picked.has(it.path)) picked.delete(it.path); else picked.set(it.path, it.name);
      paintList();
      renderChosen();
    };
    list.appendChild(row);
  }
  if (!curItems.length) {
    list.innerHTML = '<div class="ag-empty">这个目录里没有能读的文件（支持 md/txt/docx/pptx/pdf/csv）</div>';
  }
}

async function loadFiles(dir) {
  setStatus('正在读电脑上的目录…');
  try {
    const d = await api('/files?dir=' + encodeURIComponent(dir || ''));
    curDir = d.dir || '';
    curItems = d.items || [];
    $('agPath').textContent = '/' + curDir;
    paintList();
    setStatus(`读到 ${curItems.length} 项`);
  } catch (e) {
    setStatus(String(e.message || e), true);
  }
}

async function doPing() {
  setStatus('正在连电脑…');
  try {
    const d = await ping();
    setStatus(`已连上：${d.rootName || d.root} · ${d.model || '未配模型'}`);
    return d;
  } catch (e) {
    setStatus(String(e.message || e), true);
    return null;
  }
}

/* ---------- 发件箱：电脑端（WorkBuddy 的 MCP 工具 / 桥）放进去的笔记，这里收 ---------- */
let inboxItems = [];

async function refreshInbox() {
  const box = $('agInbox');
  if (!box) return;
  try {
    const d = await api('/queue');
    inboxItems = d.items || [];
    if (!inboxItems.length) { box.hidden = true; return; }
    box.hidden = false;
    $('agInboxBtn').textContent = `从电脑收下 ${inboxItems.length} 条笔记`;
    $('agInboxStatus').textContent = inboxItems.map((x) => x.title).join('、').slice(0, 46);
  } catch (e) {
    box.hidden = true;
  }
}

async function pullInbox() {
  if (!inboxItems.length) return;
  const btn = $('agInboxBtn');
  btn.disabled = true;
  $('agInboxStatus').textContent = '正在收…';
  let n = 0;
  for (const it of inboxItems) {
    try {
      await notebook.addMdNote(it.title || 'AI 笔记', it.markdown);
      n += 1;
    } catch (e) { /* 单条失败不影响其它 */ }
  }
  try { await api('/queue/ack', { method: 'POST', body: { ids: inboxItems.map((x) => x.id) } }); }
  catch (e) { /* 下次再收一遍，最多重复一条 */ }
  inboxItems = [];
  $('agInbox').hidden = true;
  btn.disabled = false;
  closeDlg();
  document.querySelector('.tab[data-tab="ink"]').click();
  notebook.toast(`已从电脑收下 ${n} 条笔记`);
}

function showPreview(html) {
  const box = $('agPrev');
  box.hidden = false;
  box.innerHTML = html;
  box.scrollIntoView({ block: 'nearest' });
}

function previewNote(d) {
  const box = document.createElement('div');
  box.className = 'ag-note';
  const head = document.createElement('div');
  head.className = 'ag-note-head';
  head.innerHTML = `<strong>${d.title || 'AI 笔记'}</strong>
    <span class="status">${d.markdown.length} 字 · 用了 ${(d.sources || []).filter((s) => s.ok).length} 个文件</span>`;
  const body = document.createElement('div');
  body.className = 'ag-note-body';
  mdInto(body, d.markdown);
  const bar = document.createElement('div');
  bar.className = 'row end';
  const save = document.createElement('button');
  save.className = 'btn primary';
  save.textContent = '存为笔记';
  save.onclick = async () => {
    save.disabled = true;
    try {
      await notebook.addMdNote(d.title || 'AI 笔记', d.markdown);
      closeDlg();
      document.querySelector('.tab[data-tab="ink"]').click();
      notebook.toast('已存进笔记本：' + (d.title || 'AI 笔记'));
    } catch (e) {
      setStatus('存失败：' + (e.message || e), true);
    } finally {
      save.disabled = false;
    }
  };
  const again = document.createElement('button');
  again.className = 'btn ghost';
  again.textContent = '重写一次';
  again.onclick = () => { $('agPrev').hidden = true; go(); };
  bar.appendChild(again);
  bar.appendChild(save);
  box.appendChild(head);
  box.appendChild(body);
  box.appendChild(bar);
  showPreview('');
  $('agPrev').appendChild(box);
}

function previewMap(d) {
  const box = document.createElement('div');
  box.className = 'ag-note';
  const head = document.createElement('div');
  head.className = 'ag-note-head';
  const n = countNodes(d.outline);
  head.innerHTML = `<strong>${d.title || '思维导图'}</strong>
    <span class="status">${n} 个节点</span>`;
  const pre = document.createElement('pre');
  pre.className = 'ag-outline';
  pre.textContent = toOutlineText(d.outline);
  const bar = document.createElement('div');
  bar.className = 'row end';
  const draw = document.createElement('button');
  draw.className = 'btn primary';
  draw.textContent = '画成导图';
  draw.onclick = () => {
    closeDlg();
    document.querySelector('.tab[data-tab="map"]').click();
    try { mapMod.show(d.outline, `电脑生成：${n} 个节点`); } catch (e) { /* 忽略 */ }
  };
  bar.appendChild(draw);
  box.appendChild(head);
  box.appendChild(pre);
  box.appendChild(bar);
  showPreview('');
  $('agPrev').appendChild(box);
}

function countNodes(root) {
  let n = 0;
  const walk = (x) => { n += 1; (x.children || []).forEach(walk); };
  if (root) walk(root);
  return n;
}

function toOutlineText(root, depth) {
  const d = depth || 0;
  let s = '  '.repeat(d) + '- ' + root.topic + '\n';
  for (const c of root.children || []) s += toOutlineText(c, d + 1);
  return s;
}

async function go() {
  if (busy) return;
  const ins = ($('agIns').value || '').trim();
  if (!picked.size && !ins) { setStatus('写一句指令，或选几个语料文件', true); return; }
  if (!baseUrl()) { setStatus('还没填电脑地址：设置 →「电脑 Agent」', true); return; }
  busy = true;
  const btn = $('agGo');
  btn.disabled = true;
  $('agPrev').hidden = true;
  setStatus(picked.size
    ? `正在让电脑读 ${picked.size} 个文件并生成…（大文件会久一点）`
    : '正在让电脑生成…');
  try {
    const d = await api('/generate', {
      method: 'POST',
      body: {
        instruction: ins,
        files: [...picked.keys()],
        kind: $('agKind').value,
        title: '',
      },
    });
    last = d;
    setStatus(`生成完了（${(d.ms / 1000).toFixed(1)} 秒）`);
    if (d.kind === 'map') previewMap(d); else previewNote(d);
  } catch (e) {
    setStatus(String(e.message || e), true);
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

function closeDlg() {
  const d = $('dlgAgent');
  if (d && d.open) d.close();
}

export function openAgent() {
  const d = $('dlgAgent');
  if (!d) return;
  picked = new Map();
  last = null;
  renderChosen();
  $('agPrev').hidden = true;
  $('agPrev').innerHTML = '';
  $('agIns').value = '';
  $('agKind').value = 'note';
  setStatus('');
  d.showModal();
  if (!baseUrl()) {
    setStatus('先去「设置 → 电脑 Agent」填电脑地址和口令', true);
    return;
  }
  doPing().then((ok) => { if (ok) { loadFiles(''); refreshInbox(); } });
}

export function initAgent(nb, mp) {
  notebook = nb;
  mapMod = mp;

  $('btnAgent').onclick = () => openAgent();
  $('agX').onclick = closeDlg;
  $('agClose').onclick = closeDlg;
  $('agGo').onclick = go;
  $('agInboxBtn').onclick = pullInbox;
  $('agPing').onclick = async () => {
    const d = await doPing();
    if (d) loadFiles(curDir);
  };
  $('agReload').onclick = () => loadFiles(curDir);
  $('agUp').onclick = () => {
    if (!curDir) { setStatus('已经在最上层了', true); return; }
    const parent = curDir.split('/').slice(0, -1).join('/');
    loadFiles(parent);
  };
  $('agKind').onchange = () => { $('agPrev').hidden = true; };

  /* 设置里的「电脑 Agent」：测试连接 */
  $('cfgAgTest').onclick = async () => {
    const st = $('cfgAgStatus');
    const url = ($('cfgAgUrl').value || '').trim();
    const token = ($('cfgAgToken').value || '').trim();
    if (!url) { st.className = 'status bad'; st.textContent = '先填地址，例如 http://192.168.1.5:8787'; return; }
    st.className = 'status';
    st.textContent = '正在连…';
    const keep = { url: cfg.url, token: cfg.token };
    cfg.url = url; cfg.token = token;
    try {
      const d = await ping();
      st.textContent = `连上了：${d.rootName || d.root} · ${d.model || '未配模型'}`;
    } catch (e) {
      cfg.url = keep.url; cfg.token = keep.token;
      st.className = 'status bad';
      st.textContent = '连不上：' + (e.message || e);
    }
  };

  return { open: openAgent, ping, getCfg: getAgentCfg, setCfg: setAgentCfg };
}
