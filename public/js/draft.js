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
    req.onblocked = () => reject(new Error('draft database blocked'));
  });
}

const TIMED_OUT = Symbol('timed out');
// Resolves to TIMED_OUT if fn() (opening the database included) hangs.
function withTimeout(fn) {
  return Promise.race([
    fn(),
    new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), LOAD_TIMEOUT_MS)),
  ]);
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

// Saved files, [] when there are none, or null when they could not be read in
// time (the caller should not assume the draft had no files).
export async function loadFiles() {
  try {
    const files = await withTimeout(async () => {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
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
    });
    return files === TIMED_OUT ? null : files;
  } catch {
    return [];
  }
}

export async function clearDraft() {
  try {
    sessionStorage.removeItem(FIELDS_KEY);
    await withTimeout(async () => {
      const db = await openIdb();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
        tx.objectStore(STORE).clear();
      });
    });
  } catch {}
}
