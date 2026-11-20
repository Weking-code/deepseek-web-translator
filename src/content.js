'use strict';

/**
 * DeepSeek 网页翻译 —— 内容脚本
 *
 * 版式：逐段翻译 + 中英对照。
 *   1. 找出页面里所有「叶子块」（p / li / h1-h6 / td / 只含文字的 div…）
 *   2. 把整段文字送去翻译（整段翻译，上下文完整，质量比逐词好很多）
 *   3. 把译文作为一个独立的块级元素插在原文段落「下面」
 *      —— 原文一个字符都不改，所以还原是无损的，链接和排版也不会坏
 *   4. 「仅译文」模式下用 CSS 把原文段落隐藏起来，DOM 仍然保留
 */

(() => {
  if (window.__dstLoaded) return;
  window.__dstLoaded = true;

  /* ------------------------------------------------------------ 常量 */

  // 这些标签里的文字永远不翻译
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS',
    'SVG', 'MATH', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA',
    'INPUT', 'SELECT', 'OPTION', 'VIDEO', 'AUDIO', 'TEMPLATE',
  ]);

  // 块级标签：用于判断一个元素是不是「叶子块」
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS',
    'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
    'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN',
    'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD',
    'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ]);

  // 译文插进元素「内部」的标签（否则插在元素后面）
  const APPEND_INSIDE = new Set([
    'LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION',
    'SUMMARY', 'ADDRESS',
  ]);

  const CANDIDATE_SELECTOR = [
    'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'td', 'th', 'dd', 'dt', 'blockquote', 'figcaption', 'caption', 'summary',
    'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'address',
  ].join(',');

  const MAX_BLOCKS = 900;
  const MAX_TEXT_LENGTH = 3000;

  /* ------------------------------------------------------------ 状态 */

  const state = {
    active: false,
    translating: false,
    mode: 'bilingual', // bilingual | replace
    targetLang: 'zh-CN',
    settings: null,
    records: new Map(), // Element -> { block: HTMLElement|null, originalText }
    doneKeys: new Set(),
    token: 0,
    observer: null,
    rescanTimer: null,
    progress: { done: 0, total: 0 },
    cachedCount: 0, // 本次有多少段直接用了本地缓存（不产生费用）
  };

  /* ------------------------------------------------------------ 工具 */

  function normalize(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function isAlreadyTarget(text) {
    const lang = state.targetLang || 'zh-CN';
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
    const letters = (text.match(/[\p{L}]/gu) || []).length || 1;

    if (lang.startsWith('zh')) return cjk / letters > 0.45;
    if (lang === 'ja') return kana / letters > 0.12 || cjk / letters > 0.85;
    if (lang === 'ko') return hangul / letters > 0.4;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return latin / letters > 0.92;
  }

  function isTranslatable(text) {
    const trimmed = String(text || '').trim();
    if (trimmed.length < 2) return false;
    if (trimmed.length > MAX_TEXT_LENGTH) return false;
    if (!/[\p{L}]/u.test(trimmed)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(trimmed)) return false;
    if (isAlreadyTarget(trimmed)) return false;
    return true;
  }

  const skipCache = new WeakMap();

  function isSkipped(el) {
    if (!el) return true;
    const cached = skipCache.get(el);
    if (cached !== undefined) return cached;

    let skipped = false;
    let cursor = el;
    for (let depth = 0; cursor && depth < 10; depth++, cursor = cursor.parentElement) {
      if (cursor.nodeType !== 1) continue;
      if (SKIP_TAGS.has(cursor.tagName)) {
        skipped = true;
        break;
      }
      if (cursor.isContentEditable) {
        skipped = true;
        break;
      }
      if (cursor.hasAttribute('data-dst-ui')) {
        skipped = true;
        break;
      }
      if (cursor.getAttribute('translate') === 'no') {
        skipped = true;
        break;
      }
      if (cursor.getAttribute('aria-hidden') === 'true') {
        skipped = true;
        break;
      }
    }

    if (!skipped) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        skipped = true;
      } else if (!el.getClientRects().length) {
        skipped = true;
      }
    }

    skipCache.set(el, skipped);
    return skipped;
  }

  /** 取元素里所有可见文字（跳过 code/pre 等），保留原始空格 */
  function extractText(root) {
    const parts = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === 1) {
            if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
            if (node.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
            if (node.hasAttribute('data-dst-ui')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) parts.push(node.nodeValue);
    }
    return normalize(parts.join(''));
  }

  function hasBlockDescendant(el) {
    const stack = Array.from(el.children);
    while (stack.length) {
      const node = stack.pop();
      if (BLOCK_TAGS.has(node.tagName)) return true;
      if (node.children.length) stack.push(...node.children);
    }
    return false;
  }

  /** 收集页面里所有需要翻译的「叶子块」 */
  function collectBlocks(root) {
    const result = [];
    if (!root) return result;
    let candidates;
    try {
      candidates = root.querySelectorAll(CANDIDATE_SELECTOR);
    } catch {
      return result;
    }

    for (const el of candidates) {
      if (result.length >= MAX_BLOCKS) break;
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (el.hasAttribute('data-dst-ui')) continue;
      if (state.records.has(el)) continue;
      if (hasBlockDescendant(el)) continue; // 只处理最内层的块，避免重复翻译
      if (isSkipped(el)) continue;
      const text = extractText(el);
      if (!isTranslatable(text)) continue;
      result.push({ el, text });
    }
    return result;
  }

  /* -------------------------------------------------------------- 发请求 */

  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message || '扩展通信失败，请刷新页面后重试'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function translateSegments(segments, options = {}) {
    const response = await sendMessage({
      type: 'translateBatch',
      segments,
      targetLang: options.targetLang || state.targetLang,
      force: Boolean(options.force),
    });
    if (!response) throw new Error('扩展没有响应，请刷新页面后重试');
    if (!response.ok) throw new Error(response.error || '翻译失败');
    return {
      translations: response.translations || [],
      cachedCount: Number(response.cachedCount) || 0,
    };
  }

  async function loadSettings() {
    const response = await sendMessage({ type: 'getSettings' });
    return (response && response.settings) || {};
  }

  /* ---------------------------------------------------------- 页面 UI */

  let ui = null;

  function ensureUI() {
    if (ui) return ui;

    const host = document.createElement('div');
    host.setAttribute('data-dst-ui', '1');
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing: border-box; }
      .toast {
        position: fixed; right: 18px; bottom: 18px;
        display: none; align-items: center; gap: 9px;
        padding: 9px 15px; border-radius: 999px;
        background: rgba(17, 24, 39, .93); color: #fff;
        box-shadow: 0 10px 30px rgba(0, 0, 0, .28);
        font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        pointer-events: auto; max-width: min(380px, 72vw);
        opacity: 0; transform: translateY(6px);
        transition: opacity .18s ease, transform .18s ease;
      }
      .toast.show { display: flex; opacity: 1; transform: translateY(0); }
      .toast.error { background: rgba(153, 27, 27, .96); }
      .toast .spinner {
        width: 13px; height: 13px; flex: 0 0 auto;
        border: 2px solid rgba(255,255,255,.3);
        border-top-color: #fff; border-radius: 50%;
        animation: spin .7s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .toast .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .bubble {
        position: fixed; display: none; pointer-events: auto;
        align-items: center; gap: 5px;
        padding: 6px 12px; border-radius: 999px;
        background: linear-gradient(135deg, #4d6bfe, #7c5cff);
        color: #fff; font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        box-shadow: 0 6px 20px rgba(77, 107, 254, .45);
        cursor: pointer; user-select: none; border: none; outline: none;
      }
      .bubble.show { display: inline-flex; }
      .bubble:hover { filter: brightness(1.08); }

      .card {
        position: fixed; display: none; pointer-events: auto;
        width: min(430px, calc(100vw - 32px));
        background: #fff; color: #111827;
        border-radius: 14px; overflow: hidden;
        box-shadow: 0 18px 50px rgba(0, 0, 0, .25), 0 0 0 1px rgba(0,0,0,.06);
        font: 14px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .card.show { display: block; }
      .card-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; padding: 10px 14px;
        border-bottom: 1px solid #eef0f4; background: #fafbff;
      }
      .card-title { font-weight: 700; font-size: 12.5px; color: #4d6bfe; letter-spacing: .3px; }
      .card-actions { display: flex; gap: 4px; }
      .icon-btn {
        border: none; background: transparent; cursor: pointer;
        color: #6b7280; font: 12px/1 inherit; padding: 5px 8px; border-radius: 7px;
        font-family: inherit;
      }
      .icon-btn:hover { background: #eef1ff; color: #4d6bfe; }
      .card-body {
        padding: 13px 15px; max-height: 42vh; overflow: auto;
        white-space: pre-wrap; word-break: break-word;
      }
      .card-src {
        padding: 10px 15px 13px; color: #9ca3af; font-size: 12px;
        border-top: 1px dashed #eef0f4;
        max-height: 92px; overflow: hidden; white-space: pre-wrap; word-break: break-word;
      }
      .card.loading .card-body { color: #9ca3af; }

      @media (prefers-color-scheme: dark) {
        .card { background: #171a21; color: #e5e7eb; box-shadow: 0 18px 50px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08); }
        .card-head { background: #1c2029; border-bottom-color: #262b36; }
        .card-src { color: #6b7280; border-top-color: #262b36; }
        .icon-btn:hover { background: #232838; }
      }

      /* ---------- 页面右侧的悬浮翻译按钮 ---------- */
      .fab-wrap {
        position: fixed; right: 0; top: 50%; z-index: 2147483647;
        transform: translateY(-50%); pointer-events: none;
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      }
      .fab-wrap.hidden { display: none; }
      .fab {
        pointer-events: auto; display: flex; align-items: center;
        padding: 6px; border: 1px solid rgba(17, 24, 39, .1); border-right: 0;
        border-radius: 40px 0 0 40px; background: #fff; cursor: pointer;
        box-shadow: 0 8px 22px rgba(17, 24, 39, .16);
        transition: box-shadow .18s ease, transform .12s ease;
        touch-action: none; user-select: none; -webkit-user-select: none;
        font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .fab:hover { box-shadow: 0 10px 28px rgba(77, 107, 254, .32); }
      .fab:active { transform: scale(.96); }
      .fab-label {
        max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap;
        font: 600 12.5px/1 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        color: #4d6bfe; transition: max-width .2s ease, opacity .16s ease, margin .2s ease;
      }
      .fab:hover .fab-label, .fab.busy .fab-label {
        max-width: 150px; opacity: 1; margin-right: 9px;
      }
      .fab-icon {
        position: relative; width: 34px; height: 34px; border-radius: 50%;
        display: grid; place-items: center; flex: 0 0 auto;
        background: linear-gradient(135deg, #4d6bfe, #7c5cff); color: #fff;
        font: 700 16px/1 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        box-shadow: 0 4px 12px rgba(77, 107, 254, .4);
        transition: background .25s ease, box-shadow .25s ease;
      }
      .fab.on .fab-icon {
        background: linear-gradient(135deg, #10b981, #059669);
        box-shadow: 0 4px 12px rgba(5, 150, 105, .4);
      }
      .fab.busy .fab-icon { background: linear-gradient(135deg, #93a6ff, #b39dff); }
      .fab-spin {
        position: absolute; inset: -3px; border-radius: 50%;
        border: 2px solid rgba(77, 107, 254, .25); border-top-color: #4d6bfe;
        display: none; animation: spin .75s linear infinite;
      }
      .fab.busy .fab-spin { display: block; }

      /* 整理文献按钮（悬浮组里的第二个） */
      .fab-note { padding: 5px; }
      .fab-note .fab-icon {
        width: 28px; height: 28px; font-size: 13px;
        background: linear-gradient(135deg, #f472b6, #a855f7);
        box-shadow: 0 4px 12px rgba(168, 85, 247, .38);
      }
      .fab-note.busy .fab-icon { background: linear-gradient(135deg, #f9a8d4, #c4b5fd); }
      .fab-note:hover .fab-label, .fab-note.busy .fab-label { max-width: 150px; opacity: 1; margin-right: 9px; }

      /* ---------- 文献总结面板 ---------- */
      .npanel {
        position: fixed; right: 16px; top: 50%; transform: translateY(-50%);
        display: none; flex-direction: column; pointer-events: auto;
        width: min(620px, calc(100vw - 32px)); max-height: 86vh;
        background: #fff; color: #111827; border-radius: 16px; overflow: hidden;
        box-shadow: 0 24px 70px rgba(15, 23, 42, .32), 0 0 0 1px rgba(15, 23, 42, .07);
        font: 14px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .npanel.show { display: flex; }
      .np-head {
        display: flex; align-items: center; gap: 10px; padding: 11px 16px;
        background: linear-gradient(135deg, #4d6bfe, #7c5cff); color: #fff; flex: 0 0 auto;
      }
      .np-title { font-weight: 700; font-size: 14px; }
      .np-sub {
        margin-left: auto; font-size: 12px; opacity: .88;
        max-width: 56%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .np-close {
        border: 0; background: rgba(255,255,255,.18); color: #fff; cursor: pointer;
        width: 24px; height: 24px; border-radius: 50%; font: 15px/1 inherit; padding: 0;
        display: grid; place-items: center; font-family: inherit;
      }
      .np-close:hover { background: rgba(255,255,255,.32); }
      .np-body { padding: 13px 16px; overflow: auto; flex: 1 1 auto; }
      .np-meta { font-size: 12px; color: #6b7280; margin-bottom: 11px; line-height: 1.6; word-break: break-word; }
      .np-meta b { color: #111827; font-weight: 600; }
      .np-meta a { color: #4d6bfe; text-decoration: underline; text-underline-offset: 2px; }
      .np-none { color: #b45309; }
      .nsec {
        border: 1px solid #e8ebf2; border-radius: 10px; padding: 9px 12px;
        margin-bottom: 9px; background: #fcfdff; transition: opacity .15s ease, background .15s ease;
      }
      .nsec.off { opacity: .45; background: #f5f6f8; }
      .nsec-head { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; -webkit-user-select: none; }
      .nsec-head input { accent-color: #4d6bfe; width: 15px; height: 15px; cursor: pointer; margin: 0; flex: 0 0 auto; }
      .nsec-title { font-weight: 700; font-size: 13px; color: #334155; }
      .nsec-body { margin-top: 5px; font-size: 13.5px; color: #1f2937; }
      .nsec-body p { margin: 0 0 6px; }
      .nsec-body p:last-child { margin-bottom: 0; }
      .nsec-body ul { margin: 0; padding-left: 18px; }
      .nsec-body li { margin: 2px 0; }
      .nsec-body li::marker { color: #94a3b8; }
      .np-empty { color: #9ca3af; font-size: 13px; }
      .np-notes-label { font-size: 12px; color: #6b7280; margin: 4px 0 2px; }
      .np-notes {
        width: 100%; min-height: 82px; resize: vertical; box-sizing: border-box;
        border: 1px solid #e2e8f0; border-radius: 9px; padding: 8px 10px;
        font: inherit; font-size: 13.5px; color: inherit; background: #fff;
      }
      .np-notes:focus { outline: 2px solid rgba(77, 107, 254, .35); outline-offset: 0; border-color: #4d6bfe; }
      .np-foot {
        display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 16px;
        border-top: 1px solid #eef1f6; background: #fafbff; flex: 0 0 auto;
      }
      .np-dest {
        display: flex; align-items: center; gap: 7px; width: 100%;
        padding-bottom: 9px; margin-bottom: 1px; border-bottom: 1px dashed #e6eaf3;
        font-size: 12px; color: #6b7280;
      }
      .np-dest-name {
        font-weight: 600; color: #334155; max-width: 46%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .np-dest-name.empty { font-weight: 500; color: #b45309; }
      .np-hint { font-size: 12px; color: #6b7280; margin-right: auto; max-width: 48%; line-height: 1.45; }
      .np-btn {
        border: 1px solid #dbe2ee; background: #fff; color: #334155; border-radius: 8px;
        padding: 7px 13px; font: 600 12.5px/1.2 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        cursor: pointer; white-space: nowrap;
      }
      .np-btn:hover { border-color: #b9c6e4; background: #f3f6ff; }
      .np-btn.tiny { padding: 4px 10px; font-size: 11.5px; border-radius: 7px; margin-left: auto; }
      .np-btn.pulse { border-color: #4d6bfe; color: #4d6bfe; animation: dstPulse 1.2s ease-in-out infinite; }
      @keyframes dstPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(77, 107, 254, .38); }
        55% { box-shadow: 0 0 0 6px rgba(77, 107, 254, 0); }
      }
      .np-btn.primary { border: 0; background: linear-gradient(135deg, #4d6bfe, #7c5cff); color: #fff; }
      .np-btn.primary:hover { filter: brightness(1.07); background: linear-gradient(135deg, #4d6bfe, #7c5cff); }
      .np-btn[disabled] { opacity: .55; cursor: default; }
      .np-loading { display: flex; align-items: center; gap: 10px; color: #4d6bfe; font-size: 13px; padding: 26px 4px; }
      .np-spin {
        width: 16px; height: 16px; flex: 0 0 auto; border-radius: 50%;
        border: 2px solid rgba(77, 107, 254, .22); border-top-color: #4d6bfe;
        animation: spin .75s linear infinite;
      }
      /* 我的笔记：放在最上面 */
      .np-notes-wrap {
        border: 1px solid rgba(77, 107, 254, .22); background: rgba(77, 107, 254, .045);
        border-radius: 11px; padding: 10px 12px 11px; margin-bottom: 12px;
      }
      .np-notes-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 6px; }
      .np-notes-label { font-size: 13px; font-weight: 700; color: #334155; }
      .np-notes-tip { font-size: 11.5px; font-weight: 400; color: #8b95a7; }
      .np-notes { display: block; width: 100%; min-height: 74px; resize: vertical; box-sizing: border-box; border: 1px solid #dfe6f3; border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 13.5px; color: inherit; background: #fff; }
      .np-notes:focus { outline: 2px solid rgba(77, 107, 254, .35); outline-offset: 0; border-color: #4d6bfe; }
      .np-shots { display: flex; align-items: center; gap: 9px; margin-top: 8px; flex-wrap: wrap; }
      .np-shots-tip { font-size: 11.5px; color: #8b95a7; }
      .np-thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
      .np-thumbs:empty { display: none; }
      .np-thumb { position: relative; width: 96px; height: 68px; border-radius: 8px; overflow: hidden; border: 1px solid #dfe6f3; background: #fff; }
      .np-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .np-thumb button {
        position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border-radius: 50%;
        border: 0; padding: 0; cursor: pointer; font: 12px/1 system-ui, sans-serif;
        background: rgba(17, 24, 39, .62); color: #fff; display: grid; place-items: center;
      }
      .np-thumb button:hover { background: #dc2626; }
      /* 可编辑的小节正文 */
      .nsec-body .nsec-edit {
        white-space: pre-wrap; word-break: break-word; outline: none; border-radius: 6px;
        padding: 3px 5px; margin: -3px -5px; transition: background .15s ease;
      }
      .nsec-body .nsec-edit:focus { background: rgba(77, 107, 254, .07); box-shadow: 0 0 0 1px rgba(77, 107, 254, .3); }
      .nsec-body .nsec-edit:empty::before { content: attr(data-ph); color: #9aa3b2; }
      .nsec-tag {
        margin-left: auto; font-size: 10.5px; font-weight: 500; color: #9aa3b2;
        border: 1px solid #e3e8f2; border-radius: 20px; padding: 1px 7px;
      }
      .nsec-tag.hot { color: #4d6bfe; border-color: rgba(77, 107, 254, .38); background: rgba(77, 107, 254, .07); }
      /* 快速翻译面板 */
      .qpanel {
        position: fixed; right: 16px; top: 50%; transform: translateY(-50%);
        display: none; flex-direction: column; pointer-events: auto;
        width: min(368px, calc(100vw - 32px)); max-height: 82vh;
        background: #fff; color: #111827; border-radius: 16px; overflow: hidden;
        box-shadow: 0 24px 70px rgba(15, 23, 42, .32), 0 0 0 1px rgba(15, 23, 42, .07);
        font: 14px/1.65 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .qpanel.show { display: flex; }
      .q-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 9px; overflow: auto; }
      .q-input {
        width: 100%; min-height: 96px; resize: vertical; box-sizing: border-box;
        border: 1px solid #dfe6f3; border-radius: 10px; padding: 9px 11px;
        font: inherit; font-size: 13.5px; color: inherit; background: #fff;
      }
      .q-input:focus { outline: 2px solid rgba(77, 107, 254, .35); outline-offset: 0; border-color: #4d6bfe; }
      .q-actions { display: flex; align-items: center; gap: 8px; }
      .q-hint { font-size: 11.5px; color: #9aa3b2; margin-left: auto; text-align: right; line-height: 1.4; }
      .q-result { font-size: 13.5px; line-height: 1.72; color: #1f2937; }
      .q-result:empty { display: none; }
      .q-wordline { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
      .q-word { font-weight: 700; font-size: 16px; color: #111827; }
      .q-phon { font-size: 12.5px; color: #6b7280; }
      .q-entry { display: flex; gap: 9px; margin: 4px 0; }
      .q-pos { flex: 0 0 46px; color: #4d6bfe; font-weight: 600; font-size: 12.5px; }
      .q-mean { flex: 1 1 auto; }
      .q-tr { white-space: pre-wrap; }
      .q-terms { margin-top: 9px; border-top: 1px dashed #e6eaf3; padding-top: 8px; font-size: 12.5px; color: #6b7280; }
      .q-terms b { color: #334155; font-weight: 600; }
      .q-tools { display: flex; gap: 8px; margin-top: 10px; }
      .q-empty { color: #9ca3af; font-size: 13px; }
      .q-loading { display: flex; align-items: center; gap: 9px; color: #4d6bfe; font-size: 13px; }

      @media (prefers-color-scheme: dark) {
        .npanel { background: #171a21; color: #e5e7eb; box-shadow: 0 24px 70px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.08); }
        .np-meta { color: #9ca3af; }
        .np-meta b { color: #e5e7eb; }
        .np-meta a { color: #9db0ff; }
        .np-none { color: #fbbf24; }
        .nsec { background: #1b2029; border-color: #262b36; }
        .nsec.off { background: #191d25; }
        .nsec-title { color: #cbd5e1; }
        .nsec-body { color: #dbe1ea; }
        .np-notes { background: #1b2029; border-color: #2b3240; color: #e5e7eb; }
        .np-notes-label { color: #cbd5e1; }
        .np-notes-tip { color: #8b95a7; }
        .np-notes-wrap { border-color: rgba(140, 165, 255, .26); background: rgba(120, 150, 255, .08); }
        .np-shots-tip { color: #8b95a7; }
        .np-thumb { border-color: #2f3646; background: #1b2029; }
        .nsec-tag { border-color: #2f3646; color: #8b95a7; }
        .nsec-tag.hot { color: #9db0ff; border-color: rgba(157, 176, 255, .4); background: rgba(120, 150, 255, .12); }
        .nsec-body .nsec-edit:focus { background: rgba(120, 150, 255, .12); box-shadow: 0 0 0 1px rgba(157, 176, 255, .4); }
        .qpanel { background: #171a21; color: #e5e7eb; box-shadow: 0 24px 70px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.08); }
        .q-input { background: #1b2029; border-color: #2b3240; color: #e5e7eb; }
        .q-word { color: #e5e7eb; }
        .q-phon { color: #9ca3af; }
        .q-wordline .q-word { color: #e5e7eb; }
        .q-result { color: #dbe1ea; }
        .q-terms { border-top-color: #2b3240; color: #9ca3af; }
        .q-terms b { color: #cbd5e1; }
        .q-hint { color: #7f8899; }
        .q-loading { color: #9db0ff; }
        .np-foot { background: #1c2029; border-top-color: #262b36; }
        .np-dest { border-bottom-color: #2b3240; color: #9ca3af; }
        .np-dest-name { color: #cbd5e1; }
        .np-dest-name.empty { color: #fbbf24; }
        .np-btn { background: #232838; border-color: #2f3646; color: #cbd5e1; }
        .np-btn:hover { background: #2a3042; }
        .np-btn.primary { background: linear-gradient(135deg, #4d6bfe, #7c5cff); color: #fff; }
        .np-loading { color: #9db0ff; }
        .np-spin { border-color: rgba(157,176,255,.22); border-top-color: #9db0ff; }
      }
      @media print { .npanel { display: none !important; } }

      @media (prefers-color-scheme: dark) {
        .fab { background: #1b202b; border-color: rgba(255, 255, 255, .12); }
        .fab-label { color: #9db0ff; }
        .fab-spin { border-color: rgba(157, 176, 255, .22); border-top-color: #9db0ff; }
      }
      @media print { .fab-wrap { display: none !important; } }
    `;
    shadow.appendChild(style);

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = '<span class="spinner"></span><span class="text"></span>';
    shadow.appendChild(toast);

    const bubble = document.createElement('button');
    bubble.className = 'bubble';
    bubble.type = 'button';
    bubble.textContent = '译';
    shadow.appendChild(bubble);

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-head">
        <span class="card-title">DEEPSEEK 翻译</span>
        <span class="card-actions">
          <button class="icon-btn" data-act="copy" type="button">复制</button>
          <button class="icon-btn" data-act="close" type="button">关闭</button>
        </span>
      </div>
      <div class="card-body"></div>
      <div class="card-src"></div>
    `;
    shadow.appendChild(card);

    const fabWrap = document.createElement('div');
    fabWrap.className = 'fab-wrap';
    fabWrap.innerHTML = `
      <button class="fab fab-quick" type="button" title="快速翻译：查词 / 粘贴句子" aria-label="快速翻译">
        <span class="fab-label">快速翻译</span>
        <span class="fab-icon"><span class="fab-glyph">文</span><span class="fab-spin"></span></span>
      </button>
      <button class="fab fab-note" type="button" title="整理这篇文献：总结 + 笔记 + 导出 md" aria-label="整理这篇文献">
        <span class="fab-label">整理文献</span>
        <span class="fab-icon"><span class="fab-glyph">摘</span><span class="fab-spin"></span></span>
      </button>
      <button class="fab" type="button" title="翻译此页" aria-label="翻译此页">
        <span class="fab-label">翻译此页</span>
        <span class="fab-icon"><span class="fab-glyph">译</span><span class="fab-spin"></span></span>
      </button>
    `;
    shadow.appendChild(fabWrap);

    const panel = document.createElement('div');
    panel.className = 'npanel';
    panel.innerHTML = `
      <div class="np-head">
        <span class="np-title">文献总结</span>
        <span class="np-sub"></span>
        <button class="np-close" type="button" title="关闭">×</button>
      </div>
      <div class="np-body"></div>
      <div class="np-foot">
        <div class="np-dest">
          <span>保存到</span>
          <span class="np-dest-name empty">还没有选择文件夹</span>
          <button class="np-btn tiny" type="button" data-act="pick">选择文件夹</button>
        </div>
        <span class="np-hint"></span>
        <button class="np-btn" type="button" data-act="copy">复制 MD</button>
        <button class="np-btn" type="button" data-act="retry">重新生成</button>
        <button class="np-btn primary" type="button" data-act="save">保存为 .md</button>
      </div>
    `;
    shadow.appendChild(panel);

    const qpanel = document.createElement('div');
    qpanel.className = 'qpanel';
    qpanel.innerHTML = `
      <div class="np-head">
        <span class="np-title">快速翻译</span>
        <span class="np-sub">查词 / 句子</span>
        <button class="np-close" type="button" data-act="qclose" title="关闭">×</button>
      </div>
      <div class="q-body">
        <textarea class="q-input" placeholder="粘贴一句英文，或输入一个词；Ctrl+Enter 直接翻译"></textarea>
        <div class="q-actions">
          <button class="np-btn" type="button" data-act="qword">查词</button>
          <button class="np-btn primary" type="button" data-act="qsent">翻译句子</button>
          <span class="q-hint"></span>
        </div>
        <div class="q-result"></div>
      </div>
    `;
    shadow.appendChild(qpanel);

    const filePicker = document.createElement('input');
    filePicker.type = 'file';
    filePicker.accept = 'image/*';
    filePicker.multiple = true;
    filePicker.style.display = 'none';
    shadow.appendChild(filePicker);

    const fabQuick = fabWrap.querySelector('.fab-quick');
    const fab = fabWrap.querySelector('.fab:not(.fab-note):not(.fab-quick)');
    const fabNote = fabWrap.querySelector('.fab-note');

    ui = {
      host,
      shadow,
      toast,
      toastText: toast.querySelector('.text'),
      toastSpinner: toast.querySelector('.spinner'),
      bubble,
      card,
      cardBody: card.querySelector('.card-body'),
      cardSrc: card.querySelector('.card-src'),
      fabWrap,
      fab,
      fabLabel: fab.querySelector('.fab-label'),
      fabQuick,
      fabQuickLabel: fabQuick.querySelector('.fab-label'),
      fabNote,
      fabNoteLabel: fabNote.querySelector('.fab-label'),
      panel,
      panelSub: panel.querySelector('.np-sub'),
      panelBody: panel.querySelector('.np-body'),
      panelHint: panel.querySelector('.np-hint'),
      destName: panel.querySelector('.np-dest-name'),
      pickBtn: panel.querySelector('.np-btn[data-act="pick"]'),
      qpanel,
      qInput: qpanel.querySelector('.q-input'),
      qResult: qpanel.querySelector('.q-result'),
      qHint: qpanel.querySelector('.q-hint'),
      filePicker,
    };

    card.addEventListener('click', (event) => {
      const action = event.target && event.target.dataset && event.target.dataset.act;
      if (action === 'close') hideCard();
      if (action === 'copy') copyText(ui.cardBody.textContent || '');
    });
    bubble.addEventListener('mousedown', (event) => event.preventDefault());
    bubble.addEventListener('click', onBubbleClick);

    /* ------------- 悬浮按钮：翻译 / 整理文献，两个都能上下拖动 ------------- */

    const suppressed = new WeakSet();
    let fabDrag = null;

    fab.addEventListener('click', (event) => {
      event.preventDefault();
      if (suppressed.has(fab)) {
        suppressed.delete(fab);
        return;
      }
      if (state.translating) return;
      if (state.active) restore();
      else runTranslation({ forceBilingual: true }).catch(() => {});
      syncFab();
    });

    fabNote.addEventListener('click', (event) => {
      event.preventDefault();
      if (suppressed.has(fabNote)) {
        suppressed.delete(fabNote);
        return;
      }
      openNotePanel().catch(() => {});
    });

    const endFabDrag = (event) => {
      if (!fabDrag || (event && event.pointerId !== fabDrag.id)) return;
      const moved = fabDrag.moved;
      const target = fabDrag.target;
      fabDrag = null;
      if (!moved) return;
      suppressed.add(target);
      const ratio = (parseFloat(fabWrap.style.top) || 50) / 100;
      try {
        chrome.storage.local.set({ fabTopRatio: ratio }).catch(() => {});
      } catch {
        /* ignore */
      }
    };

    const attachDrag = (btn) => {
      btn.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const rect = fabWrap.getBoundingClientRect();
        const vh = Math.max(1, window.innerHeight);
        fabDrag = {
          id: event.pointerId,
          startY: event.clientY,
          centerRatio: (rect.top + rect.height / 2) / vh,
          moved: false,
          target: btn,
        };
        try {
          btn.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      });

      btn.addEventListener('pointermove', (event) => {
        if (!fabDrag || event.pointerId !== fabDrag.id) return;
        const vh = Math.max(1, window.innerHeight);
        const dy = event.clientY - fabDrag.startY;
        if (!fabDrag.moved && Math.abs(dy) < 5) return;
        fabDrag.moved = true;
        const ratio = Math.min(0.94, Math.max(0.06, fabDrag.centerRatio + dy / vh));
        fabWrap.style.top = `${ratio * 100}%`;
      });

      btn.addEventListener('pointerup', endFabDrag);
      btn.addEventListener('pointercancel', endFabDrag);
    };

    attachDrag(fab);
    attachDrag(fabNote);
    attachDrag(fabQuick);

    panel.addEventListener('click', (event) => {
      const target = event.target;
      const action = target && target.dataset ? target.dataset.act : '';
      if (target === panel.querySelector('.np-close')) closeNotePanel();
      else if (action === 'copy') copyText(buildNoteMarkdown());
      else if (action === 'retry') openNotePanel({ force: true }).catch(() => {});
      else if (action === 'save') saveNoteMarkdown().catch(() => {});
      else if (action === 'pick') chooseNoteFolder().catch(() => {});
      else if (action === 'shot') ui.filePicker.click();
      else if (action === 'rmimg') removeImage(Number(target.dataset.i));
    });

    // 图片：从文件选择器、剪贴板、拖拽三个入口都能进来
    filePicker.addEventListener('change', () => {
      for (const file of Array.from(filePicker.files || [])) addImageBlob(file);
      filePicker.value = '';
    });

    panel.addEventListener('paste', (event) => {
      const items = (event.clipboardData && event.clipboardData.items) || [];
      let handled = false;
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && /^image\//i.test(item.type)) {
          const file = item.getAsFile();
          if (file) {
            addImageBlob(file);
            handled = true;
          }
        }
      }
      if (handled) event.preventDefault();
    });

    panel.addEventListener('dragover', (event) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
        event.preventDefault();
      }
    });

    panel.addEventListener('drop', (event) => {
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
      if (!files.length) return;
      event.preventDefault();
      for (const file of files) addImageBlob(file);
    });

    // 面板里打字别把按键漏给网页自己的快捷键
    for (const el of [panel, qpanel]) {
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') event.stopPropagation();
      });
      el.addEventListener('keypress', (event) => event.stopPropagation());
      el.addEventListener('keyup', (event) => event.stopPropagation());
    }

    // 小节正文可以直接编辑
    panel.addEventListener('input', (event) => {
      const target = event.target;
      if (!target || !target.dataset) return;
      if (target.dataset.edit) {
        applyEdit(target.dataset.edit, target.innerText);
        scheduleDraftSave();
      }
    });

    // 勾选要保留的小节
    panel.addEventListener('change', (event) => {
      const input = event.target;
      if (!input || input.type !== 'checkbox' || !input.dataset || !input.dataset.sec) return;
      const key = input.dataset.sec;
      if (input.checked) note.selected.add(key);
      else note.selected.delete(key);
      const section = panel.querySelector(`.nsec[data-sec="${key}"]`);
      if (section) section.classList.toggle('off', !input.checked);
      scheduleDraftSave();
    });

    fabQuick.addEventListener('pointerdown', () => {
      const selection = window.getSelection();
      quick.seed = selection && !selection.isCollapsed ? String(selection).slice(0, 3000).trim() : '';
    });

    fabQuick.addEventListener('click', (event) => {
      event.preventDefault();
      if (suppressed.has(fabQuick)) {
        suppressed.delete(fabQuick);
        return;
      }
      if (quick.open) closeQuickPanel();
      else openQuickPanel();
    });

    qpanel.addEventListener('click', (event) => {
      const target = event.target;
      const action = target && target.dataset ? target.dataset.act : '';
      if (action === 'qclose') closeQuickPanel();
      else if (action === 'qword') runQuick('word').catch(() => {});
      else if (action === 'qsent') runQuick('sentence').catch(() => {});
      else if (action === 'qcopy') copyText(quick.lastText || '');
    });

    qpanel.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        const text = ui.qInput.value || '';
        runQuick(/\s/.test(text.trim()) || text.trim().length > 24 ? 'sentence' : 'word').catch(() => {});
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeQuickPanel();
      }
    });

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && note.open) closeNotePanel();
        if (event.key === 'Escape' && quick.open) closeQuickPanel();
      },
      true,
    );

    return ui;
  }

  function copyText(text) {
    try {
      navigator.clipboard.writeText(text).then(
        () => flashToast('已复制'),
        () => flashToast('复制失败', true),
      );
    } catch {
      flashToast('复制失败', true);
    }
  }

  const quick = { open: false, busy: false, seed: '', lastText: '' };

  function openQuickPanel(prefill) {
    const view = ensureUI();
    if (note.open) closeNotePanel();
    quick.open = true;
    view.qpanel.classList.add('show');
    const seed = typeof prefill === 'string' ? prefill : quick.seed;
    if (seed) view.qInput.value = seed.slice(0, 4000);
    view.qHint.textContent = 'Ctrl+Enter 直接翻译';
    view.qResult.innerHTML = '';
    setTimeout(() => {
      view.qInput.focus();
      const n = view.qInput.value.length;
      try {
        view.qInput.setSelectionRange(n, n);
      } catch {
        /* ignore */
      }
    }, 30);
  }

  function closeQuickPanel() {
    quick.open = false;
    if (ui) ui.qpanel.classList.remove('show');
  }

  async function runQuick(pattern) {
    const view = ensureUI();
    const text = String(view.qInput.value || '').trim();
    if (!text) {
      view.qHint.textContent = '先粘贴一个词或一句话';
      view.qInput.focus();
      return;
    }
    if (quick.busy) return;
    quick.busy = true;
    view.qHint.textContent = '';
    view.qResult.innerHTML = '<div class="q-loading"><span class="np-spin"></span>正在问 DeepSeek…</div>';
    try {
      const response = await sendMessage({ type: 'quickTranslate', text, pattern });
      if (!response) throw new Error('扩展没有响应');
      if (!response.ok) throw new Error(response.error || '翻译失败');
      renderQuick(response.result, response.pattern);
    } catch (error) {
      view.qResult.innerHTML = `<div class="q-empty">${escapeHtml(
        String(error && error.message ? error.message : error),
      )}</div>`;
    } finally {
      quick.busy = false;
    }
  }

  function renderQuick(result, pattern) {
    const view = ensureUI();
    const data = result || {};
    if (pattern === 'word') {
      const head = String(data.head || '').trim();
      const phonetic = String(data.phonetic || '').trim();
      const entries = (Array.isArray(data.entries) ? data.entries : []).filter(Boolean);
      quick.lastText = [head, ...entries.map((item) => `${item.pos || ''} ${item.meaning || ''}`.trim())]
        .filter(Boolean)
        .join(' · ');
      view.qResult.innerHTML = `
        <div class="q-wordline">
          <span class="q-word">${escapeHtml(head || '（没查到）')}</span>
          ${phonetic ? `<span class="q-phon">${escapeHtml(phonetic)}</span>` : ''}
        </div>
        ${
          entries.length
            ? entries
                .map(
                  (item) =>
                    `<div class="q-entry"><span class="q-pos">${escapeHtml(String(item.pos || ''))}</span><span class="q-mean">${escapeHtml(
                      String(item.meaning || ''),
                    )}</span></div>`,
                )
                .join('')
            : '<div class="q-empty">模型没给出释义</div>'
        }
        <div class="q-tools"><button class="np-btn tiny" type="button" data-act="qcopy">复制</button></div>`;
      return;
    }

    const translation = String(data.translation || '').trim();
    const terms = (Array.isArray(data.terms) ? data.terms : []).filter(Boolean);
    quick.lastText = translation;
    view.qResult.innerHTML = `
      <div class="q-tr">${escapeHtml(translation || '（空）')}</div>
      ${
        terms.length
          ? `<div class="q-terms">术语：${terms
              .map((item) => `<b>${escapeHtml(String(item.term || ''))}</b> → ${escapeHtml(String(item.zh || ''))}`)
              .join('；')}</div>`
          : ''
      }
      <div class="q-tools"><button class="np-btn tiny" type="button" data-act="qcopy">复制译文</button></div>`;
  }

  let toastTimer = null;

  function showToast(text, options = {}) {
    const view = ensureUI();
    clearTimeout(toastTimer);
    view.toast.classList.add('show');
    view.toast.classList.toggle('error', Boolean(options.error));
    view.toastSpinner.style.display = options.spinner === false ? 'none' : '';
    view.toastText.textContent = text;
    if (options.autoHide) toastTimer = setTimeout(hideToast, options.autoHide);
  }

  function flashToast(text, isError) {
    showToast(text, { spinner: false, error: isError, autoHide: 1800 });
  }

  function hideToast() {
    if (!ui) return;
    clearTimeout(toastTimer);
    ui.toast.classList.remove('show');
  }

  /* -------------------------------------------------------- 划词翻译 */

  let bubbleRect = null;
  let selectionText = '';

  function hideBubble() {
    if (ui) ui.bubble.classList.remove('show');
  }

  function showBubble(rect, text) {
    const view = ensureUI();
    bubbleRect = rect;
    selectionText = text;
    view.bubble.classList.add('show');
    const left = Math.min(window.innerWidth - 66, Math.max(8, rect.right + 6));
    const top = Math.min(window.innerHeight - 44, Math.max(8, rect.bottom + 8));
    view.bubble.style.left = `${left}px`;
    view.bubble.style.top = `${top}px`;
  }

  function hideCard() {
    if (!ui) return;
    ui.card.classList.remove('show');
    ui.card.classList.remove('loading');
  }

  function showCard(rect, { source, translation, loading, error }) {
    const view = ensureUI();
    view.card.classList.add('show');
    view.card.classList.toggle('loading', Boolean(loading));
    view.cardBody.textContent = error ? `⚠️ ${error}` : loading ? '正在翻译…' : translation || '';
    view.cardSrc.textContent = source ? source.slice(0, 300) : '';

    const width = Math.min(430, window.innerWidth - 32);
    const left = Math.min(Math.max(12, rect ? rect.left : 40), window.innerWidth - width - 12);
    const preferredTop = rect ? rect.bottom + 12 : 90;
    const top = Math.min(preferredTop, window.innerHeight - 260);
    view.card.style.left = `${Math.max(12, left)}px`;
    view.card.style.top = `${Math.max(12, top)}px`;
  }

  async function onBubbleClick() {
    if (!selectionText) return;
    const rect = bubbleRect;
    hideBubble();
    await translateSelectionText(selectionText, rect);
  }

  async function translateSelectionText(text, rect) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_TEXT_LENGTH) {
      showCard(rect, { source: trimmed, error: '选中的内容太长啦，试试只选一段。' });
      return;
    }
    showCard(rect, { source: trimmed, loading: true });
    try {
      const { translations } = await translateSegments([trimmed]);
      const [translation] = translations;
      showCard(rect, { source: trimmed, translation });
    } catch (error) {
      showCard(rect, { source: trimmed, error: String((error && error.message) || error) });
    }
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (text.length < 2) return null;
    let rect = null;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      return null;
    }
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect };
  }

  document.addEventListener(
    'mouseup',
    (event) => {
      const target = event.target;
      if (target && target.closest && target.closest('[data-dst-ui]')) return;
      setTimeout(() => {
        const selected = readSelection();
        if (selected) showBubble(selected.rect, selected.text);
        else hideBubble();
      }, 10);
    },
    true,
  );

  document.addEventListener(
    'mousedown',
    (event) => {
      const path = event.composedPath ? event.composedPath() : [];
      const inUi = path.some(
        (node) => node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-dst-ui'),
      );
      if (inUi) return;
      hideBubble();
      if (ui && ui.card.classList.contains('show')) hideCard();
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideBubble();
      hideCard();
    }
  });

  window.addEventListener('scroll', hideBubble, { passive: true });

  /* -------------------------------------------------------- 整页翻译 */

  function buildBatches(keys, settings) {
    const maxItems = Math.max(1, Number(settings.batchItems) || 20);
    const maxChars = Math.max(300, Number(settings.batchChars) || 2200);
    const batches = [];
    let current = [];
    let chars = 0;
    for (const key of keys) {
      if (current.length && (current.length >= maxItems || chars + key.length > maxChars)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(key);
      chars += key.length;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  /** 让译文块的字体/字号/颜色与原文段落保持一致（标题看起来还是标题） */
  function parseColor(value) {
    const match = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!match) return null;
    const parts = match[1].split(',').map((part) => parseFloat(part));
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: parts.length > 3 ? parts[3] : 1,
    };
  }

  function relativeLuminance({ r, g, b }) {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /**
   * 找元素背后真正的底色：往上找到第一个接近不透明的背景。
   * 深色站点上原文可能是深色字，照抄过来就看不清了。
   */
  function backdrop(el) {
    let node = el;
    for (let depth = 0; node && depth < 14; node = node.parentElement, depth += 1) {
      let style;
      try {
        style = window.getComputedStyle(node);
      } catch {
        break;
      }
      const color = parseColor(style.backgroundColor);
      if (color && color.a >= 0.5) {
        return { color, isDark: relativeLuminance(color) < 0.45 };
      }
    }
    try {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return { color: { r: 24, g: 27, b: 34, a: 1 }, isDark: true };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function styleLikeSource(node, el) {
    try {
      const style = window.getComputedStyle(el);
      node.style.fontFamily = style.fontFamily;
      node.style.fontSize = style.fontSize;
      node.style.fontWeight = style.fontWeight;
      node.style.fontStyle = style.fontStyle;
      node.style.lineHeight = style.lineHeight;
      node.style.textAlign = style.textAlign;
      node.style.direction = style.direction;

      // 颜色要自适应：照抄的颜色跟底色对比度不够时，换成该背景下的可读色
      const src = parseColor(style.color);
      const bg = backdrop(el);
      const readable =
        src && (!bg || contrastRatio(src, bg.color) >= 4.2) ? src : null;

      if (readable) {
        node.style.color = style.color;
      } else {
        const dark = bg ? bg.isDark : false;
        node.classList.add(dark ? 'dst-on-dark' : 'dst-on-light');
      }
    } catch {
      /* ignore */
    }
  }

  function isOutOfFlow(cs) {
    return cs.position === 'absolute' || cs.position === 'fixed';
  }

  /**
   * 元素被绝对定位、或者待在一个写死高度的浮层里时，
   * 把译文插进它后面/里面只会叠在别的内容上（IEEE 那种小图标栏就是这样）。
   * 往上找到第一个正常文档流的祖先，把译文挂到它后面，就不会压字。
   */
  function findStableAnchor(el) {
    let anchor = el;
    try {
      // 元素自己就在浮层里：译文不能跟着它定位，挂到最近的正常流祖先后面
      if (isOutOfFlow(window.getComputedStyle(el))) anchor = el.parentElement || el;
    } catch {
      /* ignore */
    }
    for (let depth = 0; depth < 6; depth++) {
      const parent = anchor.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      let cs;
      try {
        cs = window.getComputedStyle(parent);
      } catch {
        break;
      }
      const pinned =
        isOutOfFlow(cs) || Boolean(parent.style.height) || Boolean(parent.style.maxHeight);
      if (!pinned) break;
      anchor = parent;
    }
    // 兜底：别挂到 body/html 上
    if (anchor === document.body || anchor === document.documentElement) return el;
    return anchor;
  }

  function insertTranslationBlock(el, text) {
    const anchor = findStableAnchor(el);

    let parent = null;
    let parentDisplay = '';
    try {
      parent = anchor.parentElement;
      parentDisplay = parent ? window.getComputedStyle(parent).display : '';
    } catch {
      parentDisplay = '';
    }

    // 只有「正常文档流里的段落」才往内部插；浮层/固定高度的容器一律挂到它后面
    const inside =
      anchor === el &&
      (APPEND_INSIDE.has(el.tagName) ||
        /flex|grid/.test(parentDisplay) ||
        !parent ||
        parentDisplay === 'contents');

    const node = document.createElement('div');
    node.className = 'dst-block';
    node.setAttribute('data-dst-ui', '1');
    node.setAttribute('translate', 'no');
    node.textContent = text;
    styleLikeSource(node, el);

    if (inside) {
      el.appendChild(node);
    } else if (anchor === el) {
      el.insertAdjacentElement('afterend', node);
    } else {
      anchor.insertAdjacentElement('afterend', node);
    }
    return node;
  }

  /** 收起原文（保留在 DOM 里，随时可还原）。返回包装用的 span 或 null */
  function hideOriginal(el, block) {
    if (!block || block.parentElement !== el) {
      el.classList.add('dst-src-hidden');
      return null;
    }
    // 译文插在元素内部时不能隐藏整个元素——那会把译文一起藏掉。
    // 把原文子节点包进一个 span 再隐藏它（文字节点也能被包住）。
    let wrapper = el.querySelector(':scope > .dst-src-orig');
    if (!wrapper) {
      wrapper = document.createElement('span');
      wrapper.className = 'dst-src-orig';
      wrapper.setAttribute('data-dst-ui', '1');
      while (el.firstChild && el.firstChild !== block) wrapper.appendChild(el.firstChild);
      el.insertBefore(wrapper, block);
    }
    return wrapper;
  }

  function unwrapOriginal(el) {
    const wrapper = el.querySelector(':scope > .dst-src-orig');
    if (!wrapper) return;
    while (wrapper.firstChild) el.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }

  function applyTranslation(el, text) {
    const record = state.records.get(el);
    if (!record) return;

    if (record.block && record.block.isConnected) {
      record.block.textContent = text;
    } else {
      const node = insertTranslationBlock(el, text);
      if (!node) return;
      record.block = node;
    }

    if (state.mode === 'replace') {
      hideOriginal(el, record.block);
    } else {
      unwrapOriginal(el);
      el.classList.remove('dst-src-hidden');
    }
  }

  function updateProgress() {
    syncFab();
    const { done, total } = state.progress;
    if (!total) return;
    if (done < total) {
      showToast(`正在翻译 ${done}/${total} 段…`, { spinner: true });
    } else {
      const cached = state.cachedCount;
      const tip = cached > 0 ? `（${cached} 段来自本地缓存，没花钱）` : '';
      showToast(`翻译完成 · ${total} 段${tip}`, { spinner: false, autoHide: cached > 0 ? 3200 : 2200 });
    }
  }

  function notifyBadge(on) {
    sendMessage({ type: 'setBadge', on }).catch(() => {});
  }

  /** 悬浮按钮的状态：待机 / 翻译中 / 已翻译 */
  function syncFab() {
    if (!ui) return;
    const show = !(state.settings && state.settings.showFab === false);
    ui.fabWrap.classList.toggle('hidden', !show);
    ui.fab.classList.toggle('on', state.active && !state.translating);
    ui.fab.classList.toggle('busy', state.translating);

    const { done, total } = state.progress;
    const label = state.translating
      ? total
        ? `翻译中 ${done}/${total}`
        : '翻译中…'
      : state.active
        ? '恢复原文'
        : '翻译此页';
    ui.fabLabel.textContent = label;
    ui.fab.title = label;
    ui.fab.setAttribute('aria-label', label);
  }

  /* ------------------------------------------------------ 文献总结 / 笔记 */

  const NOTE_SECTIONS = [
    { key: 'takeaway', title: '一句话概括', kind: 'text' },
    { key: 'problem', title: '研究问题', kind: 'text' },
    { key: 'approach', title: '研究思路', kind: 'text' },
    { key: 'methods', title: '研究方法', kind: 'list' },
    { key: 'content', title: '主要内容', kind: 'list' },
    { key: 'conclusions', title: '主要结论', kind: 'list' },
    { key: 'numbers', title: '关键数据', kind: 'list' },
    { key: 'limits', title: '局限与延伸', kind: 'list' },
  ];

  const NOTE_MAX_CHARS = 38000;
  const NOTE_SKIP_SELECTOR =
    'nav, header, footer, aside, form, iframe, script, style, noscript, [role="navigation"], [aria-hidden="true"], .references, #references, .ref-list, .related, .advertisement, .ads, .cookie, .toolbar, [data-dst-ui]';

  const note = {
    open: false,
    loading: false,
    summary: null,
    meta: null,
    body: '',
    selected: new Set(),
    dirHandle: null,
    extra: '',
    images: [],
    restored: false,
  };

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function metaContent(names) {
    for (const name of names) {
      const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
      const value = el && el.getAttribute('content');
      if (value && value.trim()) return value.trim();
    }
    return '';
  }

  function readPageMeta() {
    const authors = Array.from(document.querySelectorAll('meta[name="citation_author"]'))
      .map((el) => el.getAttribute('content') || '')
      .filter(Boolean);
    const date =
      metaContent(['citation_publication_date', 'citation_date', 'citation_year', 'article:published_time']) || '';
    const yearMatch = date.match(/(19|20)\d{2}/);
    return {
      title: metaContent(['citation_title', 'og:title', 'twitter:title']) || document.title || '',
      venue:
        metaContent([
          'citation_journal_title',
          'citation_conference_title',
          'citation_inbook_title',
          'og:site_name',
        ]) || '',
      year: yearMatch ? yearMatch[0] : '',
      authors: authors.slice(0, 12).join('; '),
      doi: metaContent(['citation_doi', 'dc.identifier']),
      url: location.href.split('#')[0],
    };
  }

  /** 猜正文容器：按 article/main 等候选里文字最多者 */
  function pickArticleRoot() {
    const selectors = [
      'article',
      'main',
      '[role="main"]',
      '.article-body',
      '.article__body',
      '.document',
      '#article',
      '.fulltext',
      '.paper',
      '.main-content',
      '#content',
    ];
    let best = null;
    let bestLen = 0;
    for (const selector of selectors) {
      let list = [];
      try {
        list = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const el of list) {
        const len = (el.innerText || '').length;
        if (len > bestLen) {
          best = el;
          bestLen = len;
        }
      }
    }
    return bestLen > 1500 ? best : document.body;
  }

  /** 把页面正文按段落抽成带小标题的纯文本，喂给模型 */
  function collectArticleText() {
    const root = pickArticleRoot();
    const seen = new Set();
    const parts = [];
    let total = 0;
    const nodes = root.querySelectorAll('h1, h2, h3, h4, h5, p, li, blockquote, figcaption, dd, td');
    for (const el of nodes) {
      if (el.closest(NOTE_SKIP_SELECTOR)) continue;
      if (el.querySelector('p, li, h1, h2, h3, h4, h5, blockquote, figcaption, dd')) continue;
      const text = normalize(el.innerText || '');
      if (text.length < 20) continue;
      const key = text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      const isHeading = /^h[1-5]$/i.test(el.tagName);
      parts.push(isHeading ? `## ${text}` : text);
      total += text.length;
      if (total >= NOTE_MAX_CHARS) break;
    }
    return parts.join('\n\n').slice(0, NOTE_MAX_CHARS);
  }

  function closeNotePanel() {
    note.open = false;
    if (ui) ui.panel.classList.remove('show');
    clearTimeout(draftTimer);
  }

  /* ---------------- 我的笔记里的图片 / 截图 ---------------- */

  const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  const IMAGE_MAX_EDGE = 1600; // 长边缩到这个尺寸：截图里的字照样清楚，md 又不会撑到几十 MB

  /** 缩放 + 重新编码，减小体积（md 里是内嵌 base64，原图直接塞会非常大） */
  function shrinkImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          const w = img.naturalWidth || 1;
          const h = img.naturalHeight || 1;
          const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(w, h));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          }
          let dataUrl = '';
          try {
            dataUrl = canvas.toDataURL('image/webp', 0.9);
          } catch {
            dataUrl = '';
          }
          if (!/^data:image\/webp/i.test(dataUrl)) dataUrl = canvas.toDataURL('image/jpeg', 0.9);
          const type = /^data:([^;]+)/i.exec(dataUrl);
          resolve({ dataUrl, type: type ? type[1] : 'image/png' });
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片解码失败'));
      };
      img.src = url;
    });
  }

  async function addImageBlob(blob) {
    if (!blob) return;
    if (!/^image\//i.test(blob.type || '')) {
      flashToast('只能放图片', true);
      return;
    }
    if (blob.size > IMAGE_MAX_BYTES) {
      flashToast('图片太大（超过 8MB），压缩一下再放', true);
      return;
    }
    try {
      const { dataUrl, type } = await shrinkImage(blob);
      note.images.push({ dataUrl, type, size: dataUrl.length, addedAt: Date.now() });
      renderThumbs();
      scheduleDraftSave();
      flashToast('图片已加入，保存时会直接嵌进 md 文件');
    } catch (error) {
      flashToast(`图片读取失败：${(error && error.message) || error}`, true);
    }
  }

  function removeImage(index) {
    note.images.splice(index, 1);
    renderThumbs();
    scheduleDraftSave();
  }

  function renderThumbs() {
    if (!ui) return;
    const box = ui.panelBody.querySelector('.np-thumbs');
    if (!box) return;
    box.innerHTML = (note.images || [])
      .map(
        (image, index) =>
          `<div class="np-thumb"><img src="${image.dataUrl}" alt="配图 ${index + 1}" /><button type="button" data-act="rmimg" data-i="${index}" title="删除这张">×</button></div>`,
      )
      .join('');
  }

  /* ---------------- 草稿：关掉面板也不丢 ---------------- */

  const DRAFT_PREFIX = 'noteDraft|';
  const DRAFT_INDEX = 'noteDraftIndex';
  let draftTimer = null;

  function urlHash(text) {
    let h = 2166136261;
    const s = String(text || '');
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function draftKey() {
    return DRAFT_PREFIX + urlHash(location.href.split('#')[0]);
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      writeDraft().catch(() => {});
    }, 900);
  }

  async function writeDraft() {
    if (!note.summary) return;
    const key = draftKey();
    const payload = {
      url: location.href.split('#')[0],
      title: noteTitle(),
      summary: note.summary,
      selected: Array.from(note.selected),
      extra: note.extra || '',
      images: note.images || [],
      updated: Date.now(),
    };
    try {
      await chrome.storage.local.set({ [key]: payload });
      const stored = await chrome.storage.local.get({ [DRAFT_INDEX]: [] });
      const index = Array.isArray(stored[DRAFT_INDEX]) ? stored[DRAFT_INDEX] : [];
      const next = index.filter((item) => item && item.key !== key);
      next.push({ key, updated: payload.updated });
      next.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      const keep = next.slice(0, 30);
      const drop = next.slice(30).map((item) => item.key);
      await chrome.storage.local.set({ [DRAFT_INDEX]: keep });
      if (drop.length) await chrome.storage.local.remove(drop);
    } catch {
      /* 存不下就只保留内存里的 */
    }
  }

  async function readDraft() {
    try {
      const key = draftKey();
      const stored = await chrome.storage.local.get(key);
      return stored && stored[key] ? stored[key] : null;
    } catch {
      return null;
    }
  }

  async function clearDraft() {
    try {
      await chrome.storage.local.remove(draftKey());
    } catch {
      /* ignore */
    }
  }

  function sectionValue(section) {
    const value = note.summary ? note.summary[section.key] : '';
    if (Array.isArray(value)) {
      return value.map((item) => normalize(typeof item === 'string' ? item : String(item))).filter(Boolean);
    }
    const text = normalize(value || '');
    return section.kind === 'list' ? (text ? [text] : []) : text;
  }

  /** 每节正文都是可直接编辑的富文本框；列表项按「- 」一行一条 */
  function renderEditableSection(section) {
    const value = sectionValue(section);
    const text = section.kind === 'list' ? value.map((item) => `- ${item}`).join('\n') : value;
    const placeholder = section.kind === 'list' ? '（未提取到，可以自己一行一条补上）' : '（未提取到，可以直接写）';
    return `<div class="nsec-edit" contenteditable="true" spellcheck="false" data-edit="${section.key}" data-ph="${escapeHtml(
      placeholder,
    )}">${escapeHtml(text)}</div>`;
  }

  /** 编辑框里的文本 → 存回 summary（列表按行拆） */
  function applyEdit(key, value) {
    const section = NOTE_SECTIONS.find((item) => item.key === key);
    const raw = String(value == null ? '' : value).replace(/\u00a0/g, ' ');
    const lines = raw
      .split(/\n+/)
      .map((line) => line.replace(/^\s*[-*·•]\s*/, '').trim())
      .filter(Boolean);
    if (!note.summary) note.summary = {};
    if (section && section.kind === 'list') note.summary[key] = lines;
    else note.summary[key] = lines.join(' ').trim();
    const tag = ui && ui.panelBody ? ui.panelBody.querySelector(`.nsec-tag[data-tag="${key}"]`) : null;
    if (tag) {
      tag.textContent = '已改';
      tag.classList.add('hot');
    }
  }

  function noteTitle() {
    const s = note.summary || {};
    const meta = note.meta || {};
    return s.title_zh || s.title || meta.title || document.title || '文献笔记';
  }

  function renderNotePanel() {
    const view = ensureUI();
    const s = note.summary || {};
    const meta = note.meta || {};
    view.panelSub.textContent = noteTitle();

    const head = [];
    head.push(`<div><b>标题：</b>${escapeHtml(noteTitle())}</div>`);
    const titleEn = s.title_en || (meta.title && meta.title !== noteTitle() ? meta.title : '');
    if (titleEn) head.push(`<div><b>原文标题：</b>${escapeHtml(titleEn)}</div>`);
    const doi = String(meta.doi || s.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
    head.push(
      doi
        ? `<div><b>DOI：</b><a href="https://doi.org/${encodeURIComponent(doi)}" target="_blank" rel="noreferrer">${escapeHtml(doi)}</a></div>`
        : '<div><b>DOI：</b><span class="np-none">页面里没找到，记得自己补上</span></div>',
    );
    const venueLine = [s.journal_abbr, s.venue || meta.venue, s.year || meta.year].filter(Boolean).join(' · ');
    if (venueLine) head.push(`<div><b>来源：</b>${escapeHtml(venueLine)}</div>`);
    if (meta.authors) head.push(`<div><b>作者：</b>${escapeHtml(meta.authors)}</div>`);
    const keywords = Array.isArray(s.keywords) ? s.keywords.filter(Boolean).slice(0, 6) : [];
    if (keywords.length) head.push(`<div><b>关键词：</b>${escapeHtml(keywords.join('、'))}</div>`);

    // 我的笔记放最上面：自己写的东西永远最先看到
    const notesWrap = `
      <div class="np-notes-wrap">
        <div class="np-notes-head">
          <span class="np-notes-label">我的笔记</span>
          <span class="np-notes-tip">写你自己的结论 / 想法，导出时放在最前面</span>
        </div>
        <textarea class="np-notes" placeholder="例如：这篇的 GFM 控制思路可以借到我的变流器建模里……"></textarea>
        <div class="np-shots">
          <button class="np-btn tiny" type="button" data-act="shot">＋ 图片 / 截图</button>
          <span class="np-shots-tip">Win+Shift+S 截图后直接 Ctrl+V 粘进来</span>
        </div>
        <div class="np-thumbs"></div>
      </div>`;

    const blocks = NOTE_SECTIONS.map((section) => {
      const checked = note.selected.has(section.key);
      return `
        <div class="nsec${checked ? '' : ' off'}" data-sec="${section.key}">
          <label class="nsec-head">
            <input type="checkbox" data-sec="${section.key}" ${checked ? 'checked' : ''} />
            <span class="nsec-title">${section.title}</span>
            <span class="nsec-tag" data-tag="${section.key}">AI</span>
          </label>
          <div class="nsec-body">${renderEditableSection(section)}</div>
        </div>`;
    }).join('');

    view.panelBody.innerHTML = `${notesWrap}<div class="np-meta">${head.join('')}</div>${blocks}`;
    const textarea = view.panelBody.querySelector('.np-notes');
    if (textarea) {
      textarea.value = note.extra || '';
      textarea.addEventListener('input', () => {
        note.extra = textarea.value;
        scheduleDraftSave();
      });
    }
    renderThumbs();
    view.panelHint.textContent = note.restored
      ? '已恢复你上次编辑的内容；改完点「保存」写入文件'
      : '笔记和小节内容都能直接改，改完点「保存」';
  }

  async function openNotePanel({ force = false } = {}) {
    const view = ensureUI();
    view.panel.classList.add('show');
    note.open = true;
    refreshDestLabel().catch(() => {});
    closeQuickPanel();

    if (!force && note.summary) {
      renderNotePanel();
      return;
    }
    if (note.loading) return;

    // 有上次的编辑就恢复，不重新花 API 的钱
    if (!force && !note.summary) {
      const draft = await readDraft();
      if (draft && draft.summary && Object.keys(draft.summary).length) {
        note.summary = draft.summary;
        note.meta = note.meta || readPageMeta();
        note.extra = draft.extra || '';
        note.images = Array.isArray(draft.images) ? draft.images : [];
        note.selected = new Set(
          Array.isArray(draft.selected) && draft.selected.length
            ? draft.selected
            : NOTE_SECTIONS.map((section) => section.key),
        );
        note.restored = true;
        renderNotePanel();
        flashToast('已恢复上次的笔记');
        return;
      }
    }

    if (force) {
      clearDraft().catch(() => {});
      note.images = [];
      note.extra = '';
      note.restored = false;
    }

    note.loading = true;
    note.summary = null;
    note.selected = new Set();
    view.fabNote.classList.add('busy');
    view.fabNoteLabel.textContent = '整理中';
    view.panelSub.textContent = '准备中…';
    view.panelHint.textContent = '';
    view.panelBody.innerHTML =
      '<div class="np-loading"><span class="np-spin"></span><span class="np-load-text">正在读取页面正文…</span></div>';

    const setLoadText = (text) => {
      const el = view.panelBody.querySelector('.np-load-text');
      if (el) el.textContent = text;
    };

    try {
      const meta = readPageMeta();
      const body = collectArticleText();
      note.meta = meta;
      note.body = body;
      if (body.length < 400) {
        throw new Error('这一页没抓到足够的正文，可能不是文章页，或者内容还没加载完');
      }

      view.panelSub.textContent = meta.title || document.title;
      setLoadText(
        `DeepSeek 正在读这篇（约 ${(body.length / 1000).toFixed(1)}k 字），需要十几秒…`,
      );

      const response = await sendMessage({ type: 'summarize', meta, body });
      if (!response) throw new Error('扩展没有响应，请刷新页面后重试');
      if (!response.ok) throw new Error(response.error || '总结失败');

      note.summary = response.summary || {};
      note.selected = new Set(NOTE_SECTIONS.map((section) => section.key));
      note.restored = false;
      renderNotePanel();
      writeDraft().catch(() => {});
      flashToast('文献总结完成');
    } catch (error) {
      view.panelSub.textContent = '出错了';
      view.panelBody.innerHTML = `<div class="np-empty">${escapeHtml(
        String(error && error.message ? error.message : error),
      )}</div>`;
      view.panelHint.textContent = '';
    } finally {
      note.loading = false;
      view.fabNote.classList.remove('busy');
      view.fabNoteLabel.textContent = '整理文献';
    }
  }

  function safeName(text, max = 40) {
    return String(text == null ? '' : text)
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
      .replace(/[.\s]+$/, '');
  }

  function todayParts() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    };
  }

  /** 文件夹名：年月日-期刊缩写-关键词 */
  function buildFolderName() {
    const s = note.summary || {};
    const meta = note.meta || {};
    const { date } = todayParts();
    const abbr = safeName(s.journal_abbr || meta.venue || '期刊', 16) || '期刊';
    const keywords = (Array.isArray(s.keywords) ? s.keywords : [])
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => safeName(word, 10))
      .filter(Boolean);
    const topic = keywords.length
      ? keywords.join('·')
      : safeName(s.title_zh || s.title || meta.title || '文献', 16);
    return safeName(`${date}-${abbr}-${topic}`, 70) || `${date}-文献`;
  }

  function buildNoteFileName() {
    const { date } = todayParts();
    return `${date} ${safeName(noteTitle(), 46) || '文献笔记'}.md`;
  }

  function buildNoteMarkdown() {
    const s = note.summary || {};
    const meta = note.meta || {};
    const title = noteTitle();
    const titleEn = String(s.title_en || meta.title || '').trim();
    const doi = String(meta.doi || s.doi || '')
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .trim();
    const { date, time } = todayParts();
    const tags = ['文献笔记', s.journal_abbr || meta.venue || ''].filter(Boolean);

    const lines = ['---'];
    lines.push(`title: "${String(title).replace(/"/g, "'")}"`);
    if (titleEn && titleEn !== title) lines.push(`title_en: "${titleEn.replace(/"/g, "'")}"`);
    if (s.journal_abbr || meta.venue) lines.push(`venue: "${s.journal_abbr || meta.venue}"`);
    if (s.year || meta.year) lines.push(`year: "${s.year || meta.year}"`);
    if (meta.authors) lines.push(`authors: "${meta.authors.replace(/"/g, "'")}"`);
    if (doi) lines.push(`doi: "${doi}"`);
    if (meta.url) lines.push(`url: "${meta.url}"`);
    lines.push(`created: "${date} ${time}"`);
    lines.push(`tags: [${tags.map((tag) => `"${String(tag).replace(/"/g, "'")}"`).join(', ')}]`);
    lines.push('---', '');
    lines.push(`# ${title}`, '');

    const info = [];
    if (titleEn && titleEn !== title) info.push(`- **原文标题**：${titleEn}`);
    info.push(
      doi ? `- **DOI**：[${doi}](https://doi.org/${doi})` : '- **DOI**：（未识别，待补）',
    );
    const venueInfo = [s.venue || meta.venue, s.year || meta.year].filter(Boolean).join('，');
    if (venueInfo) info.push(`- **期刊 / 年份**：${venueInfo}`);
    else if (s.journal_abbr) info.push(`- **期刊**：${s.journal_abbr}`);
    if (meta.authors) info.push(`- **作者**：${meta.authors}`);
    if (meta.url) info.push(`- **原文链接**：${meta.url}`);
    if (info.length) lines.push('## 基本信息', '', ...info, '');

    // 自己的笔记放在最前面（AI 总结在它后面）
    const extra = String(
      note.extra || (ui && ui.panelBody ? (ui.panelBody.querySelector('.np-notes') || {}).value : '') || '',
    );
    if (extra.trim()) {
      lines.push('## 我的笔记', '', extra.trim(), '');
    }
    if (Array.isArray(note.images) && note.images.length) {
      lines.push('### 截图', '');
      note.images.forEach((image, index) => {
        // 直接内嵌 data URI：md 单文件就能看到图，不会出现「图片在外面临时目录、换台机器就没了」
        lines.push(`![图 ${index + 1}](${image.dataUrl})`, '');
      });
    }

    if (note.selected.has('takeaway') && s.takeaway) {
      lines.push(`> ${normalize(s.takeaway)}`, '');
    }

    for (const section of NOTE_SECTIONS) {
      if (section.key === 'takeaway') continue;
      if (!note.selected.has(section.key)) continue;
      const value = s[section.key];
      const items = Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
      if (!items.length) continue;
      lines.push(`## ${section.title}`, '');
      if (section.kind === 'list') {
        for (const item of items) lines.push(`- ${normalize(item)}`);
      } else {
        lines.push(normalize(items.join(' ')));
      }
      lines.push('');
    }

    lines.push('---', '');
    lines.push(`*${date} 由 DeepSeek 网页翻译扩展整理${meta.url ? ` · 原文：${meta.url}` : ''}*`);
    return lines.join('\n');
  }

  /* -------- 保存位置：目录句柄缓存（句柄存在本页 origin 的 IndexedDB 里） -------- */

  const DIR_DB_NAME = 'dst-notes-dir';
  const DIR_STORE = 'kv';
  const DIR_KEY = 'dir';

  function dirDb() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DIR_DB_NAME, 1);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DIR_STORE)) db.createObjectStore(DIR_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开本地数据库'));
    });
  }

  async function dirGet() {
    try {
      const db = await dirDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(DIR_STORE, 'readonly');
        const req = tx.objectStore(DIR_STORE).get(DIR_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function dirSet(handle) {
    const db = await dirDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DIR_STORE, 'readwrite');
      tx.objectStore(DIR_STORE).put(handle, DIR_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('保存文件夹失败'));
    });
  }

  function dirPermission(handle) {
    try {
      if (handle && typeof handle.queryPermission === 'function') {
        return handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
      }
    } catch {
      /* 老浏览器没有 queryPermission，当作已授权 */
    }
    return Promise.resolve('granted');
  }

  async function ensureDirAccess(handle) {
    const options = { mode: 'readwrite' };
    let state = await dirPermission(handle);
    if (state === 'granted') return true;
    try {
      state = await handle.requestPermission(options);
    } catch {
      state = 'denied';
    }
    return state === 'granted';
  }

  /** 刷新「保存到 xxx」这一行的显示 */
  async function refreshDestLabel() {
    const view = ensureUI();
    let handle = note.dirHandle;
    if (!handle) {
      handle = await dirGet();
      note.dirHandle = handle || null;
    }
    if (handle) {
      view.destName.textContent = handle.name;
      view.destName.classList.remove('empty');
      view.pickBtn.textContent = '更改';
    } else {
      view.destName.textContent = '还没有选择文件夹';
      view.destName.classList.add('empty');
      view.pickBtn.textContent = '选择文件夹';
    }
    try {
      chrome.storage.local.set({ notesDirName: handle ? handle.name : '' }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /** 面板里的「选择文件夹 / 更改」：有句柄时只补权限，没句柄时才弹选择框 */
  async function chooseNoteFolder() {
    const view = ensureUI();
    if (typeof window.showDirectoryPicker !== 'function') {
      flashToast('这个浏览器不支持选文件夹，保存时会退回到下载目录', true);
      return;
    }
    view.pickBtn.classList.remove('pulse');

    const existing = note.dirHandle || (await dirGet());
    if (existing) {
      const state = await dirPermission(existing);
      if (state !== 'granted') {
        // 只恢复授权，不重新挑目录（requestPermission 用的是这次点击的手势）
        const ok = await ensureDirAccess(existing);
        if (ok) {
          note.dirHandle = existing;
          await refreshDestLabel();
          view.panelHint.textContent = `已恢复「${existing.name}」的写入权限`;
        } else {
          view.panelHint.textContent = '权限被拒绝，再点一次并选择「允许」';
        }
        return;
      }
    }

    try {
      const handle = await window.showDirectoryPicker({ id: 'dst-notes-dir', mode: 'readwrite' });
      await dirSet(handle).catch(() => {});
      note.dirHandle = handle;
      await refreshDestLabel();
      view.panelHint.textContent = `以后都保存到「${handle.name}」`;
      flashToast(`已选择：${handle.name}`);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      flashToast(`选择文件夹失败：${error && error.message ? error.message : error}`, true);
    }
  }

  async function writeNoteFile(dir, folder, filename, markdown) {
    const target = await dir.getDirectoryHandle(folder, { create: true });
    const file = await target.getFileHandle(filename, { create: true });
    const writable = await file.createWritable();
    await writable.write(markdown);
    await writable.close();
    return `${dir.name}/${folder}/${filename}`;
  }

  async function saveNoteMarkdown() {
    if (!note.summary) {
      flashToast('还没有总结结果', true);
      return;
    }
    const view = ensureUI();
    const folder = buildFolderName();
    const filename = buildNoteFileName();
    const markdown = buildNoteMarkdown();

    // 老浏览器没有目录选择 API：退回下载
    if (typeof window.showDirectoryPicker !== 'function') {
      view.panelHint.textContent = '正在下载…';
      try {
        if (markdown.length > 1_600_000) {
          flashToast('这份笔记带了大图，太大了，请点「选择文件夹」保存', true);
          return;
        }
        const response = await sendMessage({ type: 'saveNote', payload: { folder, filename, markdown } });
        if (!response) throw new Error('扩展没有响应，请刷新页面后重试');
        if (!response.ok) throw new Error(response.error || '保存失败');
        view.panelHint.textContent = '已存到下载目录';
      } catch (error) {
        view.panelHint.textContent = '';
        flashToast(String(error && error.message ? error.message : error), true);
      }
      return;
    }

    const dir = note.dirHandle || (await dirGet());
    if (!dir) {
      view.panelHint.textContent = '先点下面「选择文件夹」，只需要选一次';
      view.pickBtn.classList.add('pulse');
      return;
    }

    const granted = await ensureDirAccess(dir);
    if (!granted) {
      view.panelHint.textContent = '写入权限掉了，点下面「更改」授权一次';
      view.pickBtn.classList.add('pulse');
      return;
    }

    view.panelHint.textContent = '正在写入…';
    try {
      const path = await writeNoteFile(dir, folder, filename, markdown);
      note.dirHandle = dir;
      view.pickBtn.classList.remove('pulse');
      view.panelHint.textContent = `已保存：${path}`;
      flashToast('笔记已保存');
      writeDraft().catch(() => {});
    } catch (error) {
      view.panelHint.textContent = '';
      flashToast(`写入失败：${error && error.message ? error.message : error}`, true);
    }
  }

  async function runTranslation({ silent = false, forceBilingual = false } = {}) {
    if (state.translating) return;

    const settings = await loadSettings();
    state.settings = settings;

    if (!settings.apiKey) {
      showToast('还没有填写 API Key：打开扩展设置填一个 DeepSeek Key 就能用了', {
        spinner: false,
        error: true,
        autoHide: 6000,
      });
      sendMessage({ type: 'openOptions' }).catch(() => {});
      return;
    }
    state.targetLang = settings.targetLang || 'zh-CN';
    // 悬浮按钮点一下固定走「中英对照」
    state.mode = forceBilingual
      ? 'bilingual'
      : settings.mode === 'replace'
        ? 'replace'
        : 'bilingual';
    state.active = true;
    state.translating = true;
    state.token += 1;
    const token = state.token;
    state.doneKeys = new Set();
    state.progress = { done: 0, total: 0 };
    state.cachedCount = 0;

    notifyBadge(true);
    syncFab();

    try {
      const blocks = collectBlocks(document.body);
      const groups = new Map();

      for (const { el, text } of blocks) {
        const key = normalize(text);
        if (!key) continue;
        if (!state.records.has(el)) {
          state.records.set(el, { block: null, originalText: text });
        }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }

      const keys = Array.from(groups.keys());
      if (!keys.length) {
        state.translating = false;
        state.active = false;
        notifyBadge(false);
        syncFab();
        if (!silent) {
          showToast('这一页没有找到需要翻译的内容', { spinner: false, autoHide: 2400 });
        }
        return;
      }

      state.progress = { done: 0, total: keys.length };
      updateProgress();

      const batches = buildBatches(keys, settings);
      const concurrency = Math.max(1, Math.min(6, Number(settings.concurrency) || 3));
      let cursor = 0;
      let firstError = null;

      const worker = async () => {
        while (true) {
          if (token !== state.token) return;
          const index = cursor++;
          if (index >= batches.length) return;
          const batch = batches[index];
          try {
            const { translations, cachedCount } = await translateSegments(batch, { targetLang: state.targetLang });
            state.cachedCount += cachedCount;
            if (token !== state.token) return;
            translations.forEach((text, offset) => {
              const key = batch[offset];
              if (!key || typeof text !== 'string') return;
              const targets = groups.get(key);
              if (!targets) return;
              const clean = text.trim();
              if (!clean) return;
              for (const el of targets) applyTranslation(el, clean);
              state.doneKeys.add(key);
            });
          } catch (error) {
            if (!firstError) firstError = error;
          } finally {
            state.progress.done = Math.min(state.progress.total, state.progress.done + batch.length);
            if (token === state.token) updateProgress();
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()),
      );

      if (token !== state.token) return;

      if (firstError && state.doneKeys.size === 0) {
        showToast(`翻译失败：${firstError.message}`, {
          spinner: false,
          error: true,
          autoHide: 6000,
        });
        state.active = false;
        notifyBadge(false);
      } else if (firstError) {
        showToast(`部分内容未翻译：${firstError.message}`, {
          spinner: false,
          error: true,
          autoHide: 5000,
        });
      }
    } catch (error) {
      showToast(`翻译失败：${(error && error.message) || error}`, {
        spinner: false,
        error: true,
        autoHide: 6000,
      });
      state.active = false;
      notifyBadge(false);
    } finally {
      state.translating = false;
      if (state.active) startObserver();
      syncFab();
    }
  }

  function restore() {
    state.token += 1;
    state.active = false;
    state.translating = false;
    state.progress = { done: 0, total: 0 };
    stopObserver();

    for (const [el, record] of state.records) {
      if (record.block) {
        try {
          record.block.remove();
        } catch {
          /* ignore */
        }
        record.block = null;
      }
      unwrapOriginal(el);
      el.classList.remove('dst-src-hidden');
    }
    state.records.clear();
    state.doneKeys.clear();

    // 兜底清理：页面上残留的译文块（比如 SPA 换页后 records 已失效）
    document.querySelectorAll('.dst-block[data-dst-ui]').forEach((node) => node.remove());
    document.querySelectorAll('.dst-src-orig').forEach((wrapper) => {
      const parent = wrapper.parentElement;
      if (!parent) return;
      while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
      wrapper.remove();
    });
    document.querySelectorAll('.dst-src-hidden').forEach((node) => node.classList.remove('dst-src-hidden'));

    hideToast();
    notifyBadge(false);
    syncFab();
  }

  /* ---------------------------------------------------- 动态页面监听 */

  function startObserver() {
    if (state.observer || !state.active) return;
    state.observer = new MutationObserver((mutations) => {
      if (!state.active) return;
      let dirty = false;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 3) {
            dirty = true;
            break;
          }
          if (node.nodeType === 1 && !node.hasAttribute('data-dst-ui')) {
            dirty = true;
            break;
          }
        }
        if (dirty) break;
      }
      if (dirty) scheduleRescan();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.rescanTimer);
  }

  function scheduleRescan() {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = setTimeout(() => {
      if (!state.active) return;
      // 正在翻译时把它推到这一轮结束之后再扫
      if (state.translating) {
        scheduleRescan();
        return;
      }
      rescan();
    }, 700);
  }

  async function rescan() {
    if (!state.active || state.translating) return;
    state.translating = true;
    const token = state.token;
    try {
      const blocks = collectBlocks(document.body);
      const groups = new Map();
      for (const { el, text } of blocks) {
        const key = normalize(text);
        if (!key) continue;
        if (!state.records.has(el)) state.records.set(el, { block: null, originalText: text });
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }
      const keys = Array.from(groups.keys());
      if (!keys.length) return;
      const batches = buildBatches(keys, state.settings || {});
      for (const batch of batches) {
        if (token !== state.token) return;
        try {
          const { translations } = await translateSegments(batch, { targetLang: state.targetLang });
          translations.forEach((text, offset) => {
            const key = batch[offset];
            if (!key || typeof text !== 'string' || !text.trim()) return;
            const targets = groups.get(key);
            if (!targets) return;
            for (const el of targets) applyTranslation(el, text.trim());
          });
        } catch {
          /* 懒加载内容的翻译失败不打扰用户 */
        }
      }
    } finally {
      state.translating = false;
    }
  }

  /* ------------------------------------------------------------ 消息 */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message && message.type;

    if (type === 'ping') {
      sendResponse({ ok: true, active: state.active });
      return false;
    }

    if (type === 'getState') {
      sendResponse({
        ok: true,
        active: state.active,
        translating: state.translating,
        mode: state.mode,
        targetLang: state.targetLang,
        progress: state.progress,
        count: state.doneKeys.size,
      });
      return false;
    }

    if (type === 'translatePage' || type === 'togglePage') {
      if (type === 'togglePage' && state.active) {
        restore();
        sendResponse({ ok: true, active: false });
        return false;
      }
      if (type === 'translatePage' && state.active) {
        sendResponse({ ok: true, active: true, already: true });
        return false;
      }
      runTranslation().catch(() => {});
      sendResponse({ ok: true, active: true, started: true });
      return false;
    }

    if (type === 'restore') {
      restore();
      sendResponse({ ok: true, active: false });
      return false;
    }

    if (type === 'summarizePage') {
      openNotePanel().catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    if (type === 'noteResult') {
      const view = ensureUI();
      if (message.ok) {
        view.panelHint.textContent = message.path ? `已保存：${message.path}` : '已保存';
        flashToast('笔记已保存');
      } else {
        view.panelHint.textContent = '';
        flashToast(message.error || '笔记保存失败', true);
      }
      sendResponse({ ok: true });
      return false;
    }

    if (type === 'setMode' || type === 'setLang') {
      const wasActive = state.active;
      if (wasActive) restore();
      if (message.mode === 'bilingual' || message.mode === 'replace') state.mode = message.mode;
      if (message.lang) state.targetLang = message.lang;
      if (wasActive) {
        runTranslation().catch(() => {});
        sendResponse({ ok: true, retranslating: true });
      } else {
        sendResponse({ ok: true, retranslating: false });
      }
      return false;
    }

    if (type === 'translateSelection') {
      const selected = readSelection();
      if (selected) {
        translateSelectionText(selected.text, selected.rect).catch(() => {});
        sendResponse({ ok: true });
      } else {
        const text = String((message && message.text) || '').trim();
        if (text) {
          translateSelectionText(text, null).catch(() => {});
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: '没有选中任何文字' });
        }
      }
      return false;
    }

    return false;
  });

  /* ---------------------------------------------------------- 初始化 */

  loadSettings()
    .then(async (settings) => {
      state.settings = settings;
      state.mode = settings.mode === 'replace' ? 'replace' : 'bilingual';
      state.targetLang = settings.targetLang || 'zh-CN';

      // 悬浮按钮：恢复上次拖动到的位置
      try {
        const stored = await chrome.storage.local.get({ fabTopRatio: 0.42 });
        const ratio = Number(stored && stored.fabTopRatio);
        if (Number.isFinite(ratio) && ratio > 0.02 && ratio < 0.98) {
          ensureUI().fabWrap.style.top = `${ratio * 100}%`;
        }
      } catch {
        /* ignore */
      }
      syncFab();
      refreshDestLabel().catch(() => {});
    })
    .catch(() => {});

  // 设置里改了「显示悬浮按钮」之类，立刻生效
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes.showFab && !changes.targetLang && !changes.mode) return;
      loadSettings()
        .then((settings) => {
          state.settings = settings;
          syncFab();
        })
        .catch(() => {});
    });
  } catch {
    /* ignore */
  }
})();
