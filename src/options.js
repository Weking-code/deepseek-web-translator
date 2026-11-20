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

const FIELDS = {
  apiKey: 'text',
  baseUrl: 'text',
  model: 'text',
  targetLang: 'text',
  mode: 'text',
  showFab: 'checkbox',
  batchItems: 'number',
  batchChars: 'number',
  concurrency: 'number',
};

const els = {
  apiKey: document.getElementById('apiKey'),
  baseUrl: document.getElementById('baseUrl'),
  model: document.getElementById('model'),
  targetLang: document.getElementById('targetLang'),
  mode: document.getElementById('mode'),
  showFab: document.getElementById('showFab'),
  batchItems: document.getElementById('batchItems'),
  batchChars: document.getElementById('batchChars'),
  concurrency: document.getElementById('concurrency'),
  toggleKey: document.getElementById('toggleKey'),
  test: document.getElementById('test'),
  testResult: document.getElementById('testResult'),
  save: document.getElementById('save'),
  reset: document.getElementById('reset'),
  saveResult: document.getElementById('saveResult'),
  openNotes: document.getElementById('openNotes'),
};

function buildLangOptions() {
  const fragment = document.createDocumentFragment();
  for (const [value, label] of LANGS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    fragment.appendChild(option);
  }
  els.targetLang.appendChild(fragment);
}

function readForm() {
  return {
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim().replace(/\/+$/, ''),
    model: els.model.value.trim(),
    targetLang: els.targetLang.value,
    mode: els.mode.value,
    showFab: els.showFab.checked,
    batchItems: Number(els.batchItems.value) || 20,
    batchChars: Number(els.batchChars.value) || 2200,
    concurrency: Number(els.concurrency.value) || 3,
  };
}

function writeForm(settings) {
  els.apiKey.value = settings.apiKey || '';
  els.baseUrl.value = settings.baseUrl || 'https://api.deepseek.com';
  els.model.value = settings.model || 'deepseek-chat';
  els.targetLang.value = settings.targetLang || 'zh-CN';
  els.mode.value = settings.mode === 'replace' ? 'replace' : 'bilingual';
  els.showFab.checked = settings.showFab !== false;
  els.batchItems.value = settings.batchItems || 20;
  els.batchChars.value = settings.batchChars || 2200;
  els.concurrency.value = settings.concurrency || 3;
}

function setResult(el, text, kind) {
  el.textContent = text;
  el.className = `result ${kind || ''}`.trim();
}

async function refreshDirName() {
  const el = document.getElementById('dirName');
  if (!el) return;
  try {
    const stored = await chrome.storage.local.get({ notesDirName: '' });
    const name = String(stored.notesDirName || '').trim();
    el.textContent = name || '未选择';
    el.classList.toggle('set', !!name);
  } catch {
    el.textContent = '未选择';
  }
}

async function load() {
  buildLangOptions();
  const settings = await chrome.storage.local.get({
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    targetLang: 'zh-CN',
    mode: 'bilingual',
    showFab: true,
    batchItems: 20,
    batchChars: 2200,
    concurrency: 3,
  });
  writeForm(settings);
  await refreshDirName();
  if (!settings.apiKey) {
    setResult(els.saveResult, '还没有填 API Key：粘贴你自己的 DeepSeek Key，点「保存设置」', 'err');
    els.apiKey.focus();
  }
}

async function testConnection() {
  const values = readForm();
  if (!values.apiKey) {
    setResult(els.testResult, '请先填写 API Key', 'err');
    return;
  }
  els.test.disabled = true;
  setResult(els.testResult, '正在请求 DeepSeek…', '');

  chrome.runtime.sendMessage(
    {
      type: 'testConnection',
      apiKey: values.apiKey,
      baseUrl: values.baseUrl,
      model: values.model,
      targetLang: values.targetLang,
    },
    (response) => {
      els.test.disabled = false;
      if (chrome.runtime.lastError) {
        setResult(els.testResult, `失败：${chrome.runtime.lastError.message}`, 'err');
        return;
      }
      if (!response || !response.ok) {
        setResult(els.testResult, `失败：${(response && response.error) || '未知错误'}`, 'err');
        return;
      }
      setResult(
        els.testResult,
        `连接成功 · ${response.latency}ms · 示例译文「${response.result}」`,
        'ok',
      );
    },
  );
}

async function save() {
  const values = readForm();
  if (!values.apiKey) {
    setResult(els.saveResult, 'API Key 不能为空', 'err');
    return;
  }
  if (!/^https?:\/\//.test(values.baseUrl)) {
    setResult(els.saveResult, '接口地址需要以 http(s):// 开头', 'err');
    return;
  }
  await chrome.storage.local.set(values);
  setResult(els.saveResult, '已保存', 'ok');
  setTimeout(() => setResult(els.saveResult, '', ''), 2500);
}

async function reset() {
  const defaults = await chrome.storage.local.get('apiKey');
  await chrome.storage.local.set({
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    targetLang: 'zh-CN',
    mode: 'bilingual',
    showFab: true,
    batchItems: 20,
    batchChars: 2200,
    concurrency: 3,
  });
  await load();
  setResult(els.saveResult, '已恢复默认（API Key 保留）', 'ok');
  setTimeout(() => setResult(els.saveResult, '', ''), 2500);
}

els.toggleKey.addEventListener('click', () => {
  const show = els.apiKey.type === 'password';
  els.apiKey.type = show ? 'text' : 'password';
  els.toggleKey.textContent = show ? '隐藏' : '显示';
});

els.test.addEventListener('click', testConnection);
els.save.addEventListener('click', save);
els.reset.addEventListener('click', reset);

els.openNotes.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/notes.html'), active: true }).catch(() => {});
});

load().catch((error) => {
  setResult(els.saveResult, `读取设置失败：${error.message}`, 'err');
});
