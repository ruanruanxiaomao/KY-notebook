/* 思维导图页：主题 + 素材 → AI 出大纲 → 解析成树 → SVG 渲染
   - 只让模型输出缩进列表，解析失败就明确报错，不猜
   - 出图后可以导出 PNG / SVG、复制大纲、存成一本笔记本里的图片页
*/
import { chat, cfgOk } from './ai.js';
import { parseOutline, renderMap, toOutline } from './mindmap.js';
import { noteSink } from './notebook.js';

const DEMO = `考研数学三
  - 高等数学
    - 极限与连续
    - 一元微分学
    - 一元积分学
  - 线性代数
    - 行列式与矩阵
    - 向量组与秩
    - 特征值与二次型
  - 概率论与数理统计
    - 随机变量及分布
    - 数字特征
    - 大数定律与中心极限定理`;

export function initMap() {
  const $ = (id) => document.getElementById(id);
  const topicEl = $('mapTopic');
  const matEl = $('mapMaterial');
  const depthEl = $('mapDepth');
  const genBtn = $('mapGen');
  const demoBtn = $('mapDemo');
  const statusEl = $('mapStatus');
  const canvas = $('mapCanvas');
  const emptyEl = $('mapEmpty');

  let view = null;

  function setStatus(msg, bad) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (bad ? ' bad' : '');
  }

  function show(root, tip) {
    if (!root) { setStatus('没解析出结构：让模型按「- 缩进」输出，或点「示例」先看看格式。', true); return false; }
    emptyEl.hidden = true;
    if (view) view.setRoot(root);
    else view = renderMap(canvas, root);
    if (tip) setStatus(tip);
    return true;
  }

  function promptFor(topic, material, depth) {
    const sys = '你是一位把知识整理成树状结构的助手。你只输出层级大纲，绝不解释、不寒暄。';
    const p = [
      `中心主题：${topic}`,
      material.trim() ? `素材：\n${material.trim().slice(0, 6000)}` : '',
      '要求：',
      `1. 用「- 」开头表示节点，缩进两个空格表示下一层；`,
      `2. 最多 ${depth} 层（中心主题算第 1 层），同一层 3~6 个节点；`,
      '3. 每个节点尽量不超过 14 个字，抓住关键词而不是整句；',
      '4. 只输出大纲本身，不要代码块、不要标题、不要任何解释。',
    ].filter(Boolean).join('\n');
    return { sys, p };
  }

  genBtn.onclick = async () => {
    const topic = topicEl.value.trim();
    if (!topic) { setStatus('先写一个中心主题', true); topicEl.focus(); return; }
    if (!cfgOk()) { setStatus('还没配置 AI 接口：点右上角「设置」填 Base URL / Key / 模型', true); return; }

    genBtn.disabled = true;
    setStatus('正在让 AI 生成…（长素材会久一点）');
    try {
      const { sys, p } = promptFor(topic, matEl.value, depthEl.value);
      const text = await chat({ system: sys, prompt: p, temperature: 0.3, maxTokens: 1200 });
      const root = parseOutline(text, topic);
      if (!root) {
        setStatus('AI 返回的内容不像大纲，没敢画。原始内容已放到「素材」里，可以改一下再试。', true);
        matEl.value = String(text).slice(0, 6000);
        return;
      }
      show(root, `已生成：${countNodes(root)} 个节点（点节点可折叠/展开，滚轮缩放）`);
    } catch (e) {
      setStatus('生成失败：' + (e && e.message ? e.message : e), true);
    } finally {
      genBtn.disabled = false;
    }
  };

  demoBtn.onclick = () => {
    const root = parseOutline(DEMO, '思维导图');
    if (!topicEl.value.trim()) topicEl.value = '考研数学三';
    show(root, '这是示例：点节点折叠/展开，滚轮缩放，拖空白处平移');
  };

  $('mapFit').onclick = () => { if (view) view.fit(); };

  $('mapExportSvg').onclick = () => {
    if (!view) { setStatus('先画一张导图再导出', true); return; }
    download(new Blob([view.exportSvg()], { type: 'image/svg+xml;charset=utf-8' }),
      safeName(topicEl.value) + '.svg');
    setStatus('已导出 SVG');
  };

  $('mapExportPng').onclick = async () => {
    if (!view) { setStatus('先画一张导图再导出', true); return; }
    const url = await view.exportPng(2);
    download(dataUrlToBlob(url), safeName(topicEl.value) + '.png');
    setStatus('已导出 PNG（2× 分辨率）');
  };

  $('mapCopy').onclick = async () => {
    if (!view) { setStatus('先画一张导图再复制', true); return; }
    const md = toOutline(view.getRoot());
    try {
      await navigator.clipboard.writeText(md);
      setStatus('大纲已复制（markdown 缩进列表）');
    } catch (e) {
      matEl.value = md;
      setStatus('浏览器不让写剪贴板，已把大纲放进「素材」框里', true);
    }
  };

  $('mapToNote').onclick = async () => {
    if (!view) { setStatus('先画一张导图再存', true); return; }
    const sink = noteSink();
    if (!sink) { setStatus('笔记模块还没准备好', true); return; }
    const url = await view.exportPng(2);
    const title = (topicEl.value.trim() || '思维导图') + ' · 导图';
    await sink.addBgNote(url, title, { kind: 'map', name: topicEl.value.trim() || '思维导图', page: 1 }, []);
    document.querySelector('.tab[data-tab="ink"]').click();   /* 存完直接跳过去看，别留在看不见的地方 */
    setStatus('已存进笔记本（图片页，可以继续手写补充）');
  };

  /* PDF 批注页「本页文字」可以一键送进来当素材 */
  window.__kynbMapFeed = (text, t) => {
    matEl.value = String(text || '').slice(0, 6000);
    if (t && !topicEl.value.trim()) topicEl.value = String(t).slice(0, 20);
    setStatus('已带入文字素材，填个主题就能生成');
    document.querySelector('.tab[data-tab="map"]').click();
  };

  return { show, get view() { return view; } };
}

function countNodes(root) {
  let n = 0;
  const walk = (x) => { n += 1; (x.children || []).forEach(walk); };
  walk(root);
  return n;
}

function safeName(s) {
  return (String(s || '思维导图').trim() || '思维导图').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

function dataUrlToBlob(url) {
  const [head, body] = String(url).split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'image/png';
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
