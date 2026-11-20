/**
 * 实测：同一篇 40 段英文文章，不同批次大小下的 token 消耗与费用。
 * 提示词、JSON 协议、批处理规则都跟扩展一致，只改 batchItems / batchChars。
 *   $env:DEEPSEEK_API_KEY="sk-..." ; node tools/cost_probe.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bg = readFileSync(join(here, '..', 'src', 'background.js'), 'utf8');

const fnMatch = /function systemPrompt\(langName\) \{[\s\S]*?\n\}/.exec(bg);
if (!fnMatch) throw new Error('没找到 systemPrompt');
// eslint-disable-next-line no-new-func
const systemPrompt = new Function(`${fnMatch[0]}; return systemPrompt;`)();
const SYSTEM = systemPrompt('简体中文');
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('请先设置 DEEPSEEK_API_KEY');
  process.exit(1);
}
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// 造一篇“典型论文/新闻页”：40 段，每段 150~260 字符
const paragraphs = Array.from({ length: 40 }, (_, i) => {
  const base = [
    `Grid-forming energy storage systems are increasingly deployed to provide inertia and primary frequency response in low-inertia power grids dominated by inverter-based resources.`,
    `The proposed control strategy combines a virtual synchronous machine loop with a fast inner current controller, which allows the converter to inject active power within a few milliseconds after a load step.`,
    `Simulation results show that the frequency nadir improves from 59.31 Hz to 59.62 Hz, and the settling time decreases from 8.4 s to 3.1 s under a 3700 MW contingency.`,
    `Field measurements from a 100 MW battery plant confirm the controller behaviour, although the measured response is slightly slower than predicted because of communication delays in the plant controller.`,
    `Future work will extend the analysis to multi-machine systems and to the interaction between grid-forming converters and synchronous condensers.`,
  ];
  const text = base[i % base.length];
  return `${text} Scenario ${i + 1} also considers variations in the dc-link voltage control loop.`;
});

function buildBatches(items, { batchItems, batchChars }) {
  const batches = [];
  let current = [];
  let chars = 0;
  const push = () => {
    if (current.length) batches.push(current);
    current = [];
    chars = 0;
  };
  for (const item of items) {
    if (current.length >= batchItems) push();
    if (current.length && chars + item.length > batchChars) push();
    current.push(item);
    chars += item.length;
  }
  push();
  return batches;
}

async function runBatch(batch) {
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({ segments: batch }),
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 8192,
    stream: false,
  };
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw);
  const parsed = JSON.parse(data.choices[0].message.content);
  const ok = Array.isArray(parsed.translations) && parsed.translations.length === batch.length;
  return {
    usage: data.usage,
    ok,
    cacheHit: data.usage.prompt_cache_hit_tokens || 0,
  };
}

const TOTAL_CHARS = paragraphs.reduce((sum, p) => sum + p.length, 0);
console.log(`测试文章：${paragraphs.length} 段 / ${TOTAL_CHARS} 字符\n`);

const configs = [
  { name: '当前默认 batchItems=20 batchChars=2200', batchItems: 20, batchChars: 2200 },
  { name: '建议     batchItems=30 batchChars=6000', batchItems: 30, batchChars: 6000 },
  { name: '激进     batchItems=50 batchChars=12000', batchItems: 50, batchChars: 12000 },
];

for (const config of configs) {
  const batches = buildBatches(paragraphs, config);
  let prompt = 0;
  let completion = 0;
  let cacheHit = 0;
  let failures = 0;
  for (const batch of batches) {
    const out = await runBatch(batch);
    prompt += out.usage.prompt_tokens;
    completion += out.usage.completion_tokens;
    cacheHit += out.cacheHit;
    if (!out.ok) failures += 1;
  }
  // deepseek-chat 计价：输入（未命中缓存）¥2/M，输出 ¥8/M；命中缓存部分约 ¥0.5/M（保守按比例算）
  const miss = prompt - cacheHit;
  const cost = (miss * 2) / 1e6 + (cacheHit * 0.5) / 1e6 + (completion * 8) / 1e6;
  console.log(`\n${config.name}`);
  console.log(
    `  请求数 ${batches.length}  输入 ${prompt} tok（缓存命中 ${cacheHit}） 输出 ${completion} tok  条数异常 ${failures}`,
  );
  console.log(`  估算费用 ¥${cost.toFixed(4)} ／这篇`);
}

