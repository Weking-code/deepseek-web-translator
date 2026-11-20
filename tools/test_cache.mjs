// 验证「还原原文后再翻译不重复计费」：用假的 chrome.storage + 假的 fetch 跑真实的 handleTranslate。
// 断言：第一次调用会请求 API，第二次同样的文本应全部命中缓存、fetch 调用次数不变。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'background.js'), 'utf8');

function makeStore() {
  const map = new Map();
  const api = {
    async get(keys) {
      const out = {};
      if (keys == null) {
        for (const [k, v] of map) out[k] = v;
        return out;
      }
      if (typeof keys === 'object' && !Array.isArray(keys)) {
        // chrome.storage.get({ key: default }) 形式：缺的用默认值
        for (const [k, def] of Object.entries(keys)) out[k] = map.has(k) ? map.get(k) : def;
        return out;
      }
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
    async getBytesInUse() {
      return JSON.stringify([...map]).length;
    },
    _map: map,
  };
  return api;
}

const local = makeStore();
const session = makeStore();
let fetchCount = 0;

const chrome = {
  storage: { local, session, onChanged: { addListener() {} } },
  runtime: {
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    getURL: (p) => `chrome-extension://test/${p}`,
    lastError: null,
  },
  tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, query() {}, sendMessage() {}, create() {}, update() {}, reload() {} },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} },
  downloads: { download() {} },
  declarativeContent: undefined,
  scripting: { executeScript() {}, insertCSS() {} },
};

const sandbox = {
  chrome,
  console,
  setTimeout,
  clearTimeout,
  URL,
  TextEncoder,
  TextDecoder,
  structuredClone,
  AbortController,
  fetch: async () => {
    fetchCount += 1;
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              translations: ['第一段译文', '第二段译文', '第三段译文'],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(
  `${src}\n;globalThis.__api = { handleTranslate, cacheKey, DEFAULT_SETTINGS, writeCache, readCache };`,
  sandbox,
  { filename: 'background.js' },
);

const { handleTranslate, DEFAULT_SETTINGS } = sandbox.__api;
await chrome.storage.local.set({ model: DEFAULT_SETTINGS.model, targetLang: DEFAULT_SETTINGS.targetLang, baseUrl: DEFAULT_SETTINGS.baseUrl, apiKey: 'sk-test' });

const segments = ['Paragraph one.', 'Paragraph two.', 'Paragraph three.'];

const first = await handleTranslate({ type: 'translateBatch', segments, targetLang: 'zh-CN' }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
if (!first || first.ok !== true) console.log('第一次返回：', JSON.stringify(first));
const firstFetches = fetchCount;

const second = await handleTranslate({ type: 'translateBatch', segments, targetLang: 'zh-CN' });
const secondFetches = fetchCount;

const third = await handleTranslate({ type: 'translateBatch', segments, targetLang: 'zh-CN', force: true });
const thirdFetches = fetchCount;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

check('第一次调用请求了 API', firstFetches > 0, `fetch=${firstFetches}`);
check(
  '第一次译文正确',
  JSON.stringify(first.translations) === JSON.stringify(['第一段译文', '第二段译文', '第三段译文']),
  JSON.stringify(first.translations),
);
check('第一次没有命中缓存', first.cachedCount === 0, `cachedCount=${first.cachedCount}`);
check('第二次完全命中缓存、没有再请求', secondFetches === firstFetches, `fetch ${firstFetches} -> ${secondFetches}`);
check('第二次 cachedCount 等于段数', second.cachedCount === segments.length, `cachedCount=${second.cachedCount}`);
check(
  '第二次译文与第一次一致',
  JSON.stringify(second.translations) === JSON.stringify(first.translations),
  JSON.stringify(second.translations),
);
check('force 会重新请求（换模型/强制刷新用）', thirdFetches > secondFetches, `fetch ${secondFetches} -> ${thirdFetches}`);
check(
  '缓存写在 storage.local（能跨会话存活）',
  [...local._map.keys()].some((k) => k.startsWith('c|')),
  `${local._map.size} 个键`,
);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);



