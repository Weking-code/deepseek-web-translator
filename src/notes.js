/* 文献笔记落盘页：负责「选文件夹」和「写 md」两件事。
   网页侧只把 markdown 交给 background，background 再转到这里。 */

const DB_NAME = 'dst-notes';
const STORE = 'kv';
const DIR_KEY = 'dirHandle';

const els = {
  dirPath: document.getElementById('dirPath'),
  pickDir: document.getElementById('pickDir'),
  log: document.getElementById('log'),
};

let pendingAfterPick = null;

/* ------------------------------------------------------------ IndexedDB */

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ 日志 */

function log(text, isError = false) {
  const empty = els.log.querySelector('.muted');
  if (empty) empty.remove();
  const li = document.createElement('li');
  if (isError) li.className = 'err';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const time = document.createElement('span');
  time.className = 't';
  time.textContent = stamp;
  li.appendChild(time);
  li.appendChild(document.createTextNode(text));
  els.log.prepend(li);
}

/* -------------------------------------------------------------- 目录句柄 */

async function getDir() {
  const handle = await idbGet(DIR_KEY);
  return handle && handle.kind === 'directory' ? handle : null;
}

async function refreshDirPath() {
  const dir = await getDir().catch(() => null);
  if (!dir) {
    els.dirPath.textContent = '还没有选择文件夹';
    els.dirPath.classList.remove('set');
    return null;
  }
  els.dirPath.textContent = dir.name;
  els.dirPath.classList.add('set');
  return dir;
}

async function ensurePermission(dir) {
  const options = { mode: 'readwrite' };
  let state = 'granted';
  try {
    state = await dir.queryPermission(options);
  } catch {
    /* 老版本浏览器没有 queryPermission，直接尝试 */
  }
  if (state === 'granted') return true;
  try {
    const granted = await dir.requestPermission(options);
    return granted === 'granted';
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- 写文件 */

async function reportToPage(task, result) {
  if (!task || typeof task.originTabId !== 'number') return;
  try {
    await chrome.runtime.sendMessage({
      type: 'noteResult',
      ok: !!result.ok,
      path: result.path || '',
      error: result.error || '',
      originTabId: task.originTabId,
    });
  } catch {
    /* ignore */
  }
}

async function downloadFallback(task, reason) {
  log(`改用下载目录保存（${reason}）`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'downloadNote',
      payload: { folder: task.folder, filename: task.filename, markdown: task.markdown },
    });
    if (response && response.ok) {
      log(`已下载到 下载目录/${task.folder}/${task.filename}`);
      await reportToPage(task, { ok: true, path: `下载目录/${task.folder}/${task.filename}` });
    } else {
      const error = (response && response.error) || '下载失败';
      log(error, true);
      await reportToPage(task, { ok: false, error });
    }
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    log(message, true);
    await reportToPage(task, { ok: false, error: message });
  }
}

async function writeIntoDir(dir, task) {
  const sub = await dir.getDirectoryHandle(task.folder, { create: true });
  const file = await sub.getFileHandle(task.filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(task.markdown);
  await writable.close();
  return `${dir.name}/${task.folder}/${task.filename}`;
}

async function processTask(task) {
  if (!task || !task.markdown || processing) return;
  processing = true;
  log(`开始写入 ${task.folder}/${task.filename}`);

  try {
    if (typeof window.showDirectoryPicker !== 'function') {
      await downloadFallback(task, '当前浏览器不支持文件系统 API');
      await clearPending();
      return;
    }

    const dir = await getDir().catch(() => null);
    if (!dir) {
      pendingAfterPick = task;
      els.pickDir.classList.add('pulse');
      els.pickDir.textContent = '先选一个文件夹 →';
      log('还没有选择保存文件夹，请点上方按钮选择', true);
      // 让用户看到这个页面
      try {
        const tab = await chrome.tabs.getCurrent();
        if (tab && typeof tab.id === 'number') {
          await chrome.tabs.update(tab.id, { active: true });
          window.focus();
        }
      } catch {
        /* ignore */
      }
      return;
    }

    const okPermission = await ensurePermission(dir);
    if (!okPermission) {
      pendingAfterPick = task;
      els.pickDir.classList.add('pulse');
      els.pickDir.textContent = '重新选择文件夹 →';
      log('目录权限已失效，请重新选择一次', true);
      return;
    }

    try {
      const path = await writeIntoDir(dir, task);
      log(`已保存：${path}`);
      await clearPending();
      await reportToPage(task, { ok: true, path });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      log(`写入失败：${message}`, true);
      await clearPending();
      await reportToPage(task, { ok: false, error: message });
    }
  } finally {
    processing = false;
  }
}

/* ------------------------------------------------------------ 读取待处理 */

let processing = false;

async function peekPending() {
  try {
    const stored = await chrome.storage.session.get({ pendingNote: null });
    return stored && stored.pendingNote ? stored.pendingNote : null;
  } catch {
    return null;
  }
}

async function clearPending() {
  try {
    await chrome.storage.session.remove('pendingNote');
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- 交互 */

els.pickDir.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'dst-notes', mode: 'readwrite' });
    await idbSet(DIR_KEY, handle);
    await refreshDirPath();
    log(`已选择文件夹：${handle.name}`);
    els.pickDir.classList.remove('pulse');
    els.pickDir.textContent = '更换文件夹…';
    if (pendingAfterPick) {
      const task = pendingAfterPick;
      pendingAfterPick = null;
      await processTask(task);
    }
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    log(`选择文件夹失败：${String(error && error.message ? error.message : error)}`, true);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'flushPending') return false;
  (async () => {
    const task = await peekPending();
    if (task) await processTask(task);
    sendResponse({ ok: true, handled: !!task });
  })();
  return true;
});

/* ---------------------------------------------------------------- 启动 */

(async () => {
  const dir = await refreshDirPath();
  if (dir) els.pickDir.textContent = '更换文件夹…';
  const task = await peekPending();
  if (task) await processTask(task);
})();
