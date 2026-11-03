/* 拍题：选图 / 拍照 → 用你配置的 AI（含自定义提示词）解析 */
import { chat, cfgOk } from './ai.js';
import { getPrompts, composePrompt, promptById } from './prompts.js';
import { mdInto, tidyAI } from './md.js';
import { imageToDataUrl, loadImageFile } from './inkboard.js';

export function initShot(notebook) {
  const $ = (id) => document.getElementById(id);
  const drop = $('shotDrop');
  const empty = $('shotEmpty');
  const prev = $('shotPreview');
  const out = $('shotOut');
  const status = $('shotStatus');
  const promptSel = $('shotPrompt');
  const custom = $('shotCustom');
  const fileInput = $('shotFile');

  const st = { dataUrl: '', name: '' };

  /* ---------- 提示词下拉 ---------- */
  function fillPrompts() {
    const list = getPrompts();
    promptSel.innerHTML = '';
    list.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      promptSel.appendChild(o);
    });
    const last = localStorage.getItem('kynb_shot_prompt');
    if (last && list.some((p) => p.id === last)) promptSel.value = last;
  }
  fillPrompts();
  promptSel.onchange = () => localStorage.setItem('kynb_shot_prompt', promptSel.value);
  window.__kynbFillPrompts = fillPrompts;

  /* ---------- 图片 ---------- */
  function setImage(dataUrl, name) {
    st.dataUrl = dataUrl;
    st.name = name || '';
    prev.src = dataUrl;
    prev.hidden = false;
    empty.hidden = true;
    drop.classList.remove('over');
  }

  function clearImage() {
    st.dataUrl = '';
    st.name = '';
    prev.removeAttribute('src');
    prev.hidden = true;
    empty.hidden = false;
    out.innerHTML = '<div class="ph">识别结果会出现在这里。你可以把解答当作草稿，再在笔记本里写自己的推导。</div>';
    status.textContent = '';
  }

  async function takeFile(file) {
    if (!file) return;
    try {
      const img = await loadImageFile(file);
      setImage(imageToDataUrl(img, 1600, 0.86), file.name);
    } catch (e) {
      status.textContent = e.message || String(e);
    }
  }

  $('shotPick').onclick = () => { fileInput.value = ''; fileInput.click(); };
  fileInput.onchange = () => takeFile(fileInput.files && fileInput.files[0]);
  $('shotClear').onclick = clearImage;

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (ev === 'drop' && e.dataTransfer.files && e.dataTransfer.files[0]) takeFile(e.dataTransfer.files[0]);
  }));
  drop.addEventListener('click', () => { if (!st.dataUrl) $('shotPick').click(); });

  /* ---------- 相机 ---------- */
  $('shotCam').onclick = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const f = fileInput;
      f.setAttribute('capture', 'environment');
      f.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const box = document.createElement('div');
      box.className = 'cam';
      box.innerHTML = '<video playsinline autoplay muted></video><div class="row"><button class="btn primary" id="camSnap">拍下</button><button class="btn ghost" id="camCancel">取消</button></div>';
      drop.appendChild(box);
      const v = box.querySelector('video');
      v.srcObject = stream;
      const stop = () => { stream.getTracks().forEach((t) => t.stop()); box.remove(); };
      box.querySelector('#camCancel').onclick = stop;
      box.querySelector('#camSnap').onclick = () => {
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        setImage(c.toDataURL('image/jpeg', 0.86), 'camera.jpg');
        stop();
      };
    } catch (e) {
      status.textContent = '打不开相机：' + (e.message || e);
    }
  };

  /* ---------- 问 AI ---------- */
  $('shotAsk').onclick = async () => {
    if (!st.dataUrl) { status.textContent = '先选一张题目图片'; return; }
    if (!cfgOk()) { status.textContent = '还没配置 AI 接口（右上角「设置」）'; return; }
    const p = promptById(promptSel.value) || { name: '', system: '', body: '' };
    const prompt = composePrompt(p, custom.value);
    if (!prompt.trim()) { status.textContent = '这条提示词是空的，写点要求或换个提示词'; return; }

    $('shotAsk').disabled = true;
    status.textContent = 'AI 思考中…（' + p.name + '）';
    out.innerHTML = '<div class="ph">正在解析…</div>';
    const t0 = Date.now();
    try {
      const text = await chat({
        system: p.system || '你是一个严谨的助手，只根据图片内容作答。',
        prompt,
        image: st.dataUrl,
        temperature: 0.2,
        maxTokens: 3000,
      });
      await mdInto(out, tidyAI(text));
      status.textContent = `完成 · ${((Date.now() - t0) / 1000).toFixed(1)} s · ${p.name}`;
    } catch (e) {
      out.innerHTML = `<div class="ph">出错了：${escapeHtml(e.message || e)}</div>`;
      status.textContent = '失败';
    } finally {
      $('shotAsk').disabled = false;
    }
  };

  $('shotCopy').onclick = async () => {
    const txt = out.innerText || '';
    try { await navigator.clipboard.writeText(txt); status.textContent = '已复制'; } catch (e) { status.textContent = '复制失败'; }
  };

  $('shotToNote').onclick = async () => {
    if (!st.dataUrl) { status.textContent = '先选一张图片'; return; }
    if (!notebook) return;
    await notebook.addBgPage(st.dataUrl, st.name ? st.name.replace(/\.[^.]+$/, '') : '拍题笔记');
    document.querySelector('.tab[data-tab="ink"]').click();
    status.textContent = '已存为一页笔记底图';
  };

  return { fillPrompts, clearImage };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
