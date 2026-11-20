// 用真实 DeepSeek 接口验证「文献总结」的 prompt 与 JSON 结构是否可用。
// 用法：$env:DEEPSEEK_API_KEY='sk-...'; node tools/test_summary.mjs
import { readFile } from 'node:fs/promises';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error('缺少环境变量 DEEPSEEK_API_KEY');
  process.exit(1);
}

const src = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
const start = src.indexOf('const SUMMARY_SYSTEM = [');
if (start < 0) throw new Error('background.js 里找不到 SUMMARY_SYSTEM');
const arrayLiteral = src.slice(src.indexOf('[', start), src.indexOf('.join', start));
const SYSTEM = new Function(`return ${arrayLiteral}`)().join('\n');

const SAMPLE = `## Abstract
Large artificial intelligence (AI) training data centers are emerging as significant, highly dynamic
digital loads that pose numerous challenges to power system stability. This paper develops a credible
impact study for data centers, presenting a dynamic data-center model that includes an uninterruptible
power supply (UPS), co-generator, cooling system, and a grid-forming (GFM) controlled energy storage
system (ESS). Using electromagnetic transient simulations, two stress scenarios are studied: low-voltage
faults and fast load fluctuations characteristic of AI training.

## I. INTRODUCTION
Data center capacity in the United States grew from 2.5 GW in 2015 to roughly 14.8 GW in 2024. Voltage
sag of 20% lasting 100 ms caused 37% of surveyed facilities to drop critical IT load.

## II. SYSTEM UNDER STUDY
The modeled data center has 3700 MW of contracted capacity. The ESS is rated 200 MVA with a GFM control
loop providing virtual inertia of 6 s and fast frequency response within 150 ms.

## III. RESULTS
Under a 20% voltage sag, the GFM ESS reduced frequency nadir from 59.31 Hz to 59.62 Hz and shortened
settling time from 8.4 s to 3.1 s. Under fast load ramps of 150 MW/s, bus voltage deviation stayed below
2.3%, versus 7.8% without GFM control. Post-fault recovery time improved by 46%.

## IV. CONCLUSIONS
Adequately tuned and controlled GFM ESS can significantly improve the large-load response of AI data
centers by reducing frequency overshoot, raising the nadir, shortening settling time, and enhancing
post-fault voltage recovery. Case studies are limited to a single 3700 MW cluster and do not model
cooling transients in detail.`;

const started = Date.now();
const response = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `标题：Impact of DC-Link Voltage Control on Torsional Vibrations\n期刊/会议：IEEE Transactions on Energy Conversion\n年份：2024\n\n下面是这篇文章的正文：\n\n"""\n${SAMPLE}\n"""\n\n请按约定输出 JSON。` },
    ],
    temperature: 0.2,
    max_tokens: 3500,
    response_format: { type: 'json_object' },
    stream: false,
  }),
});

if (!response.ok) {
  console.error('HTTP', response.status, await response.text());
  process.exit(1);
}

const data = await response.json();
const content = data.choices?.[0]?.message?.content || '';
let parsed = null;
try {
  parsed = JSON.parse(content);
} catch {
  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  if (first >= 0 && last > first) parsed = JSON.parse(content.slice(first, last + 1));
}

console.log('model   :', data.model);
console.log('latency :', Date.now() - started, 'ms');
console.log('usage   :', JSON.stringify(data.usage));
console.log('json ok :', !!parsed);
if (!parsed) {
  console.error(content.slice(0, 800));
  process.exit(1);
}

const expected = ['title_zh','title_en','doi','journal_abbr','venue','year','keywords','takeaway','problem','approach','methods','content','conclusions','numbers','limits'];
const missing = expected.filter((k) => parsed[k] === undefined);
console.log('missing :', missing.length ? missing.join(', ') : '（无）');
for (const key of ['title_zh', 'title_en', 'doi', 'journal_abbr', 'venue', 'year', 'takeaway']) {
  console.log(`  ${key}: ${JSON.stringify(parsed[key])}`);
}
for (const key of ['methods', 'content', 'conclusions', 'numbers', 'limits']) {
  const value = parsed[key];
  console.log(`  ${key}: ${Array.isArray(value) ? value.length : typeof value} 条`);
  if (Array.isArray(value)) value.slice(0, 2).forEach((v) => console.log(`      - ${v}`));
}
await import('node:fs').then((fs) => fs.writeFileSync('tools/last-summary.json', JSON.stringify(parsed, null, 2), 'utf8'));
console.log('原文已写入 tools/last-summary.json');

