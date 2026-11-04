/* 极简 IndexedDB 封装：notes / pages / groups / meta 四个 store
   notes:  { id, title, kind, star, createdAt, updatedAt, pageCount, thumb, groupId?, src? }
   pages:  { id: `${noteId}#${no}`, noteId, no, template, strokes: [], bg: dataURL|null }
   groups: { id, name, order, createdAt }   —— 单层分组：一本笔记最多属于一个组（Joplin 的 notebook 模型）
*/
const DB_NAME = 'kynb';
const DB_VER = 2;
let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('pages')) {
        const p = db.createObjectStore('pages', { keyPath: 'id' });
        p.createIndex('noteId', 'noteId');
      }
      /* v2：分组。只加新表，已有 notes/pages 原样保留 */
      if (!db.objectStoreNames.contains('groups')) {
        const g = db.createObjectStore('groups', { keyPath: 'id' });
        g.createIndex('order', 'order');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const store = {
  async allNotes() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('notes', 'readonly');
      const r = t.objectStore('notes').getAll();
      r.onsuccess = () => {
        const list = r.result || [];
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(list);
      };
      r.onerror = () => reject(r.error);
    });
  },
  putNote(n) { return tx('notes', 'readwrite', (s) => s.put(n)); },
  getNote(id) { return tx('notes', 'readonly', (s) => s.get(id)); },
  delNote(id) {
    return Promise.all([
      tx('notes', 'readwrite', (s) => s.delete(id)),
      this.delPages(id),
    ]);
  },
  async pagesOf(noteId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('pages', 'readonly');
      const idx = t.objectStore('pages').index('noteId');
      const r = idx.getAll(IDBKeyRange.only(noteId));
      r.onsuccess = () => {
        const list = (r.result || []).sort((a, b) => a.no - b.no);
        resolve(list);
      };
      r.onerror = () => reject(r.error);
    });
  },
  putPage(p) { return tx('pages', 'readwrite', (s) => s.put(p)); },
  async delPages(noteId) {
    const list = await this.pagesOf(noteId);
    await Promise.all(list.map((p) => tx('pages', 'readwrite', (s) => s.delete(p.id))));
  },
  /* ---------- 分组 ---------- */
  async allGroups() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction('groups', 'readonly');
      const r = t.objectStore('groups').getAll();
      r.onsuccess = () => {
        const list = r.result || [];
        list.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0));
        resolve(list);
      };
      r.onerror = () => reject(r.error);
    });
  },
  putGroup(g) { return tx('groups', 'readwrite', (s) => s.put(g)); },
  delGroup(id) { return tx('groups', 'readwrite', (s) => s.delete(id)); },

  async clearAll() {
    await tx('notes', 'readwrite', (s) => s.clear());
    await tx('pages', 'readwrite', (s) => s.clear());
    await tx('groups', 'readwrite', (s) => s.clear());
  },
};

export const uid = (p) => (p || 'n') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const fmtTime = (ts) => {
  const d = new Date(ts || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
