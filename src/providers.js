'use strict';

// 「接入点」：一个地址 + 一把钥匙 + 它家的模型名单。
//
// 让 Claude Code / Codex 用别家的模型（DeepSeek、千问、智谱、Kimi、本机 Ollama…），
// 靠的是它们认的两对环境变量：
//   Claude Code  ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN   （Anthropic 兼容口）
//   Codex        OPENAI_BASE_URL    + OPENAI_API_KEY         （OpenAI 兼容口）
// 实测（2026-08-31，本机登着 claude.ai 账号）：带上这两个变量 claude 不弹登录、
// 直接打到那个地址；它只印一行「环境变量优先于你的 claude.ai 登录」。
//
// 【铁律：不碰用户自己的登录和模型】
//   · 「官方」这一档 = 什么都不加，env 原样透传。用户系统里本来有什么就是什么。
//   · 变量只塞给**桌宠自己起的那个进程**，用户自己开的终端一个字不受影响。
//   · 认不出的接入点（被删了、存档坏了）→ 当官方，绝不拿一把不对的钥匙去试。
//   · 切回官方 = 那两个变量不再出现。没有任何要「撤销」的状态。
//
// 【钥匙不落明文】走 electron 的 safeStorage（Windows 上是 DPAPI）：config.json 里
// 只有密文，只有这个 Windows 账号解得开。这个模块不 require electron ——
// 主进程把 cipher 注进来（useCipher），自检拿个假的替身也能跑。
// 钥匙**只在拼 env 那一刻解开**，不进日志、不进 spec 文件、不进手机端。

const OFFICIAL = 'official';

// 官方那档能选的模型（跟 main.js 的 DISPATCH_MODELS 一份；空串 = 跟 Claude Code 自己的设置走）
const OFFICIAL_MODELS = ['', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'];

// 美元换人民币：面板那边就是这个数，差 5% 不影响判断
const USD_CNY = 7.2;

let cipher = null; // { available(): bool, encrypt(str): base64, decrypt(base64): str }
function useCipher(c) { cipher = c; }

/** 存档里的列表（不含官方那条），坏了的条目直接扔 */
function stored(cfg) {
  const list = Array.isArray(cfg && cfg.providers) ? cfg.providers : [];
  return list.filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id && p.id !== OFFICIAL);
}

function find(cfg, id) {
  return stored(cfg).find((p) => p.id === id) || null;
}

/** 这条是给哪家 CLI 用的：anthropic 兼容口给 claude，openai 兼容口给 codex */
function kindOf(p) { return p && p.kind === 'openai' ? 'openai' : 'anthropic'; }
function agentFor(kind) { return kind === 'openai' ? 'codex' : 'claude'; }

/** 模型名单（每行一个，去空去重） */
function modelsOf(p) {
  const raw = Array.isArray(p.models) ? p.models : String(p.models || '').split(/[\n,]/);
  const out = [];
  for (const m of raw) {
    const s = String(m || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 给渲染层 / 手机端看的名单：**没有钥匙，连密文都没有**。
 * 官方永远排第一。keyTail 是钥匙末四位，让人认得出是哪把。
 */
function publicList(cfg) {
  const official = {
    id: OFFICIAL, name: '官方（用你登录的账号）', kind: 'anthropic', builtin: true,
    models: OFFICIAL_MODELS.filter(Boolean), priced: true, hasKey: true, keyTail: '',
  };
  return [official].concat(stored(cfg).map((p) => ({
    id: p.id,
    name: String(p.name || p.id).slice(0, 40),
    kind: kindOf(p),
    builtin: false,
    baseUrl: String(p.baseUrl || ''),
    models: modelsOf(p),
    priced: Number(p.priceIn) > 0 || Number(p.priceOut) > 0,
    priceIn: Number(p.priceIn) || 0,
    priceOut: Number(p.priceOut) || 0,
    hasKey: Boolean(p.keyEnc),
    keyTail: String(p.keyTail || ''),
  })));
}

/**
 * 校验「这一次用哪个接入点 + 哪个模型」。返回 { provider, model }，两个都是**白名单里**的值。
 *   · 接入点认不出 → 官方（不认识的东西一律当没选，跟 resolveDispatchAgent 同一个原则）
 *   · 官方的模型只认 OFFICIAL_MODELS；空串 = 不传 --model
 *   · 第三方的模型只认它自己名单里的；没给就用名单第一个（第三方端点认不得 claude-* 那种默认名）
 *   · 接入点的口跟 CLI 对不上（拿 openai 口给 claude 用）→ 官方
 */
function resolve(cfg, providerRaw, modelRaw, agent) {
  const pid = String(providerRaw == null ? '' : providerRaw).trim() || OFFICIAL;
  const m = String(modelRaw == null ? '' : modelRaw).trim();
  const want = agent === 'codex' ? 'openai' : 'anthropic';
  if (pid === OFFICIAL) {
    if (agent === 'codex') return { provider: OFFICIAL, model: undefined }; // codex 不认 claude 的模型名
    return { provider: OFFICIAL, model: OFFICIAL_MODELS.includes(m) ? (m || undefined) : undefined };
  }
  const p = find(cfg, pid);
  if (!p || kindOf(p) !== want) return { provider: OFFICIAL, model: undefined };
  const models = modelsOf(p);
  const model = models.includes(m) ? m : models[0];
  return { provider: pid, model: model || undefined };
}

/**
 * 这一次要塞给子进程的环境变量。**官方 = 空对象**，一个变量都不加。
 * 钥匙在这儿现解，解不开（换了 Windows 账号、safeStorage 没了）就当官方 —— 宁可跑在
 * 用户自己的账号上，也别拿一串乱码当钥匙去撞。
 */
function envFor(cfg, providerId, agent) {
  const r = resolve(cfg, providerId, '', agent);
  if (r.provider === OFFICIAL) return {};
  const p = find(cfg, r.provider);
  const key = decryptKey(p);
  // null = 有密文但解不开（换了 Windows 账号、safeStorage 没了）→ 官方。
  // '' = 这条本来就没钥匙（本机 Ollama）→ 给个占位：CLI 没有 token 会去要登录
  if (key === null) return {};
  const base = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return {};
  if (kindOf(p) === 'openai') return { OPENAI_BASE_URL: base, OPENAI_API_KEY: key || 'local' };
  return { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key || 'local' };
}

/** 钥匙末四位，存档里带着方便认；密文本身不进任何列表 */
function tailOf(key) { return String(key).slice(-4); }

/** 存一把钥匙：明文进来、密文出去。没有 cipher（safeStorage 不可用）就拒绝，绝不落明文 */
function encryptKey(plain) {
  const s = String(plain || '').trim();
  if (!s) return { keyEnc: '', keyTail: '' };
  if (!cipher || !cipher.available()) throw new Error('这台机器上钥匙加密不可用，不敢明文存');
  return { keyEnc: cipher.encrypt(s), keyTail: tailOf(s) };
}

/** 解一把钥匙。空 = 这条没钥匙（本机 Ollama）；null = 解不开 */
function decryptKey(p) {
  if (!p || !p.keyEnc) return '';
  if (!cipher || !cipher.available()) return null;
  try { return cipher.decrypt(p.keyEnc); } catch (_) { return null; }
}

/**
 * 保存（新增或改）一条。渲染层传来的是明文钥匙（只在这一趟内存里过一下）；
 * 不传钥匙 = 钥匙不动。返回整份新列表（密文形态，直接写进 config.providers）。
 */
function upsert(cfg, draft) {
  const d = draft || {};
  const list = stored(cfg);
  const id = String(d.id || '').trim() || ('p_' + Math.random().toString(36).slice(2, 8));
  if (id === OFFICIAL) throw new Error('这个名字留给官方那档');
  const cur = list.find((p) => p.id === id) || { id };
  const next = {
    ...cur,
    id,
    name: String(d.name || cur.name || '').trim().slice(0, 40) || '未命名',
    kind: d.kind === 'openai' ? 'openai' : 'anthropic',
    baseUrl: String(d.baseUrl || cur.baseUrl || '').trim().replace(/\/+$/, ''),
    models: modelsOf({ models: d.models != null ? d.models : cur.models }),
    priceIn: Math.max(0, Number(d.priceIn != null ? d.priceIn : cur.priceIn) || 0),
    priceOut: Math.max(0, Number(d.priceOut != null ? d.priceOut : cur.priceOut) || 0),
  };
  if (!/^https?:\/\//i.test(next.baseUrl)) throw new Error('地址得以 http:// 或 https:// 开头');
  if (!next.models.length) throw new Error('至少填一个模型名（每行一个）');
  if (typeof d.key === 'string' && d.key.trim()) Object.assign(next, encryptKey(d.key));
  if (d.key === '') { next.keyEnc = ''; next.keyTail = ''; } // 明确清空
  const idx = list.findIndex((p) => p.id === id);
  if (idx >= 0) list[idx] = next; else list.push(next);
  return list;
}

function remove(cfg, id) {
  return stored(cfg).filter((p) => p.id !== id);
}

/** 这条的单价（美元/百万 token，[输入, 输出]）；没填就 null → 面板显示「未计价」 */
function priceUsdOf(cfg, providerId) {
  if (!providerId || providerId === OFFICIAL) return null; // 官方走 cost.js 自己那张表
  const p = find(cfg, providerId);
  if (!p) return null;
  const i = Number(p.priceIn) || 0, o = Number(p.priceOut) || 0;
  if (!(i > 0) && !(o > 0)) return null;
  return [i / USD_CNY, o / USD_CNY];
}

/**
 * 按第三方单价算一笔钱。缓存读写**全按输入价**算 —— 各家缓存折扣不一样（DeepSeek 命中一折），
 * 宁可报高别报低（cost.js 同一条家规）。
 */
function priceUsage(usage, price) {
  if (!usage || !price) return 0;
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const inTok = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens)
              + n(usage.cached_input_tokens);
  const outTok = n(usage.output_tokens);
  return (inTok * price[0] + outTok * price[1]) / 1e6;
}

/** 她开口（私聊/搭话/周记）用哪个：'same' = 跟派活一样 */
function chatProviderId(cfg) {
  const c = (cfg && cfg.chat) || {};
  const pid = String(c.provider || 'same');
  if (pid === 'same') return String(((cfg && cfg.dispatch) || {}).provider || OFFICIAL);
  return pid;
}

/**
 * 陪聊那几张嘴要的一整包：{ id, env, price, model }。model 是那家名单第一个
 * （陪聊不选模型，第三方端点又认不得 claude 默认名）。官方 → 全空。
 */
function forChat(cfg, agent) {
  const pid = chatProviderId(cfg);
  const r = resolve(cfg, pid, '', agent);
  if (r.provider === OFFICIAL) return { id: OFFICIAL, env: {}, price: null, model: undefined };
  return { id: r.provider, env: envFor(cfg, r.provider, agent), price: priceUsdOf(cfg, r.provider), model: r.model };
}

/** 日志里遇到钥匙就抹掉 —— 报错文本可能把请求头原样带出来 */
function redact(text, cfg) {
  let s = String(text == null ? '' : text);
  for (const p of stored(cfg || {})) {
    const k = decryptKey(p);
    if (k && k.length >= 8) s = s.split(k).join('***');
  }
  return s;
}

module.exports = {
  OFFICIAL, OFFICIAL_MODELS, USD_CNY,
  useCipher, publicList, resolve, envFor, upsert, remove, find, kindOf, agentFor, modelsOf,
  priceUsdOf, priceUsage, chatProviderId, forChat, redact, encryptKey, decryptKey,
};
