'use strict';

const LANGS = [
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['ru', 'Русский'],
  ['pt', 'Português'],
  ['it', 'Italiano'],
  ['ar', 'العربية'],
];

const els = {
  status: document.getElementById('status'),
  toggle: document.getElementById('toggle'),
  mode: document.getElementById('mode'),
  lang: document.getElementById('lang'),
  openOptions: document.getElementById('openOptions'),
};

let tabId = null;
let pageState = null;
let timer = null;

function sendToTab(id, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(id, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function injectContentScript(id) {
  await chrome.scripting
    .insertCSS({ target: { tabId: id }, files: ['src/content.css'] })
    .catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] });
}

async function talk(message) {
  if (tabId === null) throw new Error('没有可用的标签页');
  try {
    return await sendToTab(tabId, message);
  } catch {
    // 页面在扩展安装/更新之前就打开了，content script 还没注入
    await injectContentScript(tabId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return await sendToTab(tabId, message);
  }
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function renderState() {
  const active = Boolean(pageState && pageState.active);
  els.toggle.disabled = false;
  els.toggle.classList.toggle('active', active);

  if (active) {
    els.toggle.textContent = '恢复原文';
    const progress = pageState.progress || {};
    if (pageState.translating && progress.total) {
      setStatus(`正在翻译 ${progress.done}/${progress.total} 段…`);
    } else if (progress.total) {
      setStatus(`已翻译 ${progress.total} 段 · 中英对照`);
    } else {
      setStatus('已翻译');
    }
  } else {
    els.toggle.textContent = '翻译此页';
    setStatus('就绪 · 逐段对照翻译');
  }
}

function renderSettings(settings) {
  for (const button of els.mode.querySelectorAll('.seg-btn')) {
    button.classList.toggle('on', button.dataset.mode === settings.mode);
  }
  els.lang.value = settings.targetLang;
}

async function refresh() {
  try {
    const state = await talk({ type: 'getState' });
    pageState = state || null;
    renderState();
  } catch {
    els.toggle.disabled = true;
    els.toggle.textContent = '此页面不可翻译';
    setStatus('浏览器内部页面不支持翻译，请在普通网页上使用', true);
    if (timer) clearInterval(timer);
  }
}

function buildLangOptions() {
  const fragment = document.createDocumentFragment();
  for (const [value, label] of LANGS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    fragment.appendChild(option);
  }
  els.lang.appendChild(fragment);
}

async function saveSetting(patch) {
  await chrome.storage.local.set(patch);
}

async function init() {
  buildLangOptions();

  const settings = await chrome.storage.local.get({
    targetLang: 'zh-CN',
    mode: 'bilingual',
  });
  renderSettings(settings);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && typeof tab.id === 'number' ? tab.id : null;
  await refresh();

  els.toggle.addEventListener('click', async () => {
    els.toggle.disabled = true;
    try {
      const active = Boolean(pageState && pageState.active);
      await talk(active ? { type: 'restore' } : { type: 'translatePage' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await refresh();
    } catch (error) {
      setStatus(`操作失败：${error.message}`, true);
      els.toggle.disabled = false;
    }
  });

  els.mode.addEventListener('click', async (event) => {
    const button = event.target.closest('.seg-btn');
    if (!button) return;
    const mode = button.dataset.mode;
    for (const item of els.mode.querySelectorAll('.seg-btn')) {
      item.classList.toggle('on', item === button);
    }
    await saveSetting({ mode });
    try {
      await talk({ type: 'setMode', mode });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await refresh();
    } catch {
      /* 页面没注入脚本时忽略 */
    }
  });

  els.lang.addEventListener('change', async () => {
    const lang = els.lang.value;
    await saveSetting({ targetLang: lang });
    try {
      await talk({ type: 'setLang', lang });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await refresh();
    } catch {
      /* ignore */
    }
  });

  els.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  if (timer) clearInterval(timer);
  timer = setInterval(refresh, 900);
}

window.addEventListener('unload', () => {
  if (timer) clearInterval(timer);
});

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`, true);
});
