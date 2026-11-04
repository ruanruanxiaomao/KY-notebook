/* 手写笔记 JSON 的读写（纯数据层：不碰 DOM，也不碰 IndexedDB）
   结构：{ app:'KY-notebook', v:1, exportedAt:'ISO 时间',
          note:{ title, star, createdAt, src? }, pages:[{ no, template, bg, strokes }] }
   - 导入只认 v（更早的导出把版本号写在 version 里，一并兼容）
   - 校验失败一律返回 { ok:false, error }，不抛异常，调用方直接拿去提示
   - bg 有两种：false（不导底图，默认）或 data:image/... 字符串（勾了「包含底图」）
   - note.src = { kind:'pdf'|'img'|'shot', name, page } 是 M2 加的可选字段，老文件没有也能导入
*/
export const SCHEMA_V = 1;

const TEMPLATES = ['blank', 'lines', 'grid', 'dots'];
const TOOLS = ['pen', 'hl', 'er'];
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const BG_RE = /^data:image\/(png|jpe?g|webp|gif)/i;
const SRC_KINDS = ['pdf', 'img', 'shot'];

const bad = (error) => ({ ok: false, error });

/** 只保留认识的来源字段；不合法就当没有 */
function readSrc(n) {
  const s = n && typeof n === 'object' ? n.src : null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const kind = SRC_KINDS.includes(s.kind) ? s.kind : '';
  if (!kind) return null;
  const name = typeof s.name === 'string' ? s.name.slice(0, 200) : '';
  const page = Number.isInteger(s.page) && s.page > 0 ? s.page : 0;
  return { kind, name, page };
}

/** 组装导出的 JSON 对象（note 里不含 thumb：导入用不上，留着只是白占体积） */
export function buildNoteJson(note, pages) {
  const meta = {
    title: note.title || '',
    star: note.star ? 1 : 0,
    createdAt: note.createdAt || Date.now(),
    pageCount: pages.length,
  };
  if (note.kind) meta.kind = note.kind;
  if (typeof note.md === 'string') meta.md = note.md;   /* 文字笔记的正文 */
  const src = readSrc(note);
  if (src) meta.src = src;
  return {
    app: 'KY-notebook',
    v: SCHEMA_V,
    version: 1,           // 旧字段，留着让老版本读得动
    exportedAt: new Date().toISOString(),
    note: meta,
    pages,
  };
}

/** 解析 + 校验；成功返回 { ok:true, title, star, createdAt, pages }，pages 的 no 从 0 重排 */
export function parseNoteJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return bad('不是合法的 JSON 文件');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bad('JSON 顶层不是对象');
  if (data.app && data.app !== 'KY-notebook') return bad('这不是 KY-notebook 的笔记文件');

  const v = data.v === undefined ? data.version : data.v;
  if (v === undefined || v === null) return bad('缺少版本号（v）');
  if (!Number.isInteger(v) || v < 1) return bad(`版本号不合法：${v}`);
  if (v > SCHEMA_V) return bad(`文件是 v=${v}，当前只认到 v=${SCHEMA_V}，请换新版本再导入`);

  const n = data.note && typeof data.note === 'object' && !Array.isArray(data.note) ? data.note : {};
  const isMd = n.kind === 'md' && typeof n.md === 'string';
  if (!isMd && (!Array.isArray(data.pages) || !data.pages.length)) {
    return bad('没有 pages（或 pages 是空的）');
  }

  const pages = [];
  const pageList = isMd ? [] : data.pages;
  for (let i = 0; i < pageList.length; i++) {
    const pg = pageList[i];
    const at = `第 ${i + 1} 页`;
    if (!pg || typeof pg !== 'object' || Array.isArray(pg)) return bad(`${at}不是对象`);
    if (pg.strokes !== undefined && !Array.isArray(pg.strokes)) return bad(`${at}的 strokes 不是数组`);

    const raw = pg.strokes || [];
    const strokes = [];
    for (let j = 0; j < raw.length; j++) {
      const st = raw[j];
      const where = `${at}第 ${j + 1} 笔`;
      if (!st || typeof st !== 'object' || Array.isArray(st)) return bad(`${where}不是对象`);
      if (!TOOLS.includes(st.t)) return bad(`${where}的类型 t 不认识`);
      if (typeof st.c !== 'string' || !COLOR_RE.test(st.c)) return bad(`${where}的颜色 c 不是 #rrggbb`);
      if (typeof st.w !== 'number' || !isFinite(st.w) || st.w <= 0 || st.w > 100) return bad(`${where}的粗细 w 不对`);
      const pts = st.pts;
      const ptsOk = Array.isArray(pts) && pts.length >= 3 && pts.length % 3 === 0
        && pts.every((n) => typeof n === 'number' && isFinite(n));
      if (!ptsOk) return bad(`${where}的坐标 pts 不对（应是 3 的倍数的数字数组）`);
      strokes.push({ t: st.t, c: st.c, w: st.w, pts: pts.slice() });
    }

    pages.push({
      no: pages.length,
      template: TEMPLATES.includes(pg.template) ? pg.template : 'blank',
      strokes,
      /* 只有 data:image 的字符串才算底图；老文件的 bg:true/false 一律当没有 */
      bg: typeof pg.bg === 'string' && BG_RE.test(pg.bg) ? pg.bg : null,
    });
  }

  const title = typeof n.title === 'string' ? n.title.trim() : '';
  const createdAt = typeof n.createdAt === 'number' && isFinite(n.createdAt) ? n.createdAt : Date.now();
  return {
    ok: true, kind: isMd ? 'md' : 'ink', md: isMd ? n.md : '',
    title, star: n.star ? 1 : 0, createdAt, src: readSrc(n), pages,
  };
}
