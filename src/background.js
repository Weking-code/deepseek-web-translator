'use strict';

/**
 * DeepSeek 网页翻译 —— Service Worker
 *
 * 职责：
 *  1. 保存 / 读取设置（API Key、模型、目标语言……）
 *  2. 代理 DeepSeek Chat Completions 请求（content script 受 CORS 限制，必须走这里）
 *  3. 批量分段翻译 + 结果校验 + 失败重试 + 分批降级
 *  4. 会话级翻译缓存（chrome.storage.session，关闭浏览器即失效）
 *  5. 右键菜单、快捷键、角标
 */

const DEFAULT_SETTINGS = {
  apiKey: '', // 用户在设置页自己填写，不内置任何 key
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  targetLang: 'zh-CN',
  mode: 'bilingual', // replace | bilingual
  showFab: true, // 网页右侧悬浮按钮
  batchItems: 30, // 单次请求最多几段
  batchChars: 6000, // 单次请求最多多少字符（越大请求越少、输入费用越低）
  concurrency: 3, // 并发请求数
  temperature: 0,
};

const LANG_NAMES = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  es: 'Spanish (Español)',
  ru: 'Russian (Русский)',
  pt: 'Portuguese (Português)',
  it: 'Italian (Italiano)',
  ar: 'Arabic (العربية)',
};

const API_TIMEOUT_MS = 90_000;

function log(...args) {
  console.log('[DeepSeek翻译]', ...args);
}

/* ------------------------------------------------------------------ 设置 */

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

/* ------------------------------------------------------------ 提示词构造 */

function systemPrompt(langName) {
  return [
    'You are a professional web-page translation engine.',
    `Translate every segment into ${langName}.`,
    'Rules:',
    '1. Translate only. Never explain, summarize, answer questions, or add anything that is not in the source.',
    '2. Keep numbers, code, URLs, e-mail addresses, product names, units and symbols exactly as they are.',
    '3. Produce natural, fluent copy that reads like good web content in the target language; keep the original tone.',
    '4. The segments are independent text fragments of one page (headings, buttons, list items...). Never merge, split, drop or reorder them.',
    '5. Never translate the segment index or the JSON structure.',
    '6. Reply with pure JSON only, no markdown fences, in this exact shape:',
    '{"translations": ["<translation of segment 1>", "<translation of segment 2>", ...]}',
    'The array MUST contain exactly the same number of strings as the input segments, in the same order.',
  ].join('\n');
}

function userPrompt(segments) {
  return JSON.stringify({ segments });
}

/* -------------------------------------------------------------- 结果解析 */

function parseTranslations(content, expected) {
  if (!content) return null;
  let text = String(content).trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        data = JSON.parse(match[0]);
      } catch {
        /* ignore */
      }
    }
  }
  if (!data) return null;

  let list = Array.isArray(data)
    ? data
    : data.translations || data.t || data.result || data.results || data.data;
  if (!Array.isArray(list)) return null;

  const normalized = list.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      return String(item.translation ?? item.text ?? item.content ?? '');
    }
    return '';
  });

  if (normalized.length !== expected) return null;
  return normalized;
}

/* ---------------------------------------------------------------- 网络层 */

function describeHttpError(status, bodyText) {
  const detail = String(bodyText || '').slice(0, 240);
  switch (status) {
    case 400:
      return `请求参数有误（400）：${detail}`;
    case 401:
      return 'API Key 无效或已失效（401），请到扩展设置里检查';
    case 402:
      return '账户余额不足（402），请给 DeepSeek 账户充值后重试';
    case 403:
      return `无访问权限（403）：${detail}`;
    case 404:
      return '接口地址不存在（404），请检查 Base URL 是否为 https://api.deepseek.com';
    case 429:
      return '请求过于频繁（429），正在重试…';
    case 500:
    case 502:
    case 503:
    case 504:
      return `DeepSeek 服务暂时不可用（${status}）`;
    default:
      return `请求失败（${status}）：${detail}`;
  }
}

function isRetryableStatus(status) {
  return status === 429 || status === 408 || status >= 500;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestOnce(segments, settings, strict) {
  const baseUrl = String(settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const totalChars = segments.reduce((sum, s) => sum + s.length, 0);
  const langName = LANG_NAMES[settings.targetLang] || settings.targetLang;

  const messages = [
    { role: 'system', content: systemPrompt(langName) },
    { role: 'user', content: userPrompt(segments) },
  ];
  if (strict) {
    messages.push({
      role: 'user',
      content: `Reminder: reply with ONLY {"translations": [...]} containing exactly ${segments.length} strings, same order as the ${segments.length} input segments.`,
    });
  }

  const payload = {
    model: settings.model || DEFAULT_SETTINGS.model,
    messages,
    temperature: Number(settings.temperature) || 0,
    max_tokens: Math.min(8192, Math.max(600, Math.ceil(totalChars * 2.2) + 300)),
    response_format: { type: 'json_object' },
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    const error = new Error(describeHttpError(response.status, body));
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek 返回内容为空（可能被安全策略拦截）');
  }
  return content;
}

/** 带指数退避的重试 */
async function requestWithRetry(segments, settings, strict) {
  const maxAttempts = 4;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await requestOnce(segments, settings, strict);
    } catch (error) {
      lastError = error;
      const status = error.status;
      const retryable =
        status === undefined ? true : isRetryableStatus(status); // 网络错误 / 超时
      if (!retryable || status === 401 || status === 402 || status === 404) throw error;
      if (attempt === maxAttempts - 1) break;
      const backoff = 700 * 2 ** attempt + Math.floor(Math.random() * 400);
      log(`请求失败（${error.message}），${backoff}ms 后重试`);
      await sleep(backoff);
    }
  }
  throw lastError || new Error('翻译请求失败');
}

/* -------------------------------------------------------------- 批量翻译 */

/**
 * 把一组段落翻译成目标语言。若模型返回的条数对不上，
 * 会先加强提示重试一次，仍不对就把整批对半拆开递归处理。
 */
async function translateBatch(segments, settings, depth = 0) {
  if (!segments.length) return [];

  for (const strict of [false, true]) {
    const content = await requestWithRetry(segments, settings, strict);
    const parsed = parseTranslations(content, segments.length);
    if (parsed) return parsed;
    log('返回条数与输入不一致，重试中……', segments.length);
  }

  if (segments.length === 1) {
    log('单段翻译仍失败，保留原文');
    return [segments[0]];
  }
  if (depth >= 5) return segments.slice();

  const mid = Math.ceil(segments.length / 2);
  const [left, right] = await Promise.all([
    translateBatch(segments.slice(0, mid), settings, depth + 1),
    translateBatch(segments.slice(mid), settings, depth + 1),
  ]);
  return left.concat(right);
}

/* ------------------------------------------------------------------ 缓存 */

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(settings, text) {
  return `c|${settings.model}|${settings.targetLang}|${text.length}|${hash(text)}`;
}

// 译文缓存放在 storage.local：刷新页面、重启浏览器、还原原文后再翻都不会重复计费。
// 原来用 storage.session，关掉标签页/浏览器就没了，用户「还原原文→再翻译」等于重新花钱。
const CACHE_INDEX_KEY = 'trCacheIndex';
const CACHE_MAX_ENTRIES = 6000;

async function readCache(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    log('读取缓存失败', error);
    return {};
  }
}

let cacheIndexChain = Promise.resolve();

async function writeCache(patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  try {
    await chrome.storage.local.set(patch);
  } catch (error) {
    log('写入缓存失败（可能超出配额）', error);
    return;
  }
  // 只保留最近 CACHE_MAX_ENTRIES 条，超出的按写入顺序淘汰，避免无限膨胀。
  // 串行化，免得并发批次同时改索引互相覆盖。
  cacheIndexChain = cacheIndexChain.then(async () => {
    try {
      const stored = await chrome.storage.local.get(CACHE_INDEX_KEY);
      const index = Array.isArray(stored[CACHE_INDEX_KEY]) ? stored[CACHE_INDEX_KEY] : [];
      const known = new Set(index);
      for (const key of keys) {
        if (!known.has(key)) {
          index.push(key);
          known.add(key);
        }
      }
      const drop = index.length > CACHE_MAX_ENTRIES ? index.splice(0, index.length - CACHE_MAX_ENTRIES) : [];
      await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
      if (drop.length) await chrome.storage.local.remove(drop);
    } catch (error) {
      log('整理缓存索引失败', error);
    }
  });
  await cacheIndexChain;
}

/* -------------------------------------------------------------- 消息处理 */

async function handleTranslate(msg) {
  const settings = await getSettings();
  if (msg.targetLang) settings.targetLang = msg.targetLang;

  const segments = (msg.segments || []).map((s) => String(s ?? ''));
  if (!segments.length) return { ok: true, translations: [] };
  if (!settings.apiKey) {
    return { ok: false, error: '还没有填写 DeepSeek API Key，请点扩展 → 设置 填写后重试' };
  }

  const keys = segments.map((s) => cacheKey(settings, s));
  const cached = msg.force ? {} : await readCache(keys);

  const missing = [];
  for (let i = 0; i < segments.length; i++) {
    if (typeof cached[keys[i]] !== 'string') missing.push(i);
  }

  const translations = segments.map((s, i) =>
    typeof cached[keys[i]] === 'string' ? cached[keys[i]] : '',
  );

  if (missing.length) {
    const input = missing.map((i) => segments[i]);
    const output = await translateBatch(input, settings);
    const patch = {};
    output.forEach((text, index) => {
      const originalIndex = missing[index];
      if (typeof text === 'string') {
        translations[originalIndex] = text;
        if (text && text !== segments[originalIndex]) {
          patch[keys[originalIndex]] = text;
        }
      }
    });
    if (Object.keys(patch).length) await writeCache(patch);
  }

  for (let i = 0; i < translations.length; i++) {
    if (!translations[i]) translations[i] = segments[i];
  }
  return { ok: true, translations, cachedCount: segments.length - missing.length };
}

async function handleTestConnection(msg) {
  const settings = await getSettings();
  if (msg && msg.apiKey) settings.apiKey = msg.apiKey;
  if (msg && msg.baseUrl) settings.baseUrl = msg.baseUrl;
  if (msg && msg.model) settings.model = msg.model;
  if (msg && msg.targetLang) settings.targetLang = msg.targetLang;
  const started = Date.now();
  const sample = 'The quick brown fox jumps over the lazy dog.';
  const content = await requestWithRetry([sample], settings, false);
  const parsed = parseTranslations(content, 1);
  return {
    ok: true,
    latency: Date.now() - started,
    model: settings.model,
    result: parsed ? parsed[0] : content.slice(0, 120),
  };
}

/* ------------------------------------------------------------ 文献总结 */

const SUMMARY_SYSTEM = [
  '你是一位严谨的学术编辑，擅长把一篇论文压缩成可以直接写进笔记的结构化摘要。',
  '读者是要做文献综述的研究生，他需要的是"这篇论文做了什么、怎么做的、结论能不能引用"，而不是泛泛的褒奖。',
  '',
  '要求：',
  '1. 只依据给定正文，绝不编造数据、方法或结论；正文里没有的就留空数组。',
  '2. 中文输出，专业术语保留英文（如 grid-forming inverter）。',
  '3. 每条要点尽量带具体信息（对象、条件、指标、数值），不要"提出了一种新方法"这类空话。',
  '4. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。',
  '',
  'JSON 结构：',
  '{',
  '  "title_zh": "标题中文译名（原文就是中文则填原标题）",',
  '  "title": "原标题",',
  '  "title_en": "英文原标题，原样照抄不要翻译（原文是中文则给出英文译名）",',
  '  "doi": "DOI 号，照抄如 10.1109/TEC.2023.3278901；正文和页面信息里都没有就填空字符串，不要编造",',
  '  "journal_abbr": "期刊/会议标准缩写，如 IEEE TEC、Applied Energy；不确定就给常见简称",',
  '  "venue": "期刊或会议全名",',
  '  "year": "发表年份（四位数字），不确定填空字符串",',
  '  "keywords": ["3-5 个中文关键词，用于命名笔记文件"],',
  '  "takeaway": "一句话概括（40 字内）",',
  '  "problem": "要解决的问题 / 研究缺口，2-4 句",',
  '  "approach": "核心思路与技术路线，2-4 句",',
  '  "methods": ["研究方法要点，3-6 条"],',
  '  "content": ["主要内容：模型、算例、实验设置，3-7 条"],',
  '  "conclusions": ["主要结论，2-5 条，尽量带量化结果"],',
  '  "numbers": ["关键数据，如效率 98.2%、容量 3700 MW，2-5 条"],',
  '  "limits": ["局限、关键假设或可延伸方向，1-3 条"]',
  '}',
].join('\n');

const ARTICLE_MAX_CHARS = 38000;

function metaLine(meta) {
  if (!meta) return '';
  const parts = [];
  if (meta.title) parts.push(`标题：${meta.title}`);
  if (meta.venue) parts.push(`期刊/会议：${meta.venue}`);
  if (meta.year) parts.push(`年份：${meta.year}`);
  if (meta.authors) parts.push(`作者：${meta.authors}`);
  if (meta.doi) parts.push(`DOI：${meta.doi}`);
  if (meta.url) parts.push(`网址：${meta.url}`);
  return parts.join('\n');
}

/** 调用 /chat/completions 拿一段 JSON 文本（带退避重试） */
async function chatJSON(messages, settings, { maxTokens = 3500, temperature = 0.2 } = {}) {
  const baseUrl = String(settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
  const payload = {
    model: settings.model || DEFAULT_SETTINGS.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    stream: false,
  };

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      lastError = new Error(controller.signal.aborted ? '请求超时，文献可能太长' : '网络错误，无法连接 DeepSeek');
      if (attempt === 3) throw lastError;
      await sleep(900 * 2 ** attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        /* ignore */
      }
      const error = new Error(describeHttpError(response.status, body));
      error.status = response.status;
      if (response.status === 401 || response.status === 402 || response.status === 404) throw error;
      lastError = error;
      if (attempt === 3) throw error;
      await sleep(900 * 2 ** attempt);
      continue;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek 返回内容为空（可能被安全策略拦截）');
    return content;
  }
  throw lastError || new Error('总结请求失败');
}

/** 模型偶尔会包一层 ```json，这里做一次宽松解析 */
function parseLooseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const attempts = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function handleSummarize(msg) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, error: '还没有填写 DeepSeek API Key，请先在设置页填写' };
  }
  const body = String(msg.body || '').trim();
  if (body.length < 400) {
    return { ok: false, error: '这一页没抓到足够的正文，可能不是文章页或内容还没加载完' };
  }

  const trimmed = body.slice(0, ARTICLE_MAX_CHARS);
  const meta = msg.meta || {};
  const head = metaLine(meta);
  const user =
    `${head ? head + '\n\n' : ''}下面是这篇文章的正文（由网页抽取，可能是英文，可能夹杂页眉页脚、公式占位符）：\n\n` +
    `"""\n${trimmed}\n"""\n\n` +
    '请按约定输出 JSON。';

  const messages = [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: user },
  ];

  const content = await chatJSON(messages, settings, { maxTokens: 3500, temperature: 0.2 });
  const summary = parseLooseJson(content);
  if (!summary) throw new Error('模型返回的不是合法 JSON，请再试一次');
  return { ok: true, summary, model: settings.model };
}

/* ------------------------------------------------- 侧边快速翻译 / 查词 */

const QUICK_SYSTEM = [
  '你是一个严谨的双语词典和翻译助手，服务对象是读英文论文的中文读者。',
  '用户给你一段文字，按 pattern 的要求输出，只输出 JSON，不要解释、不要 markdown。',
  '',
  'pattern 为 "word" 时输出：',
  '{',
  '  "head": "这个词的原形",',
  '  "phonetic": "音标，如 /ˈvɜːtɪks/，不确定留空",',
  '  "entries": [{"pos": "n.", "meaning": "中文释义（不超过 20 字）"}]',
  '}',
  '要求：entries 覆盖该词在此语境下最常见的 1-3 个义项，术语给出领域内的准确译法；',
  '如果原文是中文，则反过来给出英文对应词。',
  '',
  'pattern 为 "sentence" 时输出：',
  '{',
  '  "translation": "中文译文（保持原文语气，术语准确，不要过度口语化）",',
  '  "terms": [{"term": "原文里值得记的专业词", "zh": "中文译法"}]',
  '}',
  '要求：translation 只翻译，不加解释；terms 只挑 0-4 个真正的专业术语，没有就空数组。',
].join('\n');

async function handleQuickTranslate(msg) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, error: '还没有填写 API Key：点扩展图标 →「设置」填一个' };
  }
  const text = String(msg.text || '').trim();
  if (!text) return { ok: false, error: '没有要翻译的文字' };
  if (text.length > 4000) return { ok: false, error: '太长了，一次最多 4000 字符' };

  const pattern = msg.pattern === 'word' ? 'word' : 'sentence';
  const messages = [
    { role: 'system', content: QUICK_SYSTEM },
    {
      role: 'user',
      content: `pattern: ${pattern}\n要处理的文字：\n"""\n${text}\n"""`,
    },
  ];

  const content = await chatJSON(messages, settings, { maxTokens: 1200, temperature: 0.1 });
  const parsed = parseLooseJson(content);
  if (!parsed) throw new Error('模型返回的不是合法 JSON，请再试一次');
  return { ok: true, result: parsed, pattern, model: settings.model };
}

/* ------------------------------------------------------- 笔记落盘通道 */

const NOTES_URL = chrome.runtime.getURL('src/notes.html');

async function ensureNotesTab() {
  try {
    const stored = await chrome.storage.session.get({ notesTabId: null });
    const id = stored && stored.notesTabId;
    if (typeof id === 'number') {
      try {
        const tab = await chrome.tabs.get(id);
        if (tab && typeof tab.id === 'number') return tab.id;
      } catch {
        /* 标签页已被关掉 */
      }
    }
  } catch {
    /* ignore */
  }
  const tab = await chrome.tabs.create({ url: NOTES_URL, active: false });
  try {
    await chrome.storage.session.set({ notesTabId: tab.id });
  } catch {
    /* ignore */
  }
  return tab.id;
}

/** content script 请求保存：投递给笔记页（必要时后台开一个标签页） */
async function handleSaveNote(msg, sender) {
  const payload = msg.payload || {};
  if (!payload.markdown) return { ok: false, error: '内容为空' };
  if (typeof payload.folder !== 'string' || typeof payload.filename !== 'string') {
    return { ok: false, error: '缺少文件夹或文件名' };
  }

  const originTabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  const task = { ...payload, originTabId, createdAt: Date.now() };
  try {
    await chrome.storage.session.set({ pendingNote: task });
  } catch {
    /* ignore */
  }

  const tabId = await ensureNotesTab();
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'flushPending' });
  } catch {
    // 笔记页还没加载完，页面 onload 时会自己读 pendingNote
    try {
      await chrome.tabs.reload(tabId);
    } catch {
      /* ignore */
    }
  }
  return { ok: true, queued: true };
}

/** 笔记页回报结果 → 转给发起保存的网页 */
async function handleNoteResult(msg) {
  const originTabId = msg.originTabId;
  if (typeof originTabId !== 'number') return { ok: true };
  try {
    await chrome.tabs.sendMessage(originTabId, {
      type: 'noteResult',
      ok: !!msg.ok,
      path: msg.path || '',
      error: msg.error || '',
    });
  } catch {
    /* 网页已关闭 */
  }
  return { ok: true };
}

/** 兜底：走浏览器下载目录（文件系统 API 不可用时） */
async function handleDownloadNote(msg) {
  const { folder = '', filename = 'note.md', markdown = '' } = msg.payload || {};
  if (!markdown) return { ok: false, error: '内容为空' };
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;
  const id = await chrome.downloads.download({
    url,
    filename: `${folder}/${filename}`,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { ok: true, id };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;

  if (type === 'translateBatch') {
    handleTranslate(msg)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'testConnection') {
    handleTestConnection(msg)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'getSettings') {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (type === 'setBadge') {
    const tabId = sender?.tab?.id;
    if (typeof tabId === 'number') {
      chrome.action.setBadgeText({ text: msg.on ? '译' : '', tabId }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#4d6bfe', tabId }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'summarize') {
    handleSummarize(msg)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'quickTranslate') {
    handleQuickTranslate(msg)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'saveNote') {
    handleSaveNote(msg, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === 'noteResult') {
    handleNoteResult(msg)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (type === 'downloadNote') {
    handleDownloadNote(msg)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});

// 笔记标签页被关掉后清掉记录的 id，下次保存时重新开
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session
    .get({ notesTabId: null })
    .then((stored) => {
      if (stored && stored.notesTabId === tabId) {
        return chrome.storage.session.remove('notesTabId');
      }
      return undefined;
    })
    .catch(() => {});
});

/* -------------------------------------------------------- 菜单 / 快捷键 */

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'dst-translate-selection',
      title: '用 DeepSeek 翻译选中内容',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'dst-translate-page',
      title: '用 DeepSeek 翻译整个页面',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'dst-restore-page',
      title: '恢复网页原文',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'dst-summarize-page',
      title: '用 DeepSeek 整理这篇文献',
      contexts: ['page'],
    });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  setupContextMenus();
  if (details.reason === 'install') {
    // 首次安装时把默认设置落盘，方便用户在设置页看到并修改
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    const patch = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (stored[key] === undefined) patch[key] = value;
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    // 没填 API Key 的话，直接打开设置页让用户填
    if (!stored.apiKey) {
      try {
        chrome.runtime.openOptionsPage();
      } catch {
        /* ignore */
      }
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
});

/**
 * 给标签页发消息。页面在扩展安装/更新之前就打开了时 content script 还没注入，
 * 这里兜底注入一次再发（右键菜单和快捷键都靠它）。
 */
async function sendToTab(tabId, message, frameId) {
  const options = typeof frameId === 'number' && frameId > 0 ? { frameId } : undefined;
  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    try {
      const target = options ? { tabId, frameIds: [frameId] } : { tabId };
      await chrome.scripting.insertCSS({ target, files: ['src/content.css'] }).catch(() => {});
      await chrome.scripting.executeScript({ target, files: ['src/content.js'] });
      return await chrome.tabs.sendMessage(tabId, message, options);
    } catch {
      return null;
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  const map = {
    'dst-translate-selection': { type: 'translateSelection' },
    'dst-translate-page': { type: 'translatePage' },
    'dst-restore-page': { type: 'restore' },
    'dst-summarize-page': { type: 'summarizePage' },
  };
  const message = map[info.menuItemId];
  if (!message) return;
  sendToTab(tab.id, message, info.frameId).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && typeof tab.id === 'number') {
    sendToTab(tab.id, { type: 'togglePage' }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  }
});
