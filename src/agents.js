'use strict';

// 终端里跑哪个 AI CLI —— codex 那一侧的适配。
//
// 【为什么有这个文件】派活的整条链里，真正认得「claude」三个字的只有两处：
// 启动参数怎么拼、去哪儿找可执行文件。窗口管理（开/关/心跳/任务栏/置顶）
// 全在我们自己的壳（hooks/term-shell.js）里，跟里面跑什么无关。
// 把 codex 的差异收在这一个文件里，别的 CLI 以后照样往这儿加。
//
// 【谁在用】term-shell.js（拼参数）和 main.js（找 bin、判装没装）。
// term-shell 是另起的 node 进程 require 进来的，所以这儿**只许用 node 自带模块**，
// 绝不能碰 electron 或项目里会连电的东西（journal、paths 那些）。
//
// 【claude 侧不在这儿】resolveClaudeBin / claudeInstalled 留在 sessions.js
// （chat/greet/sessions 一直从那儿拿），claude 的参数留在 term-shell 里
// （test-termlife 钉着它的引号处理，不挪窝）。

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 在 PATH 里找一个命令，返回**带扩展名的全路径**（找不到给 null）。
 * 必须要全路径：npm 装的是 .cmd，spawn 不带扩展名、又没开 shell 就是 ENOENT。 */
function onPath(name) {
  const exts = ['.exe', '.cmd', '.bat', ''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch (_) { /* 这个目录读不了，翻下一个 */ }
    }
  }
  return null;
}

function resolveCodexBin() {
  const envBin = process.env.WAIFU_CODEX_BIN;
  try {
    if (envBin && fs.existsSync(envBin)) return envBin;
  } catch (_) { /* 探测失败当没设 */ }
  return onPath('codex') || 'codex'; // 兜底交给 PATH（多半起不来，guard 会先拦）
}

function codexInstalled() {
  return resolveCodexBin() !== 'codex';
}

/**
 * 权限映射：claude 的模式名 → codex 的两个旋钮。
 *
 * codex 把「问不问」（-a）和「管多严」（-s）拆成两个开关：
 *   -a untrusted | on-request | never        问的频率
 *   -s read-only | workspace-write | danger-full-access   沙箱边界
 *
 * 映射原则：宁紧勿松。`--dangerously-bypass-approvals-and-sandbox` 和
 * danger-full-access **永远不映射** —— claude 那边最松的 dontAsk 也只是
 * 「别问了」，沙箱还在项目目录里圈着。
 */
const PERM = {
  auto:        ['-a', 'on-request', '-s', 'workspace-write'],
  acceptEdits: ['-a', 'on-request', '-s', 'workspace-write'],
  plan:        ['-a', 'untrusted', '-s', 'read-only'],
  dontAsk:     ['-a', 'never', '-s', 'workspace-write'],
  manual:      ['-a', 'untrusted', '-s', 'workspace-write'],
};

/**
 * 拼 codex 的启动参数。跟 claude 那份（term-shell 里的 claudeArgs）的差别：
 *
 *   · **没有 --session-id / --resume** —— codex 的会话 id 自己生成，不收外派的。
 *     所以 spec.sessionId 只当我们内部的线号用，不上命令行；「接着聊」在
 *     codex 线上等于开条新的（第二期从 ~/.codex/sessions 捞回 uuid 才有得接）。
 *   · **没有 -n 标题** —— 窗口标题靠 term-shell 的心跳一直按着，不受影响。
 *   · **小抄没有参数可传**（claude 走 --append-system-prompt-file）——
 *     改成把小抄内容拼进开场 prompt。只在真有活派的时候拼：没任务时递个
 *     prompt 过去等于替用户开跑一轮，那是花钱的事。
 */
function codexArgs(spec, useResume) {
  const args = [];
  // 接得上就接。resume 是**子命令**，必须排最前；后面的 -a/-s/-m 它照吃
  // （codex resume --help 实测有这几个旗子）。会话 id 是从 ~/.codex/sessions
  // 认领回来的（codex 不收外派 id，只能事后认，见 findCodexSession）。
  // 接不上的情况（没认领过 / 文件没了）上游已经把 useResume 算成 false。
  if (useResume && spec.codexSessionId) args.push('resume', spec.codexSessionId);
  args.push(...(PERM[spec.permissionMode] || PERM.auto));
  // 模型：面板上 codex 线不选模型（跟 ~/.codex/config.toml 走），
  // 但管道留着 —— 哪天要选了只用改面板
  if (spec.model) args.push('-m', spec.model);

  let task = spec.task && spec.task.trim() ? spec.task : '';
  // 小抄只在**新开局**拼：接着聊的会话里上下文本来就在，再塞一遍是白花钱
  if (task && spec.notesFile && !(useResume && spec.codexSessionId)) {
    try {
      const memo = fs.readFileSync(spec.notesFile, 'utf8').replace(/^\uFEFF/, '').trim();
      if (memo) task = '【项目备忘，动手前先看一眼】\n' + memo + '\n\n【这次的活】\n' + task;
    } catch (_) { /* 小抄读不到就不带，跟全新项目一个样 */ }
  }
  if (task) args.push(task);
  return args;
}

// ═══ 以下给主进程用 ═══════════════════════════════════════════════════════
// term-shell 用不到这半边，但 require 无害 —— 照旧只有 node 自带模块。

function codexSessionsRoot() {
  // CODEX_HOME 是 codex 自己认的环境变量（它的 help 里写着），跟着它走
  const home = process.env.CODEX_HOME;
  return path.join(home && home.trim() ? home : path.join(os.homedir(), '.codex'), 'sessions');
}

/** 只读文件开头一小块。session_meta 的第一行动辄二三十 KB（整份系统提示词
 * 都嵌在里面），按「读到换行为止」来会读一大坨 —— 而我们要的 session_id 和
 * cwd 都在最前面，抠这一块就够了。 */
function readHead(file, n) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.slice(0, got).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* 关不上拉倒 */ } }
  }
}

/**
 * 找「我们刚开的那个 codex」落的盘。
 *
 * codex 不收外派的会话 id，只能反过来：它开局就在
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl 落一份，
 * 第一行 session_meta 里带 cwd。配对三道闸：
 *   · 文件创建时间 >= 我们启动那一刻（留 5 秒钟表误差）—— 用户以前开的翻不出来
 *   · cwd 就是我们的项目目录（大小写不敏感）
 *   · session_id 没被别的线认领（同目录并行开两条也不会抢一个）
 * 多个候选取最早的。expectId 给「接着聊」的窗口用：**只认自己那条会话**
 * （resume 另起新文件时 id 不变），别的一概不碰 —— 不然它会把同目录新开线
 * 刚落盘的会话抢走（评审抓的：新线还没认领、id 不在 claimed 里，闸挡不住）。
 * 剩下的真空窗：用户在同一目录、启动后 90 秒内自己也开了一个 codex ——
 * 谁先落盘认谁，认错了钱和「接着聊」会串线。够罕见，认了。
 */
function findCodexSession({ dir, sinceMs, claimed, expectId, root }) {
  const base = root || codexSessionsRoot();
  const want = path.resolve(dir).toLowerCase();
  const skip = claimed || new Set();
  const p2 = (n) => String(n).padStart(2, '0');
  const out = [];
  // 会话按「开始那天」的**本地日期**归档。跨零点两个方向都得翻：
  //   · 往回（d=1）：零点后启动、文件还挂在昨天的目录里 —— 罕见但有
  //   · 往前（d=-1）：**23:59 派活、codex 零点后才落盘** —— 文件进「明天」的
  //     目录，而 sinceMs 冻结在启动那刻，不翻明天就永远认领不到（评审抓的）
  for (let d = -1; d < 2; d++) {
    const day = new Date(sinceMs - d * 86400000);
    const dayDir = path.join(base, String(day.getFullYear()), p2(day.getMonth() + 1), p2(day.getDate()));
    let names = [];
    try { names = fs.readdirSync(dayDir); } catch (_) { continue; }
    for (const f of names) {
      if (!/^rollout-.*.jsonl$/i.test(f)) continue;
      const full = path.join(dayDir, f);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      const born = st.birthtimeMs || st.mtimeMs;
      if (born < sinceMs - 5000) continue;
      const head = readHead(full, 8192);
      if (!head.includes('"type":"session_meta"')) continue;
      const id = (/"session_id":"([0-9a-fA-F-]{36})"/.exec(head) || [])[1];
      const cm = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
      if (!id || !cm || skip.has(id)) continue;
      if (expectId && id !== expectId) continue;
      let cwd = '';
      try { cwd = JSON.parse('"' + cm[1] + '"'); } catch (_) { continue; }
      if (path.resolve(cwd).toLowerCase() !== want) continue;
      out.push({ sessionId: id, file: full, born });
    }
  }
  out.sort((a, b) => a.born - b.born);
  return out[0] ? { sessionId: out[0].sessionId, file: out[0].file } : null;
}

/**
 * OpenAI 单价表（美元 / 百万 token），查于 2026-08-18。
 * 缓存命中按一折；**缓存写不要钱** —— 跟 Anthropic 的 1.25×/2× 写费是
 * 两套规矩，别照搬 cost.js。认不出来的模型按旗舰（$5/$30）算 ——
 * 跟 cost.js 一个立场：宁可报高。但名字带 mini/nano 的小模型别按旗舰冤枉，
 * 给一档宽松上限（本尊更便宜，报高不报低）。
 */
const CODEX_PRICE = [
  // 前缀匹配，长的排前面
  ['gpt-5.6-luna', { in: 0.20, out: 1.20 }],
  ['gpt-5.6-terra', { in: 2, out: 12 }],
  ['gpt-5.6', { in: 5, out: 30 }],          // sol 就是旗舰价
  ['gpt-5.5-pro', { in: 30, out: 180 }],
  ['gpt-5.5', { in: 5, out: 30 }],
  ['gpt-5.4', { in: 2.5, out: 15 }],
  ['gpt-5.1', { in: 1.25, out: 10 }],
  ['gpt-5-codex', { in: 1.25, out: 10 }],
  ['gpt-5', { in: 1.25, out: 10 }],
];
const CODEX_SMALL = { in: 0.5, out: 4 };
const CODEX_DEFAULT = { in: 5, out: 30 };

function codexPriceFor(model) {
  const m = String(model || '').toLowerCase();
  const small = /(mini|nano)/.test(m);
  for (const [prefix, p] of CODEX_PRICE) {
    if (!m.startsWith(prefix)) continue;
    // gpt-5.4-mini 这类：主号行接住了，但它是小模型，别按主号价冤枉
    return small && !/(mini|nano)/.test(prefix) ? CODEX_SMALL : p;
  }
  return small ? CODEX_SMALL : CODEX_DEFAULT;
}

/**
 * 这份 rollout 到现在花了多少（美元）。
 *
 * token_count 事件里带的是**累计**用量（total_token_usage），所以只要
 * 文件里最后一条完整的就是全部 —— 不用增量偏移，也天然不怕重复计
 * （cost.js 那套字节偏移在这儿是多余的，别搬）。半行（正写到一半被我们
 * 读到）JSON.parse 会抛，跳过接着往上找上一条完整的。
 * 模型名取最后一条 turn_context 的 —— 中途 /model 换过会有偏差，
 * 但窗口短、且兜底方向是报高。
 *
 * base 是窗口起点的 token 基线（接着聊续写同一份文件时用）：算的是
 * **差值的钱，按当前模型定价**。基线记 token 不记美元 —— 记美元的话，
 * 窗口之间换过模型，两头价目不一致，差值能被压成 0（那是报低，不许）。
 *
 * **读不出来返回 null**，跟「真没花钱（usd:0）」分开 —— 杀毒/备份工具
 * 短暂锁文件是真事，读失败那一下不能把已经算出来的数抹成 0。
 */
function codexUsage(file, base) {
  let text = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 8 * 1024 * 1024) {
      // 超大文件只读尾巴。掐掉开头那半行 —— 从文件中间切进去，第一段多半不完整
      const fd = fs.openSync(file, 'r');
      const n = 8 * 1024 * 1024;
      const buf = Buffer.alloc(n);
      const got = fs.readSync(fd, buf, 0, n, st.size - n);
      fs.closeSync(fd);
      text = buf.slice(0, got).toString('utf8');
      text = text.slice(text.indexOf('\n') + 1);
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
  } catch (_) {
    return null; // 读不出来 ≠ 没花钱
  }
  const lines = text.split('\n');
  let totals = null;
  let model = '';
  for (let i = lines.length - 1; i >= 0 && (!totals || !model); i--) {
    const ln = lines[i];
    if (!totals && ln.includes('"token_count"')) {
      try {
        totals = (JSON.parse(ln).payload.info || {}).total_token_usage || null;
      } catch (_) { /* 半行，往上再找 */ }
    }
    if (!model && ln.includes('"turn_context"')) {
      const m = /"model":"([^"]+)"/.exec(ln);
      if (m) model = m[1];
    }
  }
  if (!totals) return { usd: 0, model, totals: null }; // 文件在、还没写到 token_count
  const p = codexPriceFor(model);
  const b = base || {};
  // 每一项各自减基线、各自不许负（文件被截短过就当从零起）
  const dIn = Math.max(0, (totals.input_tokens || 0) - (b.input_tokens || 0));
  let dCached = Math.max(0, Math.min(totals.cached_input_tokens || 0, totals.input_tokens || 0)
                            - (b.cached_input_tokens || 0));
  if (dCached > dIn) dCached = dIn;
  const dOut = Math.max(0, (totals.output_tokens || 0) - (b.output_tokens || 0));
  const usd = ((dIn - dCached) * p.in + dCached * p.in * 0.1 + dOut * p.out) / 1e6;
  return { usd, model, totals };
}

/** apply_patch 的补丁文本里抠出动过的文件（*** Add/Update/Delete File: 路径） */
function collectPatchFiles(patch, files) {
  const re = /\*\*\* (?:Add|Update|Delete) File: (.+)/g;
  let m;
  while ((m = re.exec(patch))) {
    const p = m[1].trim();
    if (p) files[p] = (files[p] || 0) + 1;
  }
}

/**
 * 从 fromOffset 往后读一段档案：这段时间里她干了什么。
 *
 * claude 的监督靠 hook 推事件；codex 没有 hook，但它的会话档案是**实时**写的，
 * 每一轮都有现成的记号：
 *   · task_complete —— 一轮干完，**last_agent_message 就是她这轮最后说的话**
 *     （出错的轮可能是 null）
 *   · function_call / custom_tool_call —— 动了一次工具；apply_patch 的补丁
 *     文本里写着动了哪些文件（function_call 形态的 arguments 是**还没解码的
 *     内层 JSON**，得先 parse 再取 input —— 直接跑正则会把整段补丁吞成一个
 *     「文件名」，评审抓过）
 *   · error —— 报错（登录失效、断网之类）
 *   · 用户这轮说了什么 —— 老版本是 event_msg/user_message，新版本（0.147）
 *     改成了 response_item/message 里 role=user，两种都认
 *
 * 【为什么是增量而不是整读】整读出来的是累计值，跟基线相减的口径在文件
 * 超过 8MB 被截尾时会塌掉（计数不再单调，汇报从此永久停摆 —— 评审抓的）。
 * 增量读没有这个问题：每次只看新长出来的字节，量出来的天然就是「这一段」。
 * 【半行保护】只吃到最后一个换行为止，正写到一半的那行留给下一拍
 * （nextOffset 停在它前面）。偏移永远落在行首，所以多字节字符切不坏。
 *
 * 返回 { nextOffset, turns, toolCount, errors, lastSaid, lastPrompt, files }；
 * **读不出来返回 null**（跟「这段里什么都没有」分开）。
 */
function codexGlance(file, fromOffset) {
  const start = Math.max(0, Number(fromOffset) || 0);
  const empty = (off) => ({ nextOffset: off, turns: 0, toolCount: 0, errors: 0, lastSaid: '', lastPrompt: '', files: {} });
  let buf = null;
  let got = 0;
  try {
    const st = fs.statSync(file);
    // 档案变短了（被换掉/清掉再建）：跳到末尾重新跟 —— 宁可漏一段也别把
    // 旧内容当新动静重放一遍
    if (st.size < start) return empty(st.size);
    if (st.size === start) return empty(start);
    const fd = fs.openSync(file, 'r');
    try {
      const n = st.size - start;
      buf = Buffer.alloc(n);
      got = fs.readSync(fd, buf, 0, n, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return null; // 读不出来 ≠ 没动静（杀毒/备份短暂锁文件是真事）
  }

  // 按**字节**找最后一个换行：偏移必须落在行首，字符串长度做不了这个数
  let lastNl = -1;
  for (let i = got - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) { lastNl = i; break; }
  }
  if (lastNl < 0) return empty(start); // 一行都没写完，下一拍再来

  const out = empty(start + lastNl + 1);
  const text = buf.slice(0, lastNl + 1).toString('utf8');

  for (const ln of text.split('\n')) {
    // 先字符串粗筛再 parse —— 工具输出的行动辄几十 KB。粗筛的串带右引号
    // （"type":"function_call" 撞不上 …_output），嵌在工具输出里的同款文字
    // 是转义过的（\"type\"）也撞不上；parse 完再核对 payload.type，双保险
    if (!ln.includes('"type":"task_complete"') &&
        !ln.includes('"type":"function_call"') &&
        !ln.includes('"type":"custom_tool_call"') &&
        !ln.includes('"type":"error"') &&
        !ln.includes('"type":"user_message"') &&
        !ln.includes('"role":"user"')) continue;
    let j;
    try { j = JSON.parse(ln); } catch (_) { continue; }
    if (j.type !== 'event_msg' && j.type !== 'response_item') continue;
    const p = j.payload || {};
    if (p.type === 'task_complete') {
      out.turns++;
      if (p.last_agent_message) out.lastSaid = String(p.last_agent_message);
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      out.toolCount++;
      if (p.name === 'apply_patch') {
        if (typeof p.input === 'string') collectPatchFiles(p.input, out.files);
        else if (typeof p.arguments === 'string') {
          // function_call 形态：arguments 是序列化的 {"input":"…补丁…"}，
          // 先解码再抠 —— 解不开就算了，别在带转义的原文上跑正则
          try {
            const a = JSON.parse(p.arguments);
            if (a && typeof a.input === 'string') collectPatchFiles(a.input, out.files);
          } catch (_) { /* 不是合法 JSON 就当没看见 */ }
        }
      }
    } else if (p.type === 'error') {
      out.errors++;
    } else if (p.type === 'user_message' && p.message) {
      out.lastPrompt = pickPrompt(p.message) || out.lastPrompt;
    } else if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      // 新版（0.147 起）用户输入长这样。开局那条是 <environment_context>，
      // IDE 驱动的带一坨「# Context from my IDE」—— 都不是人话，跳过
      const t = p.content
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => c.text).join(' ');
      out.lastPrompt = pickPrompt(t) || out.lastPrompt;
    }
  }
  return out;
}

/** 用户输入里挑出「人说的那句」：环境注入和 IDE 前缀那坨不算 */
function pickPrompt(t) {
  const s = String(t || '').trim();
  if (!s || s.startsWith('<') || s.startsWith('# Context from my IDE')) return '';
  return s;
}

module.exports = {
  onPath, resolveCodexBin, codexInstalled, codexArgs, PERM,
  codexSessionsRoot, findCodexSession, codexUsage, codexPriceFor, codexGlance, pickPrompt,
};
