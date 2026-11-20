/**
 * 用真实 API 验证「侧边快速翻译 / 查词」这条链路。
 *   $env:DEEPSEEK_API_KEY="sk-..." ; node tools/test_quick.mjs
 * 提示词直接从 src/background.js 里取，保证测的就是扩展实际发出去的那份。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bg = readFileSync(join(here, '..', 'src', 'background.js'), 'utf8');

const match = /const QUICK_SYSTEM = (\[[\s\S]*?\]\.join\('\\n'\));/.exec(bg);
if (!match) {
  console.error('没找到 QUICK_SYSTEM');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const QUICK_SYSTEM = new Function(`return ${match[1]}`)();

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('请先设置环境变量 DEEPSEEK_API_KEY');
  process.exit(1);
}

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

async function ask(text, pattern) {
  const started = Date.now();
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: QUICK_SYSTEM },
        { role: 'user', content: `pattern: ${pattern}\n要处理的文字：\n"""\n${text}\n"""` },
      ],
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  return { ms: Date.now() - started, model: data.model, usage: data.usage, content: data.choices[0].message.content };
}

const cases = [
  ['word', 'nadir'],
  ['sentence', 'The proposed GFM-ESS reduces the frequency nadir and shortens settling time after a large load step.'],
];

for (const [pattern, text] of cases) {
  const out = await ask(text, pattern);
  console.log(`\n=== ${pattern} : ${text.slice(0, 60)}`);
  console.log(`model=${out.model} ${out.ms}ms tokens=${out.usage.prompt_tokens}/${out.usage.completion_tokens}`);
  let parsed;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    console.log('!! 不是合法 JSON：', out.content.slice(0, 300));
    process.exitCode = 1;
    continue;
  }
  console.log(JSON.stringify(parsed, null, 2));
  if (pattern === 'word') {
    if (!parsed.head || !Array.isArray(parsed.entries) || !parsed.entries.length) {
      console.log('!! 缺 head / entries');
      process.exitCode = 1;
    }
  } else if (!parsed.translation || !Array.isArray(parsed.terms)) {
    console.log('!! 缺 translation / terms');
    process.exitCode = 1;
  }
}
