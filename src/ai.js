/* AI adapter：任意 OpenAI 兼容接口（含 ollama 的 /v1）
   配置存在 localStorage.kynb_ai = { baseUrl, apiKey, model, vision }
*/
const LS_AI = 'kynb_ai';

export function getCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(LS_AI) || '{}'); } catch (e) { c = {}; }
  return {
    baseUrl: (c.baseUrl || '').trim(),
    apiKey: (c.apiKey || '').trim(),
    model: (c.model || '').trim(),
    vision: !!c.vision,
  };
}

export function setCfg(c) {
  localStorage.setItem(LS_AI, JSON.stringify({
    baseUrl: (c.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: (c.apiKey || '').trim(),
    model: (c.model || '').trim(),
    vision: !!c.vision,
  }));
}

export function cfgOk() {
  const c = getCfg();
  return !!(c.baseUrl && c.model);
}

function endpointOf(baseUrl) {
  let u = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/api\/chat$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

/**
 * 调一次对话。image 传 dataURL（可选）。
 * 返回 Promise<string>（模型输出的纯文本）
 */
export async function chat({ system, prompt, image, temperature = 0.2, maxTokens = 2000 }) {
  const c = getCfg();
  if (!c.baseUrl || !c.model) throw new Error('还没配置 AI 接口（点右上角「设置」填 Base URL / Key / 模型）');

  const content = [];
  if (image) {
    if (!c.vision) throw new Error('当前模型标记为「不支持看图」；在设置里勾上「支持看图」，或换一个视觉模型');
    content.push({ type: 'image_url', image_url: { url: image } });
  }
  content.push({ type: 'text', text: prompt || '' });

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: content.length === 1 && !image ? content[0].text : content });

  const url = endpointOf(c.baseUrl);
  const body = {
    model: c.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (c.apiKey) headers.Authorization = 'Bearer ' + c.apiKey;
  // OpenCode Go 需要会话头（其它 OpenAI 兼容服务通常忽略它）
  if (/opencode\.ai/i.test(url)) {
    headers['x-opencode-session'] =
      (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'kynb-' + Date.now().toString(36));
  }

  let res;
  let txt;
  const tryPost = async (u) => {
    const r = await fetch(u, { method: 'POST', headers, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, txt: await r.text() };
  };
  try {
    const r = await tryPost(url);
    res = { ok: r.ok, status: r.status };
    txt = r.txt;
  } catch (e) {
    // 直连被拦（CORS / 网络）时，退回本机 serve.py 的 /proxy?u=
    const hint = e && e.message ? e.message : String(e);
    if (!/^https?:$/.test(location.protocol)) {
      throw new Error('请求失败：' + hint + '（检查网络 / 该接口是否允许浏览器直连 CORS）');
    }
    const via = location.origin + '/proxy?u=' + encodeURIComponent(url);
    try {
      const r = await tryPost(via);
      res = { ok: r.ok, status: r.status };
      txt = r.txt;
    } catch (e2) {
      throw new Error('请求失败：' + hint + '（直连被 CORS 拦、本地代理也没通：用 python serve.py 启动，或换允许跨域的接口）');
    }
  }
  if (!res.ok) {
    let detail = txt.slice(0, 300);
    try {
      const j = JSON.parse(txt);
      detail = (j.error && (j.error.message || j.error.code)) || j.message || detail;
    } catch (e) { /* 保持原文 */ }
    throw new Error(`接口返回 ${res.status}：${detail}`);
  }
  let json;
  try { json = JSON.parse(txt); } catch (e) { throw new Error('接口返回的不是 JSON：' + txt.slice(0, 200)); }

  // OpenAI 风格
  const ch = json.choices && json.choices[0];
  if (ch) {
    const m = ch.message || ch.delta || {};
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map((x) => x.text || '').join('') : (ch.text || '');
    const trimmed = text.trim();
    if (trimmed) return trimmed;
    // 空输出：多半是「思考 token」把 max_tokens 吃光了（推理型模型常见）
    if (ch.finish_reason === 'length') {
      throw new Error('模型输出被 max_tokens 截断（这类模型会先花 token 思考）；调大 max_tokens 或换非推理模型');
    }
    throw new Error('模型返回了空内容（可能是推理型模型把预算耗在思考上，或该请求被内容策略拦下）');
  }
  // ollama /api/chat 风格
  if (json.message && typeof json.message.content === 'string') return json.message.content.trim();
  if (typeof json.response === 'string') return json.response.trim();
  throw new Error('认不出这个接口的返回格式：' + txt.slice(0, 200));
}
