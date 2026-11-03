/* 提示词预设：用户可自己写、自己改
   localStorage.kynb_prompts = [{ id, name, system, body }]
*/
const LS = 'kynb_prompts';

export const DEFAULT_PROMPTS = [
  {
    id: 'p_solve',
    name: '题目解析（分题作答）',
    system: '你是一位耐心的考研辅导老师，擅长把题讲清楚。',
    body: '请把图中的题目逐题抄下来（题号保持原样，公式用 LaTeX：行内 $...$，独立公式 $$...$$），'
      + '然后对每一题给出：① 考点 ② 思路（分步骤） ③ 最终答案。不要臆造题目里没有的条件。',
  },
  {
    id: 'p_copy',
    name: '只抄题（不解答）',
    system: '',
    body: '把图中内容转成 Markdown：题目按题号分段，公式用 $$...$$，表格用管道表；不要写答案、不要解说。',
  },
  {
    id: 'p_latex',
    name: '公式 → LaTeX',
    system: '',
    body: '把图中出现的所有公式按出现顺序转写成 LaTeX（独立公式用 $$...$$），只输出公式，不要解释。',
  },
  {
    id: 'p_trans',
    name: '整页翻译（一句原文一句译文）',
    system: '你是学术翻译，译文准确、自然，公式与变量保留原文。',
    body: '把图中文字按段落翻译成简体中文：先原样输出一段原文，再在下一行给出译文；公式保留原样。',
  },
  {
    id: 'p_struct',
    name: '整页结构化（论文 / 讲义）',
    system: '',
    body: '把这一页转成结构化 Markdown：标题用 #/##，段落按阅读顺序，公式用 $$...$$，表格用管道表，图片位置标注 [图片]。不要解说。',
  },
  {
    id: 'p_self',
    name: '自定义（用下面的补充要求）',
    system: '',
    body: '',
  },
];

export function getPrompts() {
  let list = null;
  try { list = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { list = null; }
  if (!Array.isArray(list) || !list.length) list = DEFAULT_PROMPTS.map((p) => ({ ...p }));
  return list;
}

export function setPrompts(list) {
  localStorage.setItem(LS, JSON.stringify(list));
}

export function resetPrompts() {
  localStorage.removeItem(LS);
  return getPrompts();
}

export function promptById(id) {
  return getPrompts().find((p) => p.id === id) || null;
}

/** 组合成真正发给模型的内容 */
export function composePrompt(p, extra) {
  const body = (p && p.body ? p.body : '').trim();
  const ex = (extra || '').trim();
  if (body && ex) return body + '\n\n补充要求：' + ex;
  return body || ex;
}
