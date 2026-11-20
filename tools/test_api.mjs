// 真机联通性测试：模拟扩展的请求格式（JSON 数组协议），验证 Key、模型与解析。
// 用法：DEEPSEEK_API_KEY=sk-xxx node tools/test_api.mjs
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
if (!API_KEY) {
  console.error('请先设置环境变量 DEEPSEEK_API_KEY');
  process.exit(1);
}
const BASE_URL = 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

const LANG_NAMES = { 'zh-CN': 'Simplified Chinese', en: 'English' };

function systemPrompt(targetLang) {
  const name = LANG_NAMES[targetLang] || targetLang;
  return [
    `You are a professional translator. Translate the user's text segments into ${name}.`,
    'Return ONLY valid JSON in the form {"translations": ["...", "..."]}.',
    'Rules:',
    '1. The array length MUST equal the number of input segments.',
    `2. Segment i of the output must be the translation of segment i of the input.`,
    '3. Keep numbers, code, URLs, emails and proper nouns unchanged.',
    '4. Translate faithfully and naturally, do not summarize or add explanations.',
    '5. Never output anything outside the JSON object.',
  ].join('\n');
}

async function requestOnce(segments, targetLang) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt(targetLang) },
        { role: 'user', content: JSON.stringify({ segments }) },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

const samples = [
  'The transformer architecture replaced recurrence with self-attention, which lets every token attend to every other token in a single step.',
  'In 2024 the model was trained on 14.8 trillion tokens and served at https://api.deepseek.com/v1/chat/completions for $0.27 per million input tokens.',
  'A quick start guide.',
  'Engineering teams should measure p95 latency, not just the average, because tail latency is what users actually feel.',
];

const started = Date.now();
try {
  const data = await requestOnce(samples, 'zh-CN');
  const latency = Date.now() - started;
  const content = data.choices[0].message.content;
  const parsed = JSON.parse(content);
  const translations = parsed.translations;

  console.log(`model      : ${data.model}`);
  console.log(`latency    : ${latency}ms`);
  console.log(`usage      :`, JSON.stringify(data.usage));
  console.log(`segments   : ${samples.length} in / ${translations.length} out`);
  console.log('---');
  translations.forEach((t, i) => console.log(`[${i + 1}] ${t}`));
  console.log('---');
  console.log('count ok   :', translations.length === samples.length);
  const joined = translations.join('\n');
  console.log('url kept   :', joined.includes('https://api.deepseek.com/v1/chat/completions'));
  console.log('number kept:', joined.includes('14.8'));
  const cost = (data.usage.prompt_tokens * 0.27 + data.usage.completion_tokens * 1.1) / 1e6;
  console.log(`cost       : $${cost.toFixed(6)} (this batch)`);
} catch (error) {
  console.error('FAILED:', error.message);
  process.exit(1);
}
