'use strict';

// 她自己的流水账。
//
// 「今天陪你干了什么」「这个月在她身上花了多少」「认识多少天了」——
// 这些以前全都答不上来：面板上那个列表只在内存里，桌宠一关就空；
// 花的钱只进了 waifu.log 的一行文本，没人统计。事情发生完就扔了。
//
// 三条规矩，都是有来由的：
//
// **一、只记段落级的事**（开了个终端、干完一轮、说了一句话），不记工具级。
// 工具事件一秒能来好几条，挂在那儿同步写盘才是真会卡住 UI —— 而且 hook 那头
// 800 毫秒就超时放弃（见 hooks/notify.js），拖慢的是你自己那个 Claude Code 窗口。
// 段落级每分钟不到一条，写一行两百来字节约 0.1 毫秒，main.js 的 log() 早就
// 在每条日志上这么干了。换来的是顺序天然正确、进程被杀也不丢一条。
//
// **二、净化在这一层做，不指望调用方。** 喂数据的地方手边全是诱人的完整路径
// （e.dir、e.key、她汇报时念出来的路径），一个 `{ ...e }` 就全泄进来了。
// 所以 add() 自己把每个字符串过一遍：project/files 只留最后一段名字，
// 别的摘掉密钥、把绝对路径压成「…」。六个调用点谁漏了都不要紧。
//
// **三、一天从早上 5 点算起。** 用这个桌宠的人是熬夜写代码的 ——
// 凌晨两点干的活算「昨天」才符合直觉。按零点切的话，「连着几天来找我」
// 会被熬夜天天弄断。

const fs = require('fs');
const path = require('path');

const { DATA_ROOT } = require('./paths');

// 跟 registry.json / mood.json 做邻居。**必须在 sessions 底下**：
// package.json 的 build.files 把 sessions 整个排除在安装包外，放到别处的话，
// 开发时它长在项目根目录，然后被原样打进安装包发给别人 ——
// 里面是你自己的项目名和干活记录。
const DIR = path.join(DATA_ROOT, 'sessions', 'journal');
const SINCE_FILE = path.join(DIR, 'since.json');

// 明细留三个月（一天几十条约 10KB，90 天不到 1MB）。
// 「从哪天开始认识的」单独记在 since.json 里，**永不过期** ——
// 不单独存的话，清理一删最早那天，认识天数就开始往回缩了。
const KEEP_DAYS = 90;

// 一天的分界线：早上 5 点
const DAY_EDGE_MS = 5 * 60 * 60 * 1000;

/** 这个时刻算哪一天，'YYYY-MM-DD'。字符串直接比大小，不用算天数差 */
function dayKey(ts = Date.now()) {
  const d = new Date(ts - DAY_EDGE_MS);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// ---------------------------------------------------------------------------
// 净化：写进去之前，先把不该留下的东西摘掉
// ---------------------------------------------------------------------------

// 她汇报的时候经常把密钥、路径原样念出来，而这份流水是长期留着的。
//
// 【关键词那条为什么写成这样】原来是 `\b(api[-_]?key|password|...)`，
// 而真实世界里这些词**几乎总是夹在变量名中间**：`AWS_SECRET_ACCESS_KEY=`、
// `private_token=`、`DB_PASSWORD=`。`\b` 在下划线前根本不成立（下划线是单词
// 字符），而且 `secret` 后面跟的是 `_ACCESS_KEY=` 不是 `=`，第二个分组也对不上。
// 结果就是最常见的那一类一条都拦不住 —— 而这份东西是长期留盘、还会被当成
// 系统提示重新发出去的。现在允许关键词前后各带若干个 `词段_`。
const SECRETS = [
  [/\bsk-[A-Za-z0-9_-]{12,}/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '***'],
  [/\bglpat-[A-Za-z0-9_-]{12,}/g, '***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\bAKIA[0-9A-Z]{12,}/g, '***'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]*/g, '***'], // JWT
  [/(?:^|[^A-Za-z0-9])((?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|password|passwd|secret|token|credential)(?:[-_][A-Za-z0-9]+)*)(\s*[=:]\s*|\s+是\s*)\S+/gi,
    (m, k, sep) => m.slice(0, m.indexOf(k)) + k + sep + '***'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/g, 'Bearer ***'],
];

/**
 * 路径，整段压掉。**不保留最后那段文件名** —— 文件名在 files 字段里单独存着
 * （那儿本来就是 basename），brief 里再留一份没有价值，只多一个泄漏口子。
 *
 * 四种形式都要认，少一种就是一条完整的用户目录留在磁盘上 90 天：
 *   · `D:\x\y`、`D:/x/y`      Windows 盘符
 *   · `\\server\share\x`      UNC
 *   · `/c/Users/18475/...`    **Git Bash 风格** —— claude 的 Bash 工具就是
 *                             Git Bash，她汇报时写这个是常态，原来完全漏网
 *   · `~/.ssh/id_rsa`、`/home/x`、`../../别的项目`
 */
const PATHS = new RegExp([
  '(?:[A-Za-z]:[\\\\/]',                  // D:\ 或 D:/
  '|\\\\\\\\[^\\s\\\\/]+[\\\\/]',         // \\server\share
  '|/[a-zA-Z]/(?=[A-Za-z0-9._-])',        // /c/Users/...（Git Bash）
  '|/(?:home|root|Users|mnt|opt|etc|var)/', // 常见 POSIX 前缀
  '|~[\\\\/]',                             // ~/ 或 ~\
  '|\\.\\.[\\\\/]',                        // ../ 或 ..\（隔壁项目名会跟着泄漏）
  ')',
  // 路径主体。**空格要能跨过去** —— `C:\Program Files\WaifuCode` 里那个空格
  // 一停，就只削掉了 `C:\Program`，`Files\WaifuCode` 原样留在磁盘上。
  // 判据是「空格后面不远处还有分隔符」，这样才不会把路径后面那句话一起吞掉。
  '(?:[^\\s，。；、,"\'`)\\]}]|[ ](?=[^\\s，。；、]{1,40}[\\\\/]))*',
].join(''), 'g');

function redact(s) {
  let out = String(s);
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out.replace(PATHS, '…');
}

// 这几个字段只留最后一段名字 —— 「D:\WaifuCode」进来，存下去的是「WaifuCode」
const BASENAME_KEYS = new Set(['project', 'file']);

function sanitize(v, key) {
  if (typeof v === 'string') {
    const s = BASENAME_KEYS.has(key)
      ? path.posix.basename(path.win32.basename(v))
      : v;
    return redact(s).slice(0, 400);
  }
  if (Array.isArray(v)) {
    // files: ['a.js', ...] 的元素按 file 处理
    const childKey = key === 'files' ? 'file' : key;
    return v.slice(0, 12).map((x) => sanitize(x, childKey));
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = sanitize(x, k);
    return out;
  }
  return v; // 数字、布尔、null 原样
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

function fileOf(day) {
  return path.join(DIR, (day || dayKey()) + '.jsonl');
}

let sinceCache = null;

/** 第一条流水落地的时刻。只写一次，之后永远读缓存 */
function since() {
  if (sinceCache) return sinceCache;
  try {
    sinceCache = JSON.parse(fs.readFileSync(SINCE_FILE, 'utf8').replace(/^\uFEFF/, '')).at;
  } catch (_) {
    /* 还没有，下面建 */
  }
  if (!sinceCache) {
    sinceCache = new Date().toISOString();
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(SINCE_FILE, JSON.stringify({ at: sinceCache }) + '\n', 'utf8');
    } catch (_) {
      sinceCache = null; // 写不进去就下次再试，别把一个假时间缓存住
    }
  }
  return sinceCache;
}

/**
 * 记一条。**永远不抛错** —— 流水丢一条不是事，拖垮桌宠才是。
 * 返回真正落盘的那条记录（自检拿它对净化结果），失败返回 null。
 */
function add(type, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    since();
    const rec = { at: new Date().toISOString(), type: String(type), ...sanitize(data || {}) };
    fs.appendFileSync(fileOf(), JSON.stringify(rec) + '\n', 'utf8');
    bumpLifetime(rec);
    return rec;
  } catch (_) {
    return null;
  }
}

// ─── 终身账本 ────────────────────────────────────────────────────────────────
// 日流水 90 天就 sweep 掉，「认识以来一共…」和账本里程碑要的是**终身数** ——
// 单独一个小文件按笔累加，读它不用扫盘（里程碑每分钟问一次，扫 90 个文件
// 是评审抓出来的主进程同步热点）。首次出现时拿现存流水补一发底账。
const LIFE_FILE = path.join(DIR, 'lifetime.json');
let lifeCache = null;

function lifetime() {
  if (lifeCache) return { ...lifeCache };
  try {
    lifeCache = JSON.parse(fs.readFileSync(LIFE_FILE, 'utf8'));
  } catch (_) {
    // 还没有底账：拿现存的日流水（最多 90 天）补一发。比真实终身数只少不多
    const agg = summarize(days().flatMap((d) => read(d)));
    lifeCache = { turns: agg.turns, tasks: agg.tasks + agg.terms, costUsd: agg.costUsd };
    saveLifetime();
  }
  if (typeof lifeCache.turns !== 'number') lifeCache = { turns: 0, tasks: 0, costUsd: 0 };
  return { ...lifeCache };
}

function bumpLifetime(rec) {
  try {
    lifetime(); // 保证 lifeCache 就绪
    if (rec.type === 'turn') lifeCache.turns += 1;
    if (rec.type === 'task-done' || rec.type === 'term-open') lifeCache.tasks += 1;
    if (typeof rec.costUsd === 'number' && isFinite(rec.costUsd)) lifeCache.costUsd += rec.costUsd;
    saveLifetime();
  } catch (_) { /* 底账坏了不拦记流水 */ }
}

function saveLifetime() {
  try { fs.writeFileSync(LIFE_FILE, JSON.stringify(lifeCache), 'utf8'); } catch (_) { /* 下次再写 */ }
}

/**
 * 读一天。day 给 'YYYY-MM-DD' 或时间戳或 Date，不给就是今天。
 *
 * 逐行 try/catch，坏行跳过：写盘半路被掐（关机、断电）会留半行，
 * 一行坏掉不许连累一整天。开头还要摘 BOM —— 这个项目已经因为 BOM
 * 让整份存档静默退回默认值栽过一次。
 */
function read(day) {
  const key = typeof day === 'string' ? day
    : (day === undefined || day === null ? dayKey() : dayKey(+new Date(day)));
  let text = '';
  try {
    text = fs.readFileSync(fileOf(key), 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      /* 半行、坏行，跳过 */
    }
  }
  return out;
}

/** 有流水的日子，升序 */
function days() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

/**
 * 把一堆记录汇成「这段时间发生了什么」。
 *
 * 关于钱：hook 事件里确实没有成本字段（那是独立的 claude 进程），但
 * **会话记录里有** —— src/cost.js 去读 Claude Code 自己写的 jsonl，把终端里
 * 烧的钱也算了进来（`term-cost` 那条流水）。
 *
 * `unpriced` 留着，语义收窄成「这几轮所在的那条线，一分钱都没算出来」——
 * 没装 Claude Code、记录路径变了、或者那条线还没落盘，都会落到这儿。
 * 宁可摆明少算，也绝不编一个数字糊弄人。
 */
function summarize(records) {
  const s = {
    costUsd: 0, unpriced: 0,
    terms: 0, turns: 0, reports: 0, tasks: 0, greets: 0, chats: 0,
    tools: 0, errors: 0,
    projects: [], lanes: [], milestones: [], briefs: [],
    firstAt: null, lastAt: null, stuck: null,
  };

  const projects = new Set();
  const byLane = new Map();
  // 「这条线算出钱了没有」。turn 和 term-cost 都带 termId，用它对齐；
  // 老流水没有 termId，退回项目+线名
  const turnsOf = new Map();
  const priced = new Set();
  const laneKey = (r) => r.termId || (r.project || '') + '/' + (r.lane || '');

  for (const r of records || []) {
    if (!r || typeof r !== 'object') continue;

    const t = Date.parse(r.at) || 0;
    if (t) {
      if (!s.firstAt || t < s.firstAt) s.firstAt = t;
      if (!s.lastAt || t > s.lastAt) s.lastAt = t;
    }
    if (r.project) projects.add(r.project);
    if (typeof r.costUsd === 'number' && isFinite(r.costUsd)) s.costUsd += r.costUsd;

    switch (r.type) {
      case 'term-open':
        s.terms += 1;
        break;

      case 'turn': {
        // 一轮 = 你说一句、她干完一段。tools/errors 是**这一轮**的量
        // （terminals.js 在 UserPromptSubmit 里清零），所以直接累加就是全天量。
        s.turns += 1;
        s.tools += r.tools || 0;
        s.errors += r.errors || 0;
        turnsOf.set(laneKey(r), (turnsOf.get(laneKey(r)) || 0) + 1);

        const key = r.termId || (r.project || '') + '/' + (r.lane || '');
        const cur = byLane.get(key) ||
          { project: r.project || '', lane: r.lane || '', turns: 0, tools: 0, errors: 0 };
        cur.turns += 1;
        cur.tools += r.tools || 0;
        cur.errors += r.errors || 0;
        byLane.set(key, cur);
        break;
      }

      case 'term-cost':
        // 钱在上面那句通用的 costUsd 累加里已经加过了，这儿只记「这条线算出钱了」
        priced.add(laneKey(r));
        break;

      case 'report':
        s.reports += 1;
        if (r.brief) s.briefs.push({ at: r.at, project: r.project || '', text: r.brief });
        break;

      case 'task-done':
        s.tasks += 1;
        break;

      case 'greet':
        s.greets += 1;
        break;

      case 'chat':
        s.chats += 1;
        break;

      case 'milestone':
        s.milestones.push(r.text || r.id || '');
        break;

      default:
        break;
    }
  }

  s.projects = [...projects];
  // 只有「一分钱都没算出来」的那些线才算没定价 —— 算出来的那些，
  // 钱已经在 costUsd 里了，再报一句「另有 N 轮算不到钱」就是自相矛盾
  for (const [key, n] of turnsOf) if (!priced.has(key)) s.unpriced += n;
  s.lanes = [...byLane.values()].sort((a, b) => b.turns - a.turns);
  // 「今天卡这儿最久」判据是**报错次数**，不是停顿时长 ——
  // 停得久多半是你去吃饭了，那不叫她卡住；报错多才是真在较劲。
  s.stuck = s.lanes.filter((l) => l.errors > 0).sort((a, b) => b.errors - a.errors)[0] || null;
  s.spanMin = s.firstAt && s.lastAt ? Math.round((s.lastAt - s.firstAt) / 60000) : 0;
  return s;
}

/** 今天（早上 5 点为界） */
function today() {
  return { date: dayKey(), ...summarize(read()) };
}

/** 这个月。天数有限（最多 31 个小文件），面板 3 秒刷一次也扛得住 */
function month(ts = Date.now()) {
  const prefix = dayKey(ts).slice(0, 7); // 'YYYY-MM'
  const ds = days().filter((d) => d.startsWith(prefix));
  return { month: prefix, days: ds.length, ...summarize(ds.flatMap((d) => read(d))) };
}

/** 从头到现在。面板不高频调这个，扫全部文件可以接受 */
function totals() {
  const all = days();
  const agg = summarize(all.flatMap((d) => read(d)));
  return {
    since: since(),
    // 「认识多少天」按 since 算（那个文件永不过期），不按幸存文件数 ——
    // 日流水 90 天就删，用文件数的话天数封顶 91，「认识以来」就成了谎话
    sinceDays: (() => {
      try { return Math.max(all.length, Math.floor((Date.now() - +new Date(since())) / 86400000) + 1); }
      catch (_) { return all.length; }
    })(),
    // 终身账（lifetime.json 按笔累加，不受 90 天清理影响）
    life: lifetime(),
    days: all.length,
    terms: agg.terms,
    turns: agg.turns,
    tasks: agg.tasks,
    greets: agg.greets,
    chats: agg.chats,
    costUsd: agg.costUsd,
    unpriced: agg.unpriced,
  };
}

/** 删掉太老的明细。启动时调一次就够，不起定时器 */
function sweep(keepDays = KEEP_DAYS) {
  const cut = dayKey(Date.now() - keepDays * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const d of days()) {
    if (d >= cut) continue;
    try {
      fs.unlinkSync(fileOf(d));
      removed += 1;
    } catch (_) {
      /* 删不掉就下次再说 */
    }
  }
  return removed;
}

module.exports = {
  add, read, days, summarize, today, month, totals, sweep, since,
  dayKey, redact, DIR, KEEP_DAYS, lifetime,
};
