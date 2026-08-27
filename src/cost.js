'use strict';

// 她在终端里花了多少钱。
//
// 面板上「今天」那一栏以前只算得到三笔（私聊、主动搭话、后台派活），
// 因为那三笔是我们自己调的 claude，token 用量当场就有。而**开出去的终端**
// 是独立的 claude 进程，hook 事件里一个成本字段都没有 —— 于是最大的一笔开销
// 变成了黑洞，面板只能写一句「另有 N 轮算不到钱」。
//
// 补法：**去读 Claude Code 自己的会话记录**。它把每一轮的 usage 完整写在
// `~/.claude/projects/<项目>/<会话id>.jsonl` 里：
//
//   {"type":"assistant","message":{"model":"claude-opus-5","usage":{
//      "input_tokens":2,"cache_creation_input_tokens":20177,
//      "cache_read_input_tokens":27265,"output_tokens":485,
//      "cache_creation":{"ephemeral_1h_input_tokens":20177,...}}}}
//
// 两个前提让这件事变得可靠：
//
//   1. **会话 id 是我们自己发的**（开终端时 `--session-id <我们定的>`）。
//      所以我们只认自己那几个文件，绝不会把你自己开的窗口算进她头上。
//   2. 那个文件是**边跑边写**的，不是等会话结束才落盘 —— 所以钱能实时涨。
//      （terminals.js 里那条「transcript 要等会话结束才有」的老注释说的是
//      Stop 事件那一刻文件还没建好，不是文件不实时。）
//
// 报的是**按官方 API 单价折算**的数字。你要是包月订阅，这笔钱不会真从卡里扣，
// 但它仍然是「这段活值多少」最诚实的刻度。

const fs = require('fs');
const os = require('os');
const path = require('path');

// 每百万 token 多少美元。缓存写是输入价的 1.25 倍（5 分钟）或 2 倍（1 小时），
// 缓存读是输入价的 0.1 倍 —— 这三个倍率对所有模型都一样，所以只列输入/输出。
const PRICE = {
  'claude-fable-5': [10, 50],
  'claude-mythos-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-opus-4-5': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

// 认不出来的模型按 Opus 算。宁可报高也别报低 —— 一个偏低的数字会让你
// 放心地多派几个活，而偏高只是让你多看一眼
const FALLBACK_PRICE = [5, 25];

function priceOf(model) {
  const id = String(model || '');
  if (PRICE[id]) return PRICE[id];
  // 带日期后缀的（claude-haiku-4-5-20251001）按前缀找
  for (const key of Object.keys(PRICE)) {
    if (id.startsWith(key)) return PRICE[key];
  }
  return FALLBACK_PRICE;
}

/**
 * 一轮回复的钱，四桶拆开（输入/输出/缓存读/缓存写），美元和 token 各一份。
 * 「省钱主战场」的仪表全从这儿来 —— usdOf 只是把四桶加起来，算法一个字没变。
 */
function partsOf(usage, model) {
  const [inPrice, outPrice] = priceOf(model);
  const M = 1e6;

  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

  // 缓存写分 5 分钟和 1 小时两档，倍率不一样（1.25 / 2）。
  // 细分字段有就用细分的，没有就整笔按 1.25 算
  const cc = usage.cache_creation || {};
  const w5 = n(cc.ephemeral_5m_input_tokens);
  const w1h = n(cc.ephemeral_1h_input_tokens);
  const ccTotal = n(usage.cache_creation_input_tokens);
  const wTok = (w5 || w1h) ? w5 + w1h : ccTotal;
  const writeCost = (w5 || w1h)
    ? (w5 * inPrice * 1.25 + w1h * inPrice * 2) / M
    : (ccTotal * inPrice * 1.25) / M;

  return {
    usd: {
      input: (n(usage.input_tokens) * inPrice) / M,
      output: (n(usage.output_tokens) * outPrice) / M,
      cacheRead: (n(usage.cache_read_input_tokens) * inPrice * 0.1) / M,
      cacheWrite: writeCost,
    },
    tok: {
      input: n(usage.input_tokens),
      output: n(usage.output_tokens),
      cacheRead: n(usage.cache_read_input_tokens),
      cacheWrite: wTok,
    },
  };
}

/** 一轮回复值多少钱 */
function usdOf(usage, model) {
  if (!usage) return 0;
  const p = partsOf(usage, model).usd;
  return p.input + p.output + p.cacheRead + p.cacheWrite;
}

const HOME = process.env.CLAUDE_HOME || os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');

/**
 * 会话 id 对应的记录文件在哪。
 *
 * Claude Code 把项目路径编码成目录名（`D:\WaifuCode` → `D--WaifuCode`），
 * 但**故意不去推那个编码规则** —— 它变一次我们就静默算不出钱了。
 * 会话 id 是 uuid，全盘唯一，扫一遍目录去找反而稳。
 * 找到就记住，下次直接用。
 */
const fileOf = new Map();

function findTranscript(sessionId) {
  if (!sessionId) return null;
  const hit = fileOf.get(sessionId);
  if (hit && fs.existsSync(hit)) return hit;

  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS);
  } catch (_) {
    return null; // 没装 Claude Code，或者还没跑过
  }
  for (const d of dirs) {
    const f = path.join(PROJECTS, d, sessionId + '.jsonl');
    if (fs.existsSync(f)) {
      fileOf.set(sessionId, f);
      return f;
    }
  }
  return null;
}

/**
 * 一个文件到现在为止一共花了多少，以及**比上次多花了多少**。
 *
 * jsonl 只会往后追加，所以每次只读新长出来的那一段（记住上回读到哪个字节）。
 * 不这么做的话，面板每 3 秒刷一次就要把几个 MB 重新解析一遍。
 *
 * 尾巴上那半行要留到下次：读到的最后一行很可能被截断在半路，
 * 现在解析它就是丢一轮的钱。
 */
const state = new Map(); // file -> { at, total, tail, parts, tok, byModel }

const zero4 = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function scanFile(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    return { total: 0, delta: 0 };
  }

  let st = state.get(file);
  // 文件变短了 = 被换掉了（清过、或者 id 撞了），从头重来
  if (!st || size < st.at) st = { at: 0, total: 0, tail: '', parts: zero4(), tok: zero4(), byModel: {} };
  if (!st.parts) { st.parts = zero4(); st.tok = zero4(); st.byModel = {}; } // 老条目升级

  if (size === st.at) return { total: st.total, delta: 0, parts: st.parts, tokens: st.tok, byModel: st.byModel };

  let chunk = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(size - st.at);
      fs.readSync(fd, buf, 0, buf.length, st.at);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return { total: st.total, delta: 0, parts: st.parts, tokens: st.tok, byModel: st.byModel };
  }

  const lines = (st.tail + chunk).split('\n');
  const tail = lines.pop(); // 最后一段没有换行 = 还没写完，留到下次

  let delta = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const m = j.message;
      if (j.type === 'assistant' && m && m.usage) {
        // 四桶拆开攒 + 按模型分桶 ——「这钱是谁烧的、烧在哪」的答案就在
        // 同一遍扫描里，不另开文件不多读一个字节
        const p = partsOf(m.usage, m.model);
        const usd = p.usd.input + p.usd.output + p.usd.cacheRead + p.usd.cacheWrite;
        delta += usd;
        for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
          st.parts[k] += p.usd[k];
          st.tok[k] += p.tok[k];
        }
        const mod = String(m.model || '?');
        st.byModel[mod] = (st.byModel[mod] || 0) + usd;
      }
    } catch (_) { /* 半行、或者不是我们认识的格式，跳过 */ }
  }

  state.set(file, { at: size, total: st.total + delta, tail, parts: st.parts, tok: st.tok, byModel: st.byModel });
  return { total: st.total + delta, delta, parts: st.parts, tokens: st.tok, byModel: st.byModel };
}

/**
 * 这条线到现在花了多少钱。
 * @returns {{total:number, delta:number}} total = 累计，delta = 比上次问的时候多的
 */
function ofSession(sessionId) {
  const f = findTranscript(sessionId);
  if (!f) return { total: 0, delta: 0 };
  return scanFile(f);
}

/**
 * 这条会话最后一句「你说的话」—— 给没起名的线当自动线名（「上次聊到：修支付
 * 回调」比一串时间戳认得快）。只读文件尾巴 256KB（长回复会把最后那句人话顶得很远），找不到就空着，绝不编。
 */
function lastUserPrompt(sessionId) {
  const f = findTranscript(sessionId);
  if (!f) return '';
  try {
    const size = fs.statSync(f).size;
    const fd = fs.openSync(f, 'r');
    let chunk = '';
    try {
      const buf = Buffer.allocUnsafe(Math.min(262144, size));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = chunk.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"user"')) continue;
      try {
        const j = JSON.parse(lines[i]);
        if (j.type !== 'user' || !j.message) continue;
        const c = j.message.content;
        let text = typeof c === 'string' ? c
          : Array.isArray(c) ? String((c.find((b) => b && b.type === 'text') || {}).text || '') : '';
        text = text.replace(/\s+/g, ' ').trim();
        // IDE 上下文、斜杠命令、工具结果这些不是「你说的话」
        if (!text || text.startsWith('<') || text.startsWith('/') || text.startsWith('[')) continue;
        return text.slice(0, 40);
      } catch (_) { /* 半行跳过 */ }
    }
  } catch (_) { /* 读不了就空着 */ }
  return '';
}

/**
 * 缓存命中率（%）。分母是**整个 prompt 侧**：input + cacheRead + cacheWrite ——
 * 漏掉 cacheWrite 的话仪表是死的：Anthropic 的 input_tokens 只是「既没读也没写
 * 缓存」的零头（真实会话每轮个位数），cacheRead/(input+cacheRead) 永远 ~100%。
 * 改小抄/换目录造成的失效全记在 cacheWrite 里，它必须在分母上，指针才会动。
 */
/**
 * 这条会话的**完整对话**，按「轮」切开（手机上点「查看全部」看的就是它）。
 *
 * 【为什么必须从会话档案读】内存里的 timeline 是给一眼扫的：每条截到 300 字、
 * 只留最近 60 条、还不落盘。用户要看的「细节」压根不在那儿 —— 在 Claude Code
 * 自己写的 jsonl 里。那份是完整的：她说的每一段、调了哪些工具，一个字不少。
 *
 * 【只读尾巴】一场长会话几十兆，全读进来手机端也翻不动。默认读最后 512KB，
 * 掐掉开头那半行（半行 JSON.parse 必炸，跟算钱那边一个规矩）。
 *
 * 【一轮 = 你说一句 + 她干到下次你开口】按 user 消息切。工具结果、IDE 上下文、
 * 斜杠命令这些不是「你说的话」，不切轮（判据跟 lastUserPrompt 一致）。
 *
 * @returns {{ok:boolean, turns:Array, why?:string}} turns 从新到旧
 */
function turnsOf(sessionId, { tailBytes = 512 * 1024, maxTurns = 30, textMax = 4000 } = {}) {
  const f = findTranscript(sessionId);
  if (!f) return { ok: false, why: '找不到这条线的会话记录（可能还没开始说话，或者记录被清过）', turns: [] };
  let chunk = '';
  let size = 0;
  try {
    size = fs.statSync(f).size;
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(tailBytes, size));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (err) {
    return { ok: false, why: '会话记录读不了：' + err.message, turns: [] };
  }

  const lines = chunk.split('\n');
  if (size > tailBytes) lines.shift(); // 掐掉可能被切断的头一行
  const turns = [];
  let cur = null;
  const push = () => { if (cur && (cur.prompt || cur.out.length || cur.tools.length)) turns.push(cur); };

  for (const line of lines) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; } // 半行跳过
    const m = j.message;
    if (!m) continue;
    const at = Date.parse(j.timestamp) || 0;

    if (j.type === 'user') {
      const c = m.content;
      let text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n')
        : '';
      text = text.trim();
      // 工具结果 / IDE 上下文 / 斜杠命令：不是你开的口，不切轮
      if (!text || text.startsWith('<') || text.startsWith('/') || text.startsWith('[')) continue;
      push();
      cur = { at, prompt: text.slice(0, textMax), out: [], tools: [] };
      continue;
    }

    if (j.type === 'assistant' && Array.isArray(m.content)) {
      if (!cur) cur = { at, prompt: '', out: [], tools: [] };
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === 'text' && String(b.text || '').trim()) {
          cur.out.push(String(b.text).slice(0, textMax));
        } else if (b.type === 'tool_use' && b.name) {
          // 工具只记名字和一个短提要 —— 参数里常有整份文件内容，手机上没人看，
          // 传过去还白占流量
          const inp = b.input || {};
          const hint = String(inp.file_path || inp.path || inp.command || inp.pattern || inp.description || '')
            .replace(/\s+/g, ' ').trim().slice(0, 80);
          cur.tools.push(hint ? b.name + ' · ' + hint : String(b.name));
        }
      }
      if (at && !cur.at) cur.at = at;
    }
  }
  push();

  return {
    ok: true,
    truncated: size > tailBytes, // 前面还有更早的，只是没读进来
    turns: turns.slice(-maxTurns).reverse(),
  };
}

function cacheHit(tok) {
  if (!tok) return null;
  const denom = (tok.input || 0) + (tok.cacheRead || 0) + (tok.cacheWrite || 0);
  if (denom <= 0) return null;
  return Math.round((100 * (tok.cacheRead || 0)) / denom);
}

module.exports = { ofSession, usdOf, partsOf, priceOf, PRICE, lastUserPrompt, cacheHit, turnsOf };
