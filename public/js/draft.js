const DB_NAME = 'quote-draft';
const STORE = 'files';
const FIELDS_KEY = 'quote-draft-fields';
// Never block the page on the draft: some browsers (e.g. Safari private
// windows) can't keep files in IndexedDB and leave requests hanging.
const LOAD_TIMEOUT_MS = 5000;

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function saveFields(fields) {
  try {
    sessionStorage.setItem(FIELDS_KEY, JSON.stringify(fields));
  } catch (err) {
    console.warn('draft save fields failed', err);
  }
}

export function loadFields() {
  try {
    const raw = sessionStorage.getItem(FIELDS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveFiles(files) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      const store = tx.objectStore(STORE);
      store.clear();
      for (let i = 0; i < files.length; i++) store.put(files[i], i);
    });
  } catch (err) {
    console.warn('draft save files failed', err);
  }
}

export async function loadFiles() {
  try {
    const db = await openIdb();
    const read = new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const out = [];
      const cursorReq = tx.objectStore(STORE).openCursor();
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { out.push(cur.value); cur.continue(); }
        else resolve(out);
      };
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve([]), LOAD_TIMEOUT_MS));
    return await Promise.race([read, timeout]);
  } catch {
    return [];
  }
}

export async function clearDraft() {
  try {
    sessionStorage.removeItem(FIELDS_KEY);
    const db = await openIdb();
    const clear = new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
      tx.objectStore(STORE).clear();
    });
    await Promise.race([clear, new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS))]);
  } catch {}
}
