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

/** 一轮回复值多少钱 */
function usdOf(usage, model) {
  if (!usage) return 0;
  const [inPrice, outPrice] = priceOf(model);
  const M = 1e6;

  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

  // 缓存写分 5 分钟和 1 小时两档，倍率不一样（1.25 / 2）。
  // 细分字段有就用细分的，没有就整笔按 1.25 算
  const cc = usage.cache_creation || {};
  const w5 = n(cc.ephemeral_5m_input_tokens);
  const w1h = n(cc.ephemeral_1h_input_tokens);
  const ccTotal = n(usage.cache_creation_input_tokens);
  const writeCost = (w5 || w1h)
    ? (w5 * inPrice * 1.25 + w1h * inPrice * 2) / M
    : (ccTotal * inPrice * 1.25) / M;

  return (
    (n(usage.input_tokens) * inPrice) / M +
    (n(usage.output_tokens) * outPrice) / M +
    (n(usage.cache_read_input_tokens) * inPrice * 0.1) / M +
    writeCost
  );
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
const state = new Map(); // file -> { at, total, tail }

function scanFile(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    return { total: 0, delta: 0 };
  }

  let st = state.get(file);
  // 文件变短了 = 被换掉了（清过、或者 id 撞了），从头重来
  if (!st || size < st.at) st = { at: 0, total: 0, tail: '' };

  if (size === st.at) return { total: st.total, delta: 0 };

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
    return { total: st.total, delta: 0 };
  }

  const lines = (st.tail + chunk).split('\n');
  const tail = lines.pop(); // 最后一段没有换行 = 还没写完，留到下次

  let delta = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const m = j.message;
      if (j.type === 'assistant' && m && m.usage) delta += usdOf(m.usage, m.model);
    } catch (_) { /* 半行、或者不是我们认识的格式，跳过 */ }
  }

  state.set(file, { at: size, total: st.total + delta, tail });
  return { total: st.total + delta, delta };
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

module.exports = { ofSession, usdOf, priceOf, PRICE };
