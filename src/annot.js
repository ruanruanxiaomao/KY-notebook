/* 图片 / PDF 批注：导入 → 在页面上写字 → 导出 / 让 AI 解析本页 */
import { InkBoard, imageToDataUrl, loadImageFile } from './inkboard.js';
import { chat, cfgOk } from './ai.js';
import { getPrompts, composePrompt, promptById } from './prompts.js';
import { mdInto, tidyAI } from './md.js';

export function initAnnot() {
  const $ = (id) => document.getElementById(id);
  const board = new InkBoard($('annotCv'), $('annotPaper'), $('annotStage'));
  const st = { pages: [], idx: 0, zoom: 1, kind: '' };
  $('annotBg').hidden = true;

  board.onChange = () => { if (st.pages[st.idx]) st.pages[st.idx].strokes = board.getStrokes(); };

  /* ---------- 提示词下拉 ---------- */
  function fillPrompts() {
    const list = getPrompts();
    const sel = $('annotPrompt');
    sel.innerHTML = '';
    list.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    const last = localStorage.getItem('kynb_annot_prompt');
    if (last && list.some((p) => p.id === last)) sel.value = last;
  }
  fillPrompts();
  $('annotPrompt').onchange = () => localStorage.setItem('kynb_annot_prompt', $('annotPrompt').value);
  window.__kynbFillAnnotPrompts = fillPrompts;

  /* ---------- 载入 ---------- */
  function setPages(pages, kind) {
    st.pages = pages;
    st.idx = 0;
    st.kind = kind;
    showPage(0);
  }

  function showPage(i) {
    if (!st.pages.length) return;
    st.idx = Math.max(0, Math.min(st.pages.length - 1, i));
    const p = st.pages[st.idx];
    board.setZoom(st.zoom);
    board.loadPage({ template: 'blank', bg: p.bg, strokes: p.strokes || [] });
    board.zoom = st.zoom;
    board.layout();
    $('annotPageInfo').textContent = `${st.idx + 1} / ${st.pages.length}`;
  }

  async function pickImage(file) {
    try {
      const img = await loadImageFile(file);
      setPages([{ bg: imageToDataUrl(img, 1800, 0.88), strokes: [] }], 'image');
      $('annotStatus').textContent = '已载入图片，可以直接写';
    } catch (e) { $('annotStatus').textContent = e.message || String(e); }
  }

  async function pickPdf(file) {
    const lib = window.pdfjsLib;
    if (!lib) { $('annotStatus').textContent = 'pdf.js 还没加载好（需要联网一次）'; return; }
    $('annotStatus').textContent = '正在解析 PDF…';
    try {
      const buf = await file.arrayBuffer();
      lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
      const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min(2.2, 1800 / vp0.width);
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width);
        c.height = Math.round(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        pages.push({ bg: c.toDataURL('image/jpeg', 0.85), strokes: [] });
        $('annotStatus').textContent = `正在解析 PDF… ${i}/${pdf.numPages}`;
      }
      setPages(pages, 'pdf');
      $('annotStatus').textContent = `已载入 ${pages.length} 页，可以直接写`;
    } catch (e) {
      $('annotStatus').textContent = 'PDF 打开失败：' + (e.message || e);
    }
  }

  $('annotPickImg').onclick = () => { $('annotFileImg').value = ''; $('annotFileImg').click(); };
  $('annotFileImg').onchange = () => pickImage($('annotFileImg').files && $('annotFileImg').files[0]);
  $('annotPickPdf').onclick = () => { $('annotFilePdf').value = ''; $('annotFilePdf').click(); };
  $('annotFilePdf').onchange = () => pickPdf($('annotFilePdf').files && $('annotFilePdf').files[0]);

  /* ---------- 翻页 / 缩放 ---------- */
  $('annotPrev').onclick = () => { if (st.idx > 0) showPage(st.idx - 1); };
  $('annotNext').onclick = () => { if (st.idx < st.pages.length - 1) showPage(st.idx + 1); };
  $('annotZoomIn').onclick = () => { st.zoom = Math.min(3, st.zoom + 0.15); board.setZoom(st.zoom); $('annotZoomInfo').textContent = Math.round(st.zoom * 100) + '%'; };
  $('annotZoomOut').onclick = () => { st.zoom = Math.max(0.4, st.zoom - 0.15); board.setZoom(st.zoom); $('annotZoomInfo').textContent = Math.round(st.zoom * 100) + '%'; };

  /* ---------- AI 解析本页 ---------- */
  $('annotAsk').onclick = async () => {
    if (!st.pages.length) { $('annotStatus').textContent = '先导入图片或 PDF'; return; }
    if (!cfgOk()) { $('annotStatus').textContent = '还没配置 AI 接口（右上角「设置」）'; return; }
    const p = promptById($('annotPrompt').value) || { name: '', system: '', body: '' };
    const prompt = composePrompt(p, '');
    if (!prompt.trim()) { $('annotStatus').textContent = '这条提示词是空的'; return; }
    const img = st.pages[st.idx].bg;
    $('annotAsk').disabled = true;
    $('annotStatus').textContent = 'AI 解析中…（' + p.name + '）';
    $('annotOut').innerHTML = '<div class="ph">正在解析…</div>';
    const t0 = Date.now();
    try {
      const text = await chat({
        system: p.system || '你是一个严谨的助手，只根据图片内容作答。',
        prompt,
        image: img,
        maxTokens: 3000,
      });
      await mdInto($('annotOut'), tidyAI(text));
      $('annotStatus').textContent = `完成 · ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    } catch (e) {
      $('annotOut').innerHTML = `<div class="ph">出错了：${escapeHtml(e.message || e)}</div>`;
      $('annotStatus').textContent = '失败';
    } finally {
      $('annotAsk').disabled = false;
    }
  };

  /* ---------- 导出 ---------- */
  $('annotExportPng').onclick = async () => {
    if (!st.pages.length) return;
    const url = await board.exportPng(2);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annot-p${st.idx + 1}.png`;
    a.click();
  };

  $('annotExportJson').onclick = () => {
    if (!st.pages.length) return;
    const data = {
      app: 'KY-notebook', version: 1, kind: st.kind,
      pages: st.pages.map((p, i) => ({ no: i, w: 1414, h: 1000, strokes: p.strokes || [] })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'annot.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  window.addEventListener('resize', () => board.layout());

  return { fillPrompts };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
