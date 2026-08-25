'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const cost = require('./cost');
const agents = require('./agents'); // codex 那半边：捞会话、按 OpenAI 单价算钱

const ROOT = path.join(__dirname, '..');
const TERM_SHELL = path.join(ROOT, 'hooks', 'term-shell.js');
const FOCUS_PS1 = path.join(ROOT, 'tools', 'focus-window.ps1');

// 面板上一条线最多列几个「动过的文件」。列太多就成了刷屏，
// 而这一栏的价值是「一眼扫过去看她碰了哪儿」
// 每条线留多少条进度（手机详情页看的）。内存里放着，不落盘
const TIMELINE_KEEP = 60;

const FILES_SHOWN = 12;

// term-shell 每 5 秒一次心跳。超过这个还没动静，就当那个窗口已经被叉掉了。
// 心跳是兜底 —— 正常情况下靠 pid 探测能在几秒内就发现窗口没了。
const DEAD_MS = 18000;
const SWEEP_MS = 3000;

// 「她现在在干嘛」怎么判。两个门槛都是往宽了取的 —— 她身上的状态是给你
// 余光扫的，宁可慢半拍，也不能一有风吹草动就变脸，那样比不动还乱。
const STRUGGLE_ERRORS = 3;   // 这一轮里报错到这个数，就算在跟什么较劲
const STUCK_MS = 45000;      // 状态还是 running 但这么久没有任何事件 = 卡住了

// 已完成的任务在列表上留几条。留着是为了回头看「那个活干成什么样了」，
// 不是攒历史 —— 攒多了列表就没法看了
const FINISHED_KEEP = 8;

// 等那个窗口出现最多等多久。wt 的窗口是异步建的（wt.exe 只是转发器），
// 开完立刻去找必然找不着。
//
// 顺带记一条试过但**行不通**的路：`wt --pos 30000,30000` 想把窗口开到屏幕外，
// 这样连闪都不会闪。实测 wt **会把坐标夹回桌面范围内**（两块 1920 的屏，
// 30000 被夹成 1912，照样全露着）。所以只能开出来再收，露脸这一下躲不掉。
const WINDOW_WAIT_MS = 8000;

/**
 * 这个进程还活着吗。
 *
 * `process.kill(pid, 0)` 里的 0 不是信号，**它什么都不发、也不会结束任何进程** ——
 * 这是标准的存活探测写法：进程在就正常返回，不在就抛 ESRCH。
 * 名字里带个 kill 纯属历史包袱，别被吓着。
 */
function pidAlive(pid) {
  if (!pid) return null; // 还没报上来，判断不了
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程在，只是我们没权限碰它 —— 那也算活着
    return err && err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// 找家伙事
// ---------------------------------------------------------------------------

/**
 * 这个文件在不在。
 *
 * 不能用 fs.existsSync：Windows 的「应用执行别名」（wt.exe 正是其中之一）
 * 是个 93 字节的 reparse point，权限特殊，statSync 跟过去会直接 EACCES，
 * 于是 existsSync 一口咬定文件不存在 —— 明明 where.exe 找得到、也能跑起来。
 * accessSync 只问「在不在」，不跟过去，这类别名才认得出来。
 */
function existsFile(p) {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// Windows Terminal。有它就用它 —— 老式控制台那个灰白窗口实在太难看了。
function findWt() {
  const cands = [
    process.env.WAIFU_WT_BIN,
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe'),
  ];
  for (const c of cands) if (existsFile(c)) return c;

  // 还没有就问系统要一次。装法五花八门（Store、winget、便携版），
  // 挨个猜路径不如直接让 where 去找。
  try {
    const found = execFileSync('where.exe', ['wt.exe'], { encoding: 'utf8', windowsHide: true })
      .split('\n')[0].trim();
    if (found) return found;
  } catch (_) {
    /* 没装就是没装 */
  }
  return null;
}

/**
 * 找一个能跑 .js 的 node。
 *
 * 这里有个坑：在 Electron 里 process.execPath 是 electron.exe 而不是 node.exe，
 * 直接拿它跑脚本会打开一个 Electron 应用而不是执行 js。所以优先找真的 node；
 * 实在找不到，才回落到 electron.exe 并靠 ELECTRON_RUN_AS_NODE 把它掰成 node。
 */
function findNode() {
  if (existsFile(process.env.WAIFU_NODE_BIN)) {
    return { bin: process.env.WAIFU_NODE_BIN, asNode: false };
  }

  const exe = path.basename(process.execPath).toLowerCase();
  if (exe === 'node.exe' || exe === 'node') {
    return { bin: process.execPath, asNode: false };
  }

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'node.exe');
    if (existsFile(p)) return { bin: p, asNode: false };
  }

  return { bin: process.execPath, asNode: true };
}

// ---------------------------------------------------------------------------
// 从 transcript 里抠出「她刚才干完了什么」
// ---------------------------------------------------------------------------

/**
 * Claude Code 把每条消息按行追加进一个 .jsonl。一轮结束时（Stop hook）读它的
 * 尾巴，就能拿到她最后说的那段话 —— 这就是要播报给你的「阶段成果」。
 *
 * 只读文件末尾一小段：这些文件动辄几 MB，为了一句话全量读进来太蠢了。
 */
function readLastAssistantText(file, tailBytes = 256 * 1024) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    if (len <= 0) return null;

    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);

    const lines = buf.toString('utf8').split('\n');
    // 从文件末尾往回找第一条助手文本 —— 中间夹着的工具调用和结果全跳过
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line[0] !== '{') continue; // 截断的半行

      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }

      const msg = obj.message || obj;
      if (obj.type !== 'assistant' && msg.role !== 'assistant') continue;

      const content = msg.content;
      if (typeof content === 'string' && content.trim()) return content.trim();
      if (!Array.isArray(content)) continue;

      const text = content
        .filter((b) => b && b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  } catch (_) {
    /* 读不到就算了，播报少一句不是什么大事 */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* noop */ } }
  }
  return null;
}

/**
 * 找到这一轮对话的 transcript 文件。
 *
 * 不能盲信 hook 给的 transcript_path：实测过，交互式会话里 hook 报的文件名
 * （7b6ae979…）跟真正落盘的（6df67647…）对不上，照着读只会读到个寂寞。
 *
 * 但也**绝不能**退化成「挑这个目录里最近改过的那个」。试过，后果很难看：
 * 那个目录里还躺着用户自己正在用的会话，文件时时刻刻在被写，
 * 于是她张嘴汇报的是别人说的话 —— 宁可这轮不吭声，也不能把别人的话安到她头上。
 *
 * 所以只认两个准头：我们自己发给 claude 的那个 session id（最可信，
 * 因为就是我们指定的），以及 hook 自己报的路径。都不中就老实返回 null。
 */
function resolveTranscript(ev, knownSessionId) {
  const given = ev && ev.transcript_path;
  const dir = given ? path.dirname(given) : null;

  if (dir && knownSessionId) {
    const mine = path.join(dir, knownSessionId + '.jsonl');
    if (fs.existsSync(mine)) return mine;
  }

  if (given && fs.existsSync(given)) return given;

  if (dir && ev.session_id) {
    const bySession = path.join(dir, ev.session_id + '.jsonl');
    if (fs.existsSync(bySession)) return bySession;
  }

  return null;
}

// ---------------------------------------------------------------------------

/**
 * 开出去的终端窗口，一个都别丢。
 *
 * 跟 sessions.js 的分工：
 *   sessions.js  管「她自己闷头干的活」—— 进程是我们起的，输出直接读
 *   这里         管「你要盯着看的活」—— 跑在独立终端里，我们只能在旁边看着
 *
 * 「在旁边看着」靠两条线：
 *   · term-shell 上报开/心跳/关   → 知道窗口还在不在
 *   · claude 的 hook 事件带 termId → 知道她干到哪一步了、这一段干完了什么
 */
/**
 * 干完一段之后**念出来**的那句话。
 *
 * 跟气泡上显示的那句是两回事，必须分开拼：
 *
 *   · 气泡是**看**的 —— 可以放她汇报的原话，你一眼扫过去就知道她说了啥
 *   · 语音是**听**的 —— 听是线性的，你没法跳着听，长了就变噪音
 *
 * 原来念的是「项目名 + 改了 a.js、b.js、c.js + 她原话的前 40 个字」。
 * 两个毛病：一串文件名念出来纯粹是噪音；截到 40 字的半句话既听不懂又占时间，
 * **听完反而不知道她干了啥**。
 *
 * 现在只留三件你真正需要的：哪个项目、成没成、动了多大范围（说个数，不念文件名），
 * 最后补一句「要不要点开看」—— 那个气泡确实是可以点的，不说没人知道。
 *
 * @param {object} o
 * @param {string} o.name        项目名
 * @param {number} o.errorCount  这一段里报了几次错
 * @param {string[]} o.files     动过的文件
 * @param {number} o.pick        0~1，挑哪句收尾（注入随机数，好让自检可复现）
 */
function spokenReport({ name, errorCount = 0, files = [], pick = Math.random() }) {
  const n = Array.isArray(files) ? files.length : 0;
  const scope = n === 1 ? '改了一个文件' : (n > 1 ? '改了 ' + n + ' 个文件' : '');
  const how = errorCount ? '中间报了错' : '';

  // 收尾那句轮着换。每隔二十秒听一遍一模一样的话，比不说还烦
  const TAILS = ['要看现场就点我一下。', '想看的话点我一下。', '点我一下能看现场。'];
  const tail = TAILS[Math.min(TAILS.length - 1, Math.max(0, Math.floor(pick * TAILS.length)))];

  return ['「' + name + '」这段完事了', how, scope].filter(Boolean).join('，') + '。' + tail;
}

// ---------------------------------------------------------------------------
// 「她干的事对不对」—— 动手之前先扫一眼
//
// 原来那套状态（顺利 / 一直报错 / 卡住 / 等你确认）全是「她顺不顺」，
// **没有一条是「她干的事对不对」**。等她开口汇报时，可能已经把你另一个
// 项目的文件改了。而 PreToolUse 事件里 tool_input 是全的 —— 她要动哪个文件、
// 要跑什么命令，在**动手之前**就看得见。
//
// 三条铁律：
//
//   1. **只喊不拦。** PreToolUse 确实能拦（exit 2 / stdout 出 JSON），但那条路
//      在这个项目里是禁区：hooks/notify.js 头上写着「无论如何以 0 退出」
//      「绝不往 stdout 写东西（会被当指令回灌给模型）」，而且它是 fire-and-forget、
//      800 毫秒就超时，根本等不到主进程的裁决。权限模式本来就是 auto（有真分类器），
//      我们这几条正则不比它强，当硬闸只会拦掉正经活。
//
//   2. **最大的风险是误报，不是漏报。** 一天响八回，你第二天就把它关了，
//      那还不如没有。所以规则窄到能一眼数完，`rm -rf node_modules` 这种
//      天天都在跑的必须一声不吭。宁可漏一次。
//
//   3. **只准干微秒级的事。** 这段跑在主进程、在 server.js 回 204 之前，
//      hook 那头是真的在等。绝不许 spawn、读大文件、跑 PowerShell。
// ---------------------------------------------------------------------------

// 一轮里整份重写这么多个**已经存在**的文件，就该喊你了 —— 多半是理解偏了在大改。
// 只算 Write（整份覆盖），不算 Edit：Edit 是外科手术，一轮改十几处也很正常。
const REWRITE_MAX = 5;

// 喊完之后她保持「转过来正对着你」这么久，然后自己转回去接着干
const ALARM_MS = 25000;

/**
 * 这个路径在那个目录里面吗。
 *
 * **末尾必须补分隔符**：`'D:\WaifuCode\x'.startsWith('D:\Waifu')` 是 true ——
 * 不补的话，隔壁那个同名前缀的目录会被当成「在你目录里」而静默放过。
 *
 * 「等于目录本身」判 false 是故意的：`rm -rf .` 删的就是整个派活目录，那必须喊。
 * （Edit 的目标永远是文件、不会等于目录，两边共用一个函数不打架。）
 */
function isInside(p, dir) {
  if (!p || !dir) return false;
  try {
    const base = path.resolve(dir).toLowerCase().replace(/[\\/]+$/, '') + path.sep;
    return path.resolve(dir, p).toLowerCase().startsWith(base);
  } catch (_) {
    return false; // 路径畸形，当它不在里面（偏保守）
  }
}

/**
 * 临时目录一律放行 —— claude 往那儿写脚本、写中间产物是家常便饭。
 *
 * **只认绝对路径。** isInside 会把相对路径按第二个参数解析，所以不加这道判断的话
 * `~` 会被拼成「临时目录\~」而判成「在临时目录里」→ 一路放行 ——
 * 那可是要删你主目录的命令。
 */
function isTemp(p) {
  if (!p) return false;
  // Git Bash / WSL 风格的临时目录。这台机器上没有 /tmp 这个真目录，
  // 但 claude 的 Bash 工具就是 Git Bash，`rm /tmp/x.log` 是常态写法 ——
  // 交给下面 path.isAbsolute 那条的话会被 resolve 成「项目盘符\tmp\x.log」
  if (/^\/(tmp|var\/tmp)\//i.test(p)) return true;
  if (!path.isAbsolute(p)) return false;
  for (const t of [os.tmpdir(), process.env.TEMP, process.env.TMP]) {
    if (t && isInside(p, t)) return true;
  }
  return false;
}

/**
 * 这个工具要动的是哪个文件。
 *
 * NotebookEdit 用的是 `notebook_path` 不是 `file_path` —— 原来记「她动过哪些文件」
 * 那段正则匹到了 NotebookEdit 却去读 file_path，永远是 undefined，
 * 所以笔记本文件从来没被记进去过。这儿顺手修掉。
 */
function filePathOf(toolName, toolInput) {
  if (!toolInput) return '';
  if (String(toolName) === 'NotebookEdit') return toolInput.notebook_path || '';
  return toolInput.file_path || '';
}

const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const SHELL_TOOLS = /^(Bash|PowerShell)$/;

/**
 * 喊话里提到的路径只留最后一段。
 *
 * 那句话会**原样念出去**（走 msedge-tts，文本要发到微软的服务器），
 * 而且会在气泡上停十几秒。整条 `C:\Users\某某\...` 念出来又长又没用，
 * 还把你的目录结构播了一遍。想看全的，点气泡跳到那个终端里看。
 */
function brief(p) {
  const last = path.posix.basename(path.win32.basename(String(p)));
  return last && last !== p ? '…' + path.sep + last : String(p);
}

// 把一条命令行切成词，**先吃引号段** —— 不然
// `Remove-Item -Force "D:\My Project\dist"` 会碎成 `"D:\My` 和 `Project\dist"`，
// 前半截判成「目录外」，当场误报。
function words(cmd) {
  return String(cmd).match(/"[^"]*"|'[^']*'|\S+/g) || [];
}
const unquote = (w) => w.replace(/^["']|["']$/g, '');

/**
 * 删除类命令。三个讲究，每一个都是踩出来的：
 *
 * · **目标必须在「命令头」**（行首、管道/分号之后、或 sudo 之后），
 *   不然 `git rm -r --cached .`、`npm rm lodash` 全会误报。
 *   代价是 `find . -exec rm {} \;` 漏掉 —— 认了，宁可漏报。
 * · **`\n` 必须排除掉。** JS 的取反字符组跟 `.` 相反，**它是吃换行的** ——
 *   而 Bash 工具天天传多行命令。不排除的话，
 *   `rm -rf dist\ngit add .` 里第二行那个 `.` 会被当成「要删的东西」，
 *   当场喊「要删项目目录外面的东西」。这类误报一天能来好几回。
 * · **要带 `m` 标志。** `^` 只匹配整串开头的话，`npm ci\nrm -rf D:\别的项目`
 *   这种第二行才动手的完全静默 —— 那正是最该抓的。
 */
const RM_HEAD = /(?:^|[|;&]\s*|\bsudo\s+)(rm|rmdir|rd|del|erase|Remove-Item|ri)\s+([^|;&\r\n]*)/gim;

// 预演，什么都不删，见到就整条放行
const WHATIF = /(?:^|\s)(?:-WhatIf|--dry-run)(?![\w-])/i;

/**
 * git clean 的预演。
 *
 * `git clean -n` **不列目录**，所以真实世界的预演一律写成 `-nd`／`-ndx`／`-nxd`
 * —— 只放过光杆 `-n` 等于没放过。而且后果比单纯误报还糟：谨慎的人
 * 「先预演、再动手」时，**预演那次把警报用掉了**，等他真 `git clean -fd`
 * 的时候反倒被同一轮的去重吞掉，一声不吭 —— 护栏在最该响的那次哑了。
 *
 * 所以判据是「短选项串里带 n」，不是「等于 -n」。
 */
const CLEAN_DRY = /(?:^|\s)-[a-z]*n[a-z]*(?![\w-])|--dry-run/i;

// 剩下这几条，命中就是回不来的。
// 全部用 [^|;&\r\n] 而不是 [^|;&] —— 理由同上，取反字符组吃换行，
// 不排除的话 `git push\ntail -f log.txt` 会被报成「要强推远端」。
const DANGERS = [
  [/\bgit\s+reset\s+--hard\b/i, 'reset', '要 git reset --hard，没提交的改动会全没'],
  // --force-with-lease 是安全的那个，靠后面那个负向前瞻放它过去
  [/\bgit\s+push\b[^|;&\r\n]*\s(?:--force|-f)(?![\w-])/i, 'push', '要强推远端，别人的提交可能被盖掉'],
  [/\bgit\s+clean\b[^|;&\r\n]*\s-[a-z]*[fd][a-z]*(?![\w-])/i, 'clean', '要 git clean，没加进版本库的文件会没'],
  [/\bdrop\s+(database|table|schema)\b/i, 'drop', '要删数据库'],
  // 必须在命令头 + 带盘符：`npm run format` 和 `dotnet format D:\proj` 都不能中招。
  // **m 标志是生死线**：不带的话 ^ 只认整串开头，`npm ci\nformat D:` 这种
  // 第二行动手的静默放行 —— RM_HEAD 的注释早点名过这个坑（评审抓的）
  [/(?:^|[|;&]\s*)format\s+[a-zA-Z]:/im, 'format', '要格式化磁盘'],
  // 同样限定命令头，不然 node graceful-shutdown.js 会中招
  [/(?:^|[|;&]\s*)(shutdown|Stop-Computer|Restart-Computer)\b/im, 'power', '要关机或重启这台电脑'],
  // 杀进程：用户明文立过规矩「绝不擅自结束用户进程」，监督却一直放行。
  // 命令头限定（node stop-process.js 不中招）；光杆 kill 是 bash 内建太常见，
  // 只抓带 -9/-KILL 的那种没商量的
  // m 必带（多行第二行动手）；sudo 前缀照 RM_HEAD 的写法；-s KILL / -SIGKILL
  // 就是 -9 换个拼法，一起算「没商量的那种」
  [/(?:^|[|;&]\s*|\bsudo\s+)(taskkill|Stop-Process|pkill|killall)\b|(?:^|[|;&]\s*|\bsudo\s+)kill\s+-(?:9\b|KILL\b|SIGKILL\b|s\s+(?:SIG)?KILL\b)/im,
   'kill', '要强杀进程 —— 这个你立过规矩要先问'],
  // 丢没提交的改动：跟 reset --hard 同罪的两兄弟。只抓整目录形（带具体
  // 文件名的 checkout -- file 太常见于正当回滚，报起来会狼来了）
  // 整目录形的常见变体都要认：checkout .、checkout ./、checkout HEAD -- .、
  // restore --source=X .（评审实测原版全放行了）。--staged 是安全的取消暂存，
  // 负向前瞻放它过去 —— 除非同串还带 --worktree（那就真丢改动了）。
  // 已知绕法：把 . 打引号（checkDanger 匹配前挖掉引号段）—— 引一个点太刻意，
  // 认了；单文件形（checkout -- file）故意不拦，防狼来了
  [/\bgit\s+(?:checkout|restore)\b(?![^|;&\r\n]*--staged(?![^|;&\r\n]*--worktree))[^|;&\r\n]*(?:\s|=)\.\/?(?=\s|$)/im,
   'restore', '要丢掉整个目录没提交的改动'],
  [/\bgit\s+stash\s+(?:drop|clear)\b/i, 'stash', '要扔掉 stash 里存着的改动'],
];

/**
 * 她这一下动手，要不要喊你？返回 { kind, why } 或者 null。
 *
 * 纯函数、无 I/O（除了调用方自己那次 existsSync），所以能单测 ——
 * tools/test-termlife.js 的 [13] 节拿三十多条真命令喂它。
 */
function checkDanger({ toolName, toolInput, dir }) {
  const name = String(toolName || '');

  // 写类工具：目标跑到派活目录外面去了。
  // **只管写，绝不管读** —— Read/Glob/Grep 翻 node_modules、翻隔壁仓库、
  // 读 ~/.claude/CLAUDE.md 是家常便饭，把读算上这功能第一天就废了。
  if (WRITE_TOOLS.test(name)) {
    const fp = filePathOf(name, toolInput);
    if (fp && !isInside(fp, dir) && !isTemp(fp)) {
      return { kind: 'outside', why: '要改的文件不在这个项目目录里（' + path.basename(fp) + '）' };
    }
    return null;
  }

  if (!SHELL_TOOLS.test(name)) return null;
  const cmd = String((toolInput && toolInput.command) || '');
  if (!cmd) return null;

  // 整条都是预演（`Remove-Item -WhatIf`、`--dry-run`）
  if (WHATIF.test(cmd)) return null;

  // 匹配「回不来的命令」时先把引号段挖掉 —— 不然
  // `git commit -m "先 git reset --hard 再说"` 这种会照着字面报警。
  // 删除那条不能这么干（`rm -rf "D:\别的项目"` 的目标就在引号里），所以只用在这儿。
  const bare = cmd.replace(/"[^"]*"|'[^']*'/g, ' ');
  for (const [re, kind, why] of DANGERS) {
    if (!re.test(bare)) continue;
    if (kind === 'clean' && CLEAN_DRY.test(bare)) continue;
    return { kind, why: '要跑的命令回不来了 —— ' + why };
  }

  // 删除：逐个目标看是不是**严格**在派活目录里面
  RM_HEAD.lastIndex = 0;
  let m;
  while ((m = RM_HEAD.exec(cmd))) {
    for (const raw of words(m[2])) {
      const w = unquote(raw);
      if (!w || w.startsWith('-')) continue;
      // cmd 的开关（/s /q /f /y）长得跟 unix 的绝对路径一样。
      // **只放过一两个字母的** —— 写成 `[a-zA-Z]+` 的话 `/usr`、`/etc`、`/home`
      // 全被当成开关静默放过了，而那几个恰恰是最该抓的。
      // 光杆 `/`（`rm -rf /`）本来就不匹配，照样会被查。
      if (/^\/[a-zA-Z]{1,2}$/.test(w)) continue;
      // 临时目录随便删 —— 跟上面写类工具那条一个道理
      if (isTemp(w)) continue;
      // `~` 是你的主目录。**不能交给 path.resolve** ——
      // 它会拼成「项目目录\~」，看着「在里面」就被静默放过了
      if (w === '~' || /^~[\\/]/.test(w)) {
        return { kind: 'rm', why: '要删你主目录底下的东西（' + brief(w) + '）' };
      }
      // 环境变量在这儿同样展不开：%USERPROFILE%\x 会被拼成
      // 「项目目录\%USERPROFILE%\x」→ 看着「在里面」→ 静默放过，
      // 而这恰恰最该拦。所以见到变量一律报，宁可多喊一次。
      if (/[%$]/.test(w)) {
        return { kind: 'rm', why: '要删的东西路径里带变量，展开之后可能是任何地方（' + brief(w) + '）' };
      }
      if (!isInside(w, dir)) {
        return { kind: 'rm', why: '要删这个项目目录外面的东西（' + brief(w) + '）' };
      }
    }
  }

  return null;
}

class TerminalManager extends EventEmitter {
  constructor({ storeDir, log, claudeBin, getConfig, runtimeFile }) {
    super();
    this.storeDir = storeDir;
    this.specDir = path.join(storeDir, 'terminals');
    // 终端那头靠这个文件找到我们（桌宠重启会换端口，所以不能只认一个死端口）。
    // 做成可覆盖是为了自测：不然测试脚本会把事件汇报给正开着的那只桌宠。
    this.runtimeFile = runtimeFile || path.join(storeDir, 'runtime.json');
    fs.mkdirSync(this.specDir, { recursive: true });

    this.log = log || (() => {});
    this.claudeBin = claudeBin;
    this.getConfig = getConfig || (() => ({}));

    this.items = new Map(); // id -> 终端记录
    this.seq = 0;

    this.wt = findWt();
    this.node = findNode();
    this.log('[term] 终端: ' + (this.wt || '（没找到 Windows Terminal，回落到老式控制台）'));
    this.log('[term] node: ' + this.node.bin + (this.node.asNode ? ' (ELECTRON_RUN_AS_NODE)' : ''));

    this._initSeq();

    this.timer = setInterval(() => this._sweep(), SWEEP_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // --- 开一个 ---------------------------------------------------------------

  /**
   * 开一个终端。
   *
   * minimized=true 就是「后台干活」：**照样是一个真终端**，有完整的滚屏和现场，
   * 只是开出来直接最小化，不往你脸上弹。要看现场就 focus 它 ——
   * focus-window.ps1 里已经处理了「最小化的先 SW_RESTORE」。
   *
   * 这条路解决的是无头模式最难受的一点：**跑挂了你看不到现场**。
   * 无头模式只能从 stream-json 里捞到一句摘要，栈、上下文、她当时试了什么，全没了。
   */
  /**
   * 这个目录下**还开着**的终端 —— 现在可能有好几个。
   *
   * 以前同一个目录只准开一个（怕两条终端 --resume 同一条会话把记忆写乱），
   * 所以这里只返回一个就够了。现在每开一个终端都是一条新会话，各写各的，
   * 于是同目录并行成了正常情况，调用方要的是**全部**。
   */
  livesFor(dir) {
    const key = path.resolve(dir).toLowerCase();
    const out = [];
    for (const rec of this.items.values()) {
      if (rec.status === 'closed' || rec.status === 'done') continue;
      if (path.resolve(rec.dir).toLowerCase() === key) out.push(rec);
    }
    return out;
  }

  /** 同目录第一个还活着的。判断「这是不是这个目录的头一条」用它 */
  liveFor(dir) {
    return this.livesFor(dir)[0] || null;
  }

  /**
   * 挑一个**不会跟别的窗口撞**的标题。
   *
   * 标题是你在任务栏里认窗口的唯一依据，也是 focus-window.ps1 找窗口的依据 ——
   * 撞了就会点 A 跳出 B。而任务栏是不分目录的，所以这里得跟**所有**还开着的
   * 终端比，不能只跟同目录的比。
   *
   * 只有 closed 才把标题让出来：窗口都没了，标题自然不占坑。
   * done（活干完了但窗口还开着）**照样占坑** —— 那个窗口还在任务栏上杵着。
   */
  _uniqueTitle(base) {
    const taken = new Set();
    for (const rec of this.items.values()) {
      if (rec.status !== 'closed') taken.add(rec.title);
    }
    if (!taken.has(base)) return base;
    for (let n = 2; n < 200; n++) {
      if (!taken.has(base + ' #' + n)) return base + ' #' + n;
    }
    return base + ' #' + this.seq; // 开了两百个同名窗口，理论上到不了
  }

  open({
    projectPath, task, sessionId, resume, extraArgs,
    name, laneId, laneName, port, minimized = false,
    // 这一次用哪个权限模式。面板上可以临时选，不给就用配置里的默认值 ——
    // 「这个活让她放开手脚 / 这个活我要盯着」是逐次的决定，
    // 不该每次都跑去设置面板改一遍全局配置
    permissionMode,
    // 用哪个模型。面板上选的（选一次就记在 config 里），不给就跟
    // Claude Code 自己的设置走。**这里不校验** —— 校验挡在 main.js 的入口，
    // 这儿只负责往 spec 里放
    model,
    // 用哪个 CLI（'claude' 缺省 / 'codex'）。校验同样挡在 main.js。
    // codex 的可执行文件路径由 bin 带进来（claude 有构造时的 this.claudeBin，
    // codex 是逐次现解析的）；notesFile 是小抄路径 —— codex 没有
    // --append-system-prompt-file，term-shell 把内容拼进开场 prompt
    agent, bin, notesFile,
    // codex 线「接着聊」：上次认领到的会话（resume 用）。新线没有
    codexSessionId, codexFile,
  }) {
    const dir = path.resolve(projectPath);
    if (!fs.existsSync(dir)) throw new Error('项目目录不存在: ' + dir);

    const id = 'w' + ++this.seq;
    const project = name || path.basename(dir);
    // 控制字符（尤其 CR/LF）必须在这儿就杀掉 —— 这条 lane 会拼进 title，
    // title 会被 _writeLauncher 逐行写进 .cmd 启动器再交给 cmd 执行。
    // 夹一个换行就能在**沙箱外**多跑一行任意命令（评审抓的高危：手机
    // /api/dispatch 收 laneName，一路只 trim 就到这儿）。这是唯一汇口，
    // 桌面/手机/右键所有派活都过这条，堵在源头
    const lane = String(laneName || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60);

    // 主线就叫项目名（跟以前一模一样）；分线在后面缀上线名，
    // 这样任务栏上「WaifuCode · 登录页表单校验」和「WaifuCode · 查支付」
    // 一眼就分得开
    const label = lane ? project + ' · ' + lane : project;
    const windowName = 'waifu-' + id;
    const title = this._uniqueTitle('WaifuCode · ' + label);

    const spec = {
      id, dir, task: task || '', sessionId, resume: Boolean(resume),
      // 小抄那两个参数从这儿流到 term-shell（它早就会读 spec.extraArgs 了，
      // 所以那条链一个字都不用动 —— 那正是离「加个 --setting-sources project
      // 就把 5 个 hook 静默搞死」最近的地方，能不碰就别碰）。
      // 空的就不写进 json，让参数文件保持干净
      extraArgs: Array.isArray(extraArgs) && extraArgs.length ? extraArgs : undefined,
      laneId: laneId || null, laneName: lane,
      minimized: Boolean(minimized),
      agent: agent === 'codex' ? 'codex' : undefined,
      bin: bin || undefined,
      notesFile: notesFile || undefined,
      // codex 线要能喊「在等你确认」：hook 命令要写绝对路径（hook 的执行环境
      // 未必有 node 在 PATH 上）。claude 线不需要 —— 它那 5 个 hook 是装在
      // ~/.claude/settings.json 里的，不走命令行
      notifyFile: agent === 'codex' ? path.join(__dirname, '..', 'hooks', 'notify.js') : undefined,
      nodeBin: agent === 'codex' ? this.node.bin : undefined,
      // 让那个 hook 被信任（不信任 = 静默不跑）。main.js 启动时问过一次存在
      // config 里；还没问到就先不带，这次窗口只是没有「等你确认」的提醒
      codexHookHash: agent === 'codex'
        ? ((this.getConfig().codex || {}).hookHash || undefined) : undefined,
      codexSessionId: codexSessionId || undefined,
      codexFile: codexFile || undefined,
      // claude 线「接着聊」续写的是**同一份**会话记录，里面躺着旧窗口已经
      // 结算进流水的全部历史 —— 接手点以前的钱不是这个窗口花的，得记基线，
      // 不然新窗口第一轮结算就把整段历史再入一遍账（评审实测：$50 记成 $100）。
      // codex 线不走这儿（它有 codexBase 那套）；新线 resume=false 也不用记
      costBase: (agent !== 'codex' && resume && sessionId)
        ? (() => { try { return cost.ofSession(sessionId).total; } catch (_) { return 0; } })()
        : undefined,
      // 起点基线（**token**，不是美元 —— 换模型时差值才不会被价目差抹掉）：
      // 接着聊落在同一份文件里续写时，这个窗口的钱 = (现在的累计 - 基线) 按
      // 当前模型定价。新文件基线自然是空
      codexBase: (() => {
        if (!codexFile) return undefined;
        const u = agents.codexUsage(codexFile);
        return u && u.totals ? u.totals : undefined;
      })(),
      // 汇报从哪个字节起跟：接着聊续写同一份文件时，文件里已有的都是上一窗的，
      // 从当前末尾开始 —— 增量读的「基线」就这一个数
      codexOffset: (() => {
        if (!codexFile) return undefined;
        try { return fs.statSync(codexFile).size; } catch (_) { return null; }
      })(),
      name: label, project, port, claudeBin: this.claudeBin, windowName, title,
      runtimeFile: this.runtimeFile,
      permissionMode: permissionMode || (this.getConfig().terminal || {}).permissionMode || 'auto',
      model: model || undefined,
    };
    fs.writeFileSync(path.join(this.specDir, id + '.json'), JSON.stringify(spec, null, 2), 'utf8');

    const rec = this._makeRecord(spec, {
      status: task && task.trim() ? 'running' : 'idle',
    });
    this.items.set(id, rec);
    // 「接着聊」开的新窗口就是那条线的延续 —— 同一条线已经关掉的旧行收走。
    // 不收的话面板上同名两行（一暗一亮），看着像没接上（实机反馈的）。
    // 只收 closed：done 的窗口还开着，那行还能点过去看结果
    if (spec.laneId) this._retireLane(spec.laneId, id);

    this._launch(spec);
    this.emit('change');
    this.log('[term] 开窗口 ' + id + ' -> ' + dir);
    return { id, name: label, dir };
  }

  /**
   * 写一个启动器 .cmd。
   *
   * 为什么要多这一个文件，而不是把命令直接摆到 wt 的命令行上：
   * 那样至少有三个带空格的东西要过 wt 的解析器（node 路径可能是
   * "C:\Program Files\nodejs\node.exe"、脚本路径、项目路径），
   * 一旦被拆断就是一句莫名其妙的报错。压成一个可执行文件路径之后，
   * 需要过转义的只剩这一个东西，翻车面小了一大截。
   *
   * 顺带把代码页切成 UTF-8 —— 不然 term-shell 输出的中文在控制台是一堆乱码。
   */
  _writeLauncher(spec) {
    const file = path.join(this.specDir, spec.id + '.cmd');
    const specFile = path.join(this.specDir, spec.id + '.json');
    const cmd = '"' + this.node.bin + '" "' + TERM_SHELL + '" "' + specFile + '"';
    const nodeLine = this.node.asNode
      // 没有真 node 时借 electron.exe 冒充，得先把这个开关打开
      ? 'set ELECTRON_RUN_AS_NODE=1\r\n' + cmd
      : cmd;

    const body = [
      '@echo off',
      'chcp 65001 >nul',
      'title ' + spec.title,
      nodeLine,
      '',
    ].join('\r\n');

    fs.writeFileSync(file, body, 'utf8');
    return file;
  }

  _makeRecord(spec, extra = {}) {
    const now = Date.now();
    return {
      id: spec.id,
      name: spec.name,
      project: spec.project || spec.name,
      laneId: spec.laneId || null,
      laneName: spec.laneName || '',
      dir: spec.dir,
      task: spec.task || '',
      sessionId: spec.sessionId,
      agent: spec.agent || 'claude',
      // codex 的钱和「接着聊」全系在这仨上。认领（_codexPeek）会更新它们，
      // 并回写进 spec 文件 —— 桌宠重启 _adopt 认回窗口时才不丢
      codexSessionId: spec.codexSessionId || null,
      codexFile: spec.codexFile || null,
      codexBase: spec.codexBase || null,
      // 盯档案的进度。codexSeen 是每报完一轮落进 spec 的（偏移、报到第几轮、
      // 最后那句）—— 不落的话桌宠重启认回来会把刚报过的那轮**原样重播一遍**
      // （气泡+语音+小抄+流水各来一份，评审抓的）
      codexOffset: spec.codexSeen ? spec.codexSeen.offset
                 : (spec.codexOffset != null ? spec.codexOffset : null),
      codexCarry: null, // 这一轮攒到一半的工具/报错/文件（轮没完先存着）
      // 认领状态**要落盘**（_codexPeek 回写 spec 时置 true）：不落的话桌宠
      // 重启 _adopt 认回来会重新开抢 90 秒，能把已经对的绑定改成别人的会话
      codexClaimed: Boolean(spec.codexClaimed),
      windowName: spec.windowName,
      title: spec.title,
      status: 'idle',
      pid: null,
      startedAt: now,
      lastSeen: now,
      // 只由「真干活的动静」更新（claude 的 hook / codex 的档案长了），
      // 心跳不碰 —— 判「卡住」全靠它。用 lastSeen 判的话心跳每 5 秒喂一口，
      // 45 秒的门槛从生下来就够不到（评审抓的：stuck 灯是死的）
      lastHookAt: now,
      // codex 线重启认回来要接着上次的数（claude 的 spec 没有 codexSeen，还是 0）
      turns: (spec.codexSeen && spec.codexSeen.turns) || 0,
      toolCount: 0,
      errorCount: 0,
      files: new Set(), // 这一轮她动过的文件（每轮清空，拼汇报那句话用）
      // 从头到尾动过的所有文件，**不清空**，存全路径。
      // 面板上列出来给你看 —— 「改了 profiles.js、stage.js」比「动了 8 次工具」
      // 有用得多，那才是你能直接去核对的东西
      filesAll: new Map(), // 全路径 -> 动过几次
      lastPrompt: '',   // 这一轮你让她干的是什么
      // 这条线的来龙去脉（手机详情页看的就是它）：你说了什么、她汇报了什么、
      // 报了什么错、什么时候等确认。只留最近 TIMELINE_KEEP 条，内存里放着，
      // 不落盘 —— 重启后靠 lastReport 兜底，够用
      timeline: [],
      // 这俩从 spec 读回来：重启后「异常退出」的红行和「她喊过你」的留底
      // 不能蒸发（评审抓的）
      exitCode: spec.exitCode === undefined ? null : spec.exitCode,
      lastAlarm: spec.lastAlarm || null,
      // 这条线烧了多少钱（美元，按官方 API 单价折算，见 cost.js）。
      // paid 是已经记进流水账的部分，差额就是还没记的
      costUsd: 0,
      // codex 线每轮结账后落盘（_codexPersist）：不落的话重启认回来 costPaid
      // 归零，整条线的钱在流水里**再记一遍**（评审抓的，撞「不许重复计钱」那条）
      costPaid: spec.costPaid || 0,
      // 换过会话的线，钱从换的那一刻算起（_rebindSession 落的盘，
      // 桌宠重启 _adopt 认回窗口时读回来 —— 不读的话整条老会话的历史
      // 会一次性算到这个窗口头上）
      costCarry: spec.costCarry || 0,
      costBase: spec.costBase || 0,
      // 账冻住了（别的线跟到这条会话上了，往后归那条算）。**必须落盘**：
      // 不落的话重启认回来这条线又开始跟着涨，同一笔钱还是摆两遍
      costFrozen: Boolean(spec.costFrozen),
      // 「她干的事对不对」用的三个。**必须在这儿初始化** ——
      // _adopt（桌宠重启后认回终端）也走这个函数，漏了的话 warned.has() 直接抛，
      // 而这行跑在 hook 处理路径上，抛出去就是整条 hook 链断掉
      rewrites: 0,           // 这一轮整份重写了几个已有文件
      warned: new Set(),     // 这一轮已经喊过哪几类（同一类只喊一次）
      alarmUntil: 0,         // 喊完之后转过来看着你，到这个时刻为止
      lastBeat: 0,           // 上一次心跳。_sweep 拿它兜 pid 被复用的底
      staleBeats: 0,         // 心跳断了之后连着几拍没缓过来
      lastReport: (spec.codexSeen && spec.codexSeen.lastReport) || '',
      lastReportAt: 0,
      // 这条线是「她被派出去的活」还是「你自己开的终端」。干完时的反应不一样：
      // 前者算她自己的成败（按一个活结算心情），后者她只是在旁边盯着 ——
      // 不然你敲一晚上代码，她的情绪会被你的编译结果带着上蹿下跳
      dispatched: Boolean(spec.minimized),
      finished: false, // 「干完了」只许报一次：close 和 SessionEnd 可能都来
      ...extra,
    };
  }

  /**
   * 桌宠重启了，但那些终端窗口还开着 —— 把它们认回来。
   *
   * 不认的话，你重启一次桌宠，面板上就空了，明明桌面上还开着三个窗口在干活。
   * 它们还在按时报心跳，凭这个就能把它们捡回列表里。
   */
  _adopt(id, payload) {
    const specFile = path.join(this.specDir, id + '.json');
    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    } catch (_) {
      return null; // 参数文件都没了，认不出来是谁，算了
    }

    let startedAt = Date.now();
    try { startedAt = fs.statSync(specFile).mtimeMs; } catch (_) { /* 用当前时间凑合 */ }

    const rec = this._makeRecord(spec, { startedAt, pid: payload.pid || null });
    this.items.set(id, rec);
    this.log('[term] 认回一个重启前就开着的终端 ' + id + '（' + rec.name + '）');
    this.emit('change');
    return rec;
  }

  // 扫一眼上次留下的编号，接着往下发。不这么干的话，桌宠重启后新开的终端
  // 会从 w1 重新开始，跟重启前还开着的那个 w1 撞号，两条会串成一条。
  _initSeq() {
    try {
      for (const f of fs.readdirSync(this.specDir)) {
        const m = /^w(\d+)\.json$/.exec(f);
        if (m) this.seq = Math.max(this.seq, Number(m[1]));
      }
    } catch (_) {
      /* 目录还是空的，很正常 */
    }
  }

  _launch(spec) {
    const env = { ...process.env };
    if (this.node.asNode) env.ELECTRON_RUN_AS_NODE = '1';

    const launcher = this._writeLauncher(spec);
    const pref = (this.getConfig().terminal || {}).app || 'auto';

    // 后台派活也走 wt —— 两种派法开出来的窗口得长一个样，不然很别扭。
    //
    // wt.exe **没有**「最小化启动」这个开关（`wt --help` 里只有 -M/--maximized、
    // -F/--fullscreen、-f/--focus、--pos、--size、-w），而 `start /MIN` 也管不到它：
    // wt.exe 只是个转发器，真窗口由 WindowsTerminal.exe 建，不归 start 的
    // ShowWindow 参数管。
    //
    // 所以只能开出来再让 focus-window.ps1 把它收起来，**露脸那一下躲不掉**。
    // 实测约 250 毫秒，一眨眼。
    //
    // 试过想躲掉：`--pos 30000,30000` 开到屏幕外。**不行** —— wt 会把坐标
    // 夹回桌面范围内（两块 1920 的屏，30000 被夹成 1912，照样全露着）。
    //
    // 也试过反过来「先起监视器再开窗口」（想让 PS 的 Add-Type 编译跟 wt 启动
    // 并行），结果更糟：露脸 5.2 秒 —— 监视器起太早会抓到中间态窗口，收错对象。
    const useWt = this.wt && pref !== 'conhost';

    if (useWt) {
      // Windows Terminal：给每个任务一个具名窗口，之后就能靠这个名字把它捞回前台
      const args = [
        '-w', spec.windowName,
        'new-tab', '--title', spec.title, '-d', spec.dir, launcher,
      ];

      const child = spawn(this.wt, args, { cwd: spec.dir, env, detached: true, windowsHide: false });
      child.unref();
      // wt.exe 本身只是个转发器，转发完就退了；它起不来的情况要单独接
      child.on('error', (err) => {
        this.log('[term] wt 起不来（' + err.message + '），回落到老式控制台');
        this._launchConhost(spec, env, launcher);
      });

      // **必须开完窗口再起监视器。** 试过反过来（想让 PS 的 Add-Type 编译
      // 跟 wt 启动并行），实测反而糟得多：露脸 5253 毫秒 vs 179 毫秒 ——
      // 监视器起太早会抓到一个中间态的窗口，收错了对象，真窗口就一直露着
      if (spec.minimized) this._minimizeLater(spec);

      return;
    }

    this._launchConhost(spec, env, launcher);
  }

  /**
   * 把刚开出来的那个 wt 窗口收起来。
   *
   * 窗口是**异步**建的（wt.exe 转发完就退了，真窗口由 WindowsTerminal.exe 建），
   * 所以不能开完立刻找 —— PS 那边会轮询等它出现，最多等 WINDOW_WAIT_MS。
   *
   * 收不起来也不算事故：窗口在屏幕外，你本来就看不见它，
   * 点「看看她在干嘛」照样能把它挪回来。所以这儿只记一行日志，不打扰你。
   */
  _minimizeLater(spec) {
    run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', FOCUS_PS1, '-Title', spec.title, '-Minimize',
      '-WaitMs', String(WINDOW_WAIT_MS),
    ], WINDOW_WAIT_MS + 4000)
      .then((out) => this.log('[term] ' + spec.id + ' 收起来了: ' + String(out).trim()))
      .catch((err) => this.log('[term] ' + spec.id + ' 没收起来（' + err.message +
                               '），它在屏幕外，不影响你干活'));
  }

  _launchConhost(spec, env, launcher) {
    // conhost 的窗口没有 wt 那套「具名窗口」——windowName 留着的话，之后
    // focus() 会去跑 `wt -w waifu-xx focus-tab`，而 wt 对不存在的名字
    // **不报错，直接新建一个那个名字的空终端窗口**：每点一次「看现场」
    // 就凭空多一个命令行窗口（实机撞过）。清掉，聚焦走按标题那条路
    spec.windowName = null;
    const rec = this.items.get(spec.id);
    if (rec) {
      rec.windowName = null;
      try { this._patchSpec(rec, { windowName: null }); } catch (_) { /* 落不上盘影响的只是重启后 */ }
    }

    // start 的第一个带引号参数会被当成窗口标题，所以必须显式给一个，
    // 否则它会把后面的路径误当标题，命令直接跑飞。
    // /MIN 要放在标题**前面** —— 它是 start 自己的开关，跑到标题后面就成了
    // 传给被启动程序的参数
    const args = spec.minimized
      ? ['/c', 'start', '/MIN', spec.title, launcher]
      : ['/c', 'start', spec.title, launcher];
    const child = spawn('cmd.exe', args, { cwd: spec.dir, env, detached: true, windowsHide: false });
    child.unref();
  }

  // --- term-shell 上报 ------------------------------------------------------

  onShellEvent(payload) {
    const id = payload && payload.termId;
    if (!id) return;

    let rec = this.items.get(id);
    // 内存里没这条，但那边还在报到 —— 多半是桌宠重启过，把它认回来
    if (!rec && (payload.phase === 'open' || payload.phase === 'beat')) {
      rec = this._adopt(id, payload);
    }
    if (!rec) return;

    rec.lastSeen = Date.now();
    if (payload.pid) rec.pid = payload.pid;

    switch (payload.phase) {
      case 'open':
        this.emit('change');
        break;

      case 'beat':
        rec.lastBeat = Date.now(); // _sweep 的「心跳断了」兜底靠它
        break;

      case 'gone':
        // 窗口没了 —— term-shell 死前亲口说的，比 pid 探测可靠：
        // Windows 的 pid 会回收复用，探测可能一直误报「还活着」
        this._windowGone(rec, '亲口报的');
        break;

      case 'close':
        if (rec.status === 'closed') break; // gone 先到过了，窗口都没了别再翻成 done
        // codex 退出前最后扫一眼档案 —— 收尾那轮的 task_complete 可能刚落盘，
        // 等下一个 3 秒节拍就晚了（status 马上翻 done，汇报还是要给的）。
        // 认领也补一次：档案可能到最后才出生（空任务终端聊得晚）
        if (rec.agent === 'codex') {
          try {
            this._codexPeek(rec, Date.now());
            this._codexWatch(rec);
          } catch (_) { /* 汇报丢了也不拦收尾 */ }
        }
        // 注意：这是 **claude 干完退出了**，不是窗口关了 ——
        // term-shell 还停在「按回车关掉」那一步等你看结果。
        // 所以这条继续留在列表里（灰的），你还能点它把窗口调到前面。
        // 真正从列表消失的时机是窗口被关掉，那由 _sweep 的 pid 探测负责。
        rec.status = 'done';
        rec.closedAt = Date.now();
        rec.exitCode = payload.code;
        this._patchSpec(rec, { exitCode: payload.code }); // 重启后红行不蒸发
        this.log('[term] ' + rec.id + ' 那边的活结束了 code=' + payload.code + '（窗口还开着）');
        // CLI 压根没起来（spawn 失败）：原因只在那个马上要被关掉的窗口里，
        // 不喊一声的话面板上只剩一条 code=-1 的灰线，你对着它发呆
        if (payload.error) {
          this.emit('attention', {
            id: rec.id, name: rec.name, kind: 'boot',
            text: '「' + rec.name + '」的 ' + (rec.agent === 'codex' ? 'Codex' : 'Claude') + ' 没起来。',
            detail: String(payload.error).slice(0, 120),
          });
        }
        this._finish(rec, payload.code);
        this.emit('change');
        // 响应体给 term-shell 带一行总账，印在「按回车关掉」上面 ——
        // 关窗前最后一眼正是最想看总账的时刻
        {
          const parts = [];
          if (rec.costUsd > 0.004) parts.push('烧了 $' + rec.costUsd.toFixed(2));
          if (rec.turns) parts.push(rec.turns + ' 轮');
          const nf = (rec.filesAll || new Map()).size;
          if (nf) parts.push('动了 ' + nf + ' 个文件');
          if (parts.length) return { line: '这一窗：' + parts.join(' · ') };
        }
        break;

      default:
        break;
    }
  }

  // --- claude hook 事件 -----------------------------------------------------

  /**
   * 返回 true 表示这条 hook 事件被认领了（是我们开的终端干的活）。
   * 认不出来的就不是我们的事 —— 那是你自己另开的窗口，不该算到她头上。
   */
  onHookEvent(ev) {
    const id = ev && (ev.waifuTermId || ev.termId);
    const rec = id ? this.items.get(id) : null;
    if (!rec) return false;

    rec.lastSeen = Date.now();
    rec.lastHookAt = Date.now(); // hook 来了 = 真有动静，「卡住」计时清零
    // 她在这个窗口里换会话了（用户敲了 /resume 挑另一条、或者 /clear）——
    // 认下真身，不然「接着聊」和算钱都还盯着一个从没落盘的空 id
    if (ev.session_id && ev.session_id !== rec.sessionId) this._rebindSession(rec, ev.session_id);
    const name = ev.waifuEvent || ev.hook_event_name;

    switch (name) {
      case 'UserPromptSubmit':
        rec.turns += 1;
        rec.status = 'running';
        rec.toolCount = 0;
        rec.errorCount = 0;
        rec.lastError = null; // 上一轮跟什么较劲，这一轮重新算
        rec.files = new Set();
        // 「一轮」的边界就在这儿，护栏的计数跟着一起清 —— 别自己另造一个边界
        rec.rewrites = 0;
        rec.warned = new Set();
        // 这一轮你让她干的是什么。汇报的时候带上，你才知道她在说哪件事。
        rec.lastPrompt = String(ev.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        this._timeline(rec, 'you', rec.lastPrompt);
        this.emit('change');
        break;

      case 'PreToolUse':
        rec.status = 'running';
        // **动手之前**扫一眼她要干的事对不对。放这儿而不是 PostToolUse，
        // 是因为等做完了再喊，文件已经被改了
        this._guard(rec, ev);
        break;

      case 'PostToolUse': {
        rec.toolCount += 1;
        const resp = ev.tool_response;
        if (resp && (resp.is_error || resp.error)) {
          rec.errorCount += 1;
          // 报错首行留下来 —— 「一直在跟 ESLint 的 no-unused-vars 较劲」比
          // 「报了 3 次错」可决策得多。tool_response 的形状不统一（字符串 /
          // {error} / {content:[{text}]}），全都摸一遍，摸不出来就算了
          let raw = '';
          if (typeof resp === 'string') raw = resp;
          else raw = String(resp.error
            || (Array.isArray(resp.content) ? (resp.content[0] && resp.content[0].text) : resp.content)
            || '');
          const first = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
          if (first) { rec.lastError = first; this._timeline(rec, 'error', first); }
        }

        // 记一下她动了哪些文件 —— 「改了这三个文件」比「动了 8 次工具」有用得多。
        // 走 filePathOf 而不是直接读 file_path：NotebookEdit 用的是 notebook_path，
        // 原来那样写笔记本文件永远记不进来
        if (WRITE_TOOLS.test(String(ev.tool_name || ''))) {
          const fp = filePathOf(ev.tool_name, ev.tool_input);
          if (fp) {
            if (!rec.files) rec.files = new Set();
            rec.files.add(path.basename(String(fp)));
            // 全程那份留全路径：面板上要能点开它，光有文件名点不了。
            // 顺便记次数 —— 改了七遍的那个文件通常就是这轮的主角。
            //
            // **只记项目目录里的。** 她干活时顺手写的临时脚本在
            // C:\WINDOWS\TEMP\claude 底下，读的全局配置在 ~\.claude 底下 ——
            // 那些全是 C 盘路径，跟「她在这个项目里改了什么」一点关系没有，
            // 列出来只会把真正改过的文件挤下去。
            const abs = path.resolve(String(fp));
            if (isInside(abs, rec.dir)) {
              if (!rec.filesAll) rec.filesAll = new Map();
              rec.filesAll.set(abs, (rec.filesAll.get(abs) || 0) + 1);
            }
          }
        }
        this.emit('change');
        break;
      }

      /**
       * codex 停下来问你了。
       *
       * 【为什么单开一个分支，而不是复用上面那条 Notification。】
       * 那条是 claude 的 hook 名，codex 发的是我们自己在命令行上挂的
       * `CodexAttention`（见 agents.js 的 codexWatchArgs）。两边载荷的字段名
       * 也对不上 —— codex 给的是它自己那套 permissionRequest 的 JSON。
       * 而下游（她转过来看着你、气泡、语音、点她直接调出终端）是**同一套**，
       * 所以这儿只负责把契约拼齐：status 置 waiting + 一句能直接念的中文。
       *
       * 原来 codex 线上这块是全瞎的：全项目只有上面那处给 rec.status 赋过
       * 'waiting'，于是 codex 窗口卡在确认框上时，面板还写着「干着呢」。
       */
      case 'CodexAttention': {
        rec.status = 'waiting';
        this.emit('change');
        this.emit('attention', {
          id: rec.id, name: rec.name, kind: 'confirm',
          text: '「' + rec.name + '」那边在等你确认。',
        });
        break;
      }

      case 'Notification': {
        const msg = String(ev.message || '');
        // 「waiting for your input」是空闲提醒 —— 你晾着它一分钟它就发一次，
        // 那不叫卡住。真正该喊你的是权限确认这类走不下去的情况。
        if (/waiting for your input/i.test(msg)) break;

        rec.status = 'waiting';
        this.emit('change');
        // text 在这一层就拼成能直接念的中文成句 —— 这样 attention 只有一种契约，
        // main.js 那边拿到什么就念什么，不用自己判断是哪种情况再拼一遍。
        // detail 是**给眼睛的补充**（气泡带上、语音不念）：hook 消息里写着她
        // 具体要确认什么，带出来你不用起身就能判断值不值得走过去
        rec.waitDetail = msg.replace(/\s+/g, ' ').trim().slice(0, 120);
        this._timeline(rec, 'wait', '在等你确认：' + rec.waitDetail);
        this.emit('attention', {
          id: rec.id, name: rec.name, kind: 'confirm',
          text: '「' + rec.name + '」那边在等你确认。',
          detail: rec.waitDetail,
        });
        break;
      }

      // 上下文满了在压缩 —— 这正是「她开始忘事、账单开始飙」的信号点，
      // 也是收尾开新线的最佳时机。原来这个时刻完全静默
      case 'PreCompact':
        rec.compactions = (rec.compactions || 0) + 1;
        this.emit('attention', {
          id: rec.id, name: rec.name, kind: 'compact',
          text: '「' + rec.name + '」那条线上下文满了，正在压缩 —— 长会话开始忘事了，考虑收尾开条新线。',
        });
        this.emit('change');
        break;

      case 'Stop':
        rec.status = 'idle';
        // 一轮完事了，记一笔流水。
        //
        // **别拿下面那条 report 当账本**：它被 minGapSec（默认 20 秒）节流时
        // 直接 return，supervise 关掉更是一条都不发 —— 连着干完好几轮会大量漏记。
        // Stop 每轮必到，这才是能数的那个。
        //
        // tools/errors 是**这一轮**的量（UserPromptSubmit 里清了零），
        // 所以流水那边直接累加就是全天量，不用取最大值。
        this.emit('turn', {
          id: rec.id,
          project: rec.project,
          laneName: rec.laneName,
          turns: rec.turns,
          tools: rec.toolCount,
          errors: rec.errorCount,
        });
        this._report(rec, ev);
        this.emit('change');
        break;

      case 'SessionEnd': {
        if (rec.status === 'closed') break; // 同上，别把已关的翻活

        /**
         * 【`/clear` 和 `/resume` 也发 SessionEnd —— 那不是活干完了。】
         *
         * claude 的 reason 枚举一共五个（从 claude.exe 里挖出来的原文：
         * `["clear","resume","logout","prompt_input_exit","other"]`），
         * 前两个是**她在这个窗口里换了条会话接着聊**，人还在、窗口还在。
         *
         * 原来无条件翻 done，后果有三层，而且都是哑的：
         *   · 她当场以为活干完了 —— 走一遍心情结算，白得意/白低落一次
         *   · `rec.finished` 就此立起来**再也不复位** → 这个窗口**真正**干完
         *     那一次永远不汇报了（正好把「干完了她是个哑巴」那个修好的东西打回去）
         *   · `livesFor()` 跳过 done → 两道「别开第二个窗口」的闸对它全瞎
         *
         * 而 CLAUDE.md 和玩法说明里**推荐**的正是「想接着上次聊就敲 /resume」。
         */
        if (ev.reason === 'clear' || ev.reason === 'resume') {
          rec.status = 'idle';
          this.log('[term] ' + rec.id + ' 换了条会话接着聊（' + ev.reason + '），人还在');
          this.emit('change');
          break;
        }

        rec.status = 'done';
        rec.closedAt = Date.now();
        this._finish(rec, null);
        this.emit('change');
        break;
      }

      default:
        break;
    }
    return true;
  }

  /**
   * 一个阶段做完了，把成果告诉你。
   *
   * 成果直接从 Stop 事件的 last_assistant_message 拿 —— 那就是她这一轮
   * 最后说的话，现成的。
   *
   * 曾经绕过一大圈去读 transcript 文件，那是死路：交互式会话的 transcript
   * **要等整个会话结束才落盘**，Stop 的时候文件根本不存在，等四十秒也等不来。
   * 中间还试过「退而求其次读目录里最近改过的那个文件」，后果更难看 ——
   * 那个目录里躺着用户自己正在用的会话，于是她张嘴汇报的是别人说的话。
   * 读文件那套只留作兜底，正路就是这个字段。
   */
  /**
   * 往这条线的时间线上记一笔。手机详情页要的「进度流」就是它。
   *
   * 同一句话连着来两遍不记（Stop 有时连发、汇报和轮末会撞）。
   * 只留最近 TIMELINE_KEEP 条：内存里存着，不落盘 —— 长会话几百轮
   * 全存下来占内存，而手机上你也只看最近发生了什么
   */
  _timeline(rec, kind, text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!t) return;
    if (!rec.timeline) rec.timeline = [];
    const last = rec.timeline[rec.timeline.length - 1];
    if (last && last.kind === kind && last.text === t) return;
    rec.timeline.push({ at: Date.now(), kind, text: t });
    if (rec.timeline.length > TIMELINE_KEEP) rec.timeline.splice(0, rec.timeline.length - TIMELINE_KEEP);
  }

  _report(rec, ev) {
    const cfg = this.getConfig().supervise || {};

    // 【「别汇报了」和「别记账了」是两件事。】
    //
    // 原来这儿是 `if (cfg.enabled === false) return;` —— 于是关掉「开启监督」
    // 的人，流水里的 report 和项目小抄整条链都是死的，而且一点提示都没有。
    // 他关的是「她别每做完一段就过来说话」，不是「别记我干过什么」。
    //
    // 所以改成照常发事件、只是标上 quiet，让上层决定说不说。
    // 下面那两道（同一段话不报第二遍、20 秒内不碎碎念）同理，都只管嘴。
    const silent = cfg.enabled === false;

    let text = String(ev.last_assistant_message || '').trim();

    // 兜底一：万一哪个版本没给这个字段，再去试试文件（多半读不到，但不亏）
    if (!text) {
      const file = resolveTranscript(ev, rec.sessionId);
      if (file) text = readLastAssistantText(file) || '';
    }

    // 兜底二：话是拿不到了，但「干了些什么」还在手里，报个概要总比一声不吭强
    if (!text) {
      if (!rec.toolCount) return; // 什么都没干过，那确实没什么可说的
      text = '动了 ' + rec.toolCount + ' 次工具' +
             (rec.errorCount ? '，其中 ' + rec.errorCount + ' 次报错' : '，一路顺利') + '。';
    }

    // 同一段话**真的**别报第二遍 —— Stop 有时会连着来好几次，
    // 这一条连记账一起挡掉（同一句话记两遍纯属脏数据）
    if (text === rec.lastReport) return;

    // 连着结束好几轮时（subagent、快速往返）别让她碎碎念。
    // 这一条只管嘴：那一轮照样要记进流水和小抄
    const gap = (cfg.minGapSec || 20) * 1000;
    const tooSoon = Boolean(rec.lastReportAt && Date.now() - rec.lastReportAt < gap);

    rec.lastReport = text;
    this._timeline(rec, 'her', text);
    if (!tooSoon) rec.lastReportAt = Date.now();

    this.emit('report', {
      // 「这次别开口」。上层照常记账，只是不弹气泡不出声
      quiet: silent || tooSoon,
      id: rec.id,
      name: rec.name,
      // name 是「项目 · 线名」拼好的 label，想按项目聚合还得去拆那个 ' · '
      // —— 线名里真出现这个符号就拆错了。两个原始字段一起发出去最省事。
      project: rec.project,
      laneName: rec.laneName,
      dir: rec.dir,
      text,
      task: rec.lastPrompt || rec.task, // 这一轮你让她干的是什么
      files: Array.from(rec.files || []).slice(0, 8),
      toolCount: rec.toolCount,
      errorCount: rec.errorCount,
      speak: cfg.speak !== false,
    });

    // 一轮干完，把这轮烧的钱记进流水账。
    // **跟上面那个 quiet 无关** —— 「别汇报了」管的是她的嘴，不是记账
    this._settleCost(rec);
  }

  /**
   * 她要动手了，看一眼对不对。命中就喊你。
   *
   * 「喊」= 转过来正对着你 + 冒一个可点的气泡 + 念一句。点那个气泡直接跳到
   * 这个终端窗口，你自己按 Ctrl+C 决定要不要停 —— **我们只喊，不拦**（见上面那段）。
   *
   * 同一轮里同一类只喊一次：她连删二十个文件，不该响二十声。
   */
  _guard(rec, ev) {
    const cfg = this.getConfig().supervise || {};
    if (cfg.enabled === false || cfg.guard === false) return;

    const name = String(ev.tool_name || '');
    let hit = checkDanger({ toolName: name, toolInput: ev.tool_input, dir: rec.dir });

    // 整份重写：只有 Write 到一个**已经存在**的文件才算。
    // 一次 existsSync 就是这条路上允许的全部 I/O 了。
    if (!hit && name === 'Write') {
      const fp = filePathOf(name, ev.tool_input);
      let existed = false;
      try { existed = Boolean(fp) && fs.existsSync(fp); } catch (_) { /* 判不了就算了 */ }
      if (existed) {
        rec.rewrites = (rec.rewrites || 0) + 1;
        if (rec.rewrites >= REWRITE_MAX) {
          hit = { kind: 'rewrite', why: '这一轮已经整份重写了 ' + rec.rewrites + ' 个文件了' };
        }
      }
    }

    if (!hit) return;
    if (!rec.warned) rec.warned = new Set();
    if (rec.warned.has(hit.kind)) return;
    rec.warned.add(hit.kind);

    // 留个底：气泡几秒就没了，你回来晚了也该能在面板上看到她曾为什么喊你。
    // 落盘 —— 重启认回这条线，留底还在
    rec.lastAlarm = { kind: hit.kind, why: hit.why, at: Date.now() };
    this._patchSpec(rec, { lastAlarm: rec.lastAlarm });
    rec.alarmUntil = Date.now() + ALARM_MS;
    // 立刻转身，别等下一次三秒一拍的 _sweep —— 这条消息的价值全在「立刻」
    this._pulse();

    const text = '「' + rec.name + '」' + hit.why + '，你看一眼。';
    this.log('[term] ' + rec.id + ' 喊你: ' + hit.kind + ' — ' + hit.why);
    this.emit('attention', { id: rec.id, name: rec.name, kind: hit.kind, text });
  }

  // --- 查看 / 操作 ----------------------------------------------------------

  /**
   * 把这条线烧的钱刷新一下。
   *
   * 读的是 Claude Code 自己的会话记录（cost.js 里有完整来龙去脉）。
   * 每次只读文件新长出来的那一段，所以放在 list() 这种每 3 秒被问一次的
   * 路径上也不心疼。
   *
   * 记账和显示分开：`costUsd` 是当前累计（面板显示），`costPaid` 是已经写进
   * 流水账的部分。差额攒到一轮结束时再报一次，免得流水账被三秒一条的碎账淹了。
   */
  _refreshCost(rec, force) {
    if (!rec || !rec.sessionId) return;
    /**
     * 【关掉的线不再刷新（force 是结算那一次）。】
     * 这条原来只写在下面 codex 分支里，claude 线是漏的 —— 而 list() 每 3 秒
     * 对**每一条** rec 都刷一遍：你点了「接着聊」之后，已经变暗的老线会跟着
     * 新窗口 1:1 同步涨钱（同一份 jsonl，两条 rec 各读各的 total）。
     * 流水账逃过一劫（closed 收不到 hook，不会二次结算），但面板上同一笔钱
     * 明晃晃摆了两遍。
     */
    if (rec.status === 'closed' && !force) return;
    /**
     * 账被冻住了：别的线跟到了这条会话上，往后的钱归**那条**算
     * （见 _rebindSession）。force 也不解冻 —— 关窗结算那一次要的是
     * 「把冻住之前欠的记完」，不是把别人花的钱补记到它头上。
     */
    if (rec.costFrozen) return;
    // codex 的钱不在 ~/.claude/projects，在它自己的 rollout 里 ——
    // 认领到文件才算得出（没认领到就保持 0，面板显示小牌，宁可空着不编数）。
    // token_count 是累计值，整读一遍取最后一条就是全部，天然不怕重复计
    if (rec.agent && rec.agent !== 'claude') {
      if (rec.agent === 'codex' && rec.codexFile) {
        try {
          // 文件没长就别重读（面板 3 秒问一次，别每次都嚼几百 KB）
          const mt = fs.statSync(rec.codexFile).mtimeMs;
          if (mt === rec.codexReadAt && !force) return;
          const u = agents.codexUsage(rec.codexFile, rec.codexBase);
          // 读失败（杀毒/备份短暂锁文件）返回 null：**停在上次的数**，
          // 别把算好的抹成 0 —— 那可能是关窗结算前的最后一次机会
          if (u) {
            rec.codexReadAt = mt;
            rec.codexTok = u.totals || null; // 命中率仪表用（cached_input / input）
            rec.costUsd = u.usd;
          }
        } catch (_) { /* 文件被清了就停在上次的数 */ }
      }
      return;
    }
    try {
      // carry = 换会话之前那条线已经花掉的；base = 新会话在我们接手前就有的历史
      // （用户 /resume 到一条聊了半天的老会话，那些钱不是这个窗口花的）。
      // 没换过会话的线两个都是 0，跟以前一模一样
      // 只涨不跌：会话文件被清空/换掉时 cost.js 会把累计重置成 0，
      // 减基线就成了负数（面板上蹦出个负金额）。钱是只增不减的东西，
      // 卡在已经算出来的那个数上
      // ponytail: 卡地板，代价是文件被换掉后新会话的钱要涨过旧基线才看得见
      const u = cost.ofSession(rec.sessionId);
      rec.costUsd = Math.max(rec.costUsd || 0, (rec.costCarry || 0) +
                    u.total - (rec.costBase || 0));
      // 明细描述的是**这份档案整体**（含接手前的历史）——算命中率和「大头是谁」
      // 足够；别为窗口级精确再养一套四桶账
      // 拷一份 —— u.parts 那仨是 cost.js 内部累加器的**活引用**，直接存的话
      // closed 老线的悬停明细会跟着接手的新线继续涨（评审抓的）
      rec.costParts = u.parts ? { ...u.parts } : null;
      rec.costTokens = u.tokens ? { ...u.tokens } : null;
      rec.costModels = u.byModel ? { ...u.byModel } : null;
    } catch (_) { /* 读不到就当没有，绝不能因为算钱把列表搞挂 */ }
  }

  /**
   * 往这个窗口的 spec 文件上打个补丁（读-改-写）。
   *
   * spec 是**重启之后唯一的记忆**：桌宠重启时 `_adopt` 从它把窗口认回来，
   * 没落进去的字段一律归零。原来这套读-改-写在文件里抄了三遍，
   * 而 claude 线的 costPaid **一遍都没抄到** —— 见 _settleCost。
   */
  _patchSpec(rec, patch) {
    try {
      const f = path.join(this.specDir, rec.id + '.json');
      const spec = JSON.parse(fs.readFileSync(f, 'utf8'));
      Object.assign(spec, patch);
      fs.writeFileSync(f, JSON.stringify(spec, null, 2), 'utf8');
    } catch (_) { /* 写不回只是重启后接不上，绝不能因此拦住正事 */ }
  }

  /**
   * 这个窗口实际在用的会话换了 —— 把绑定挪过去。
   *
   * 【为什么必须有这一步。】开窗口时我们 `--session-id <自己发的>` 指一条新的，
   * 但用户在窗口里敲 `/resume` 挑另一条（CLAUDE.md 里推荐的做法就是这个）、
   * 或者 `/clear` 一下，claude 从此写的就是**别的会话文件**了。我们记的那个 id
   * 一个字都没落盘 → 面板上这条线的钱恒为 0、点「接着聊」开出来的是条空会话，
   * 昨天聊了一整天的事她全不记得。翻过本机 registry：46 条线里 22 条的
   * jsonl 根本不存在，全是这个原因。
   *
   * 钱要从换的那一刻起算：老会话文件里已有的历史不是这个窗口花的
   * （用户可能 resume 到一条几十美元的长会话上），所以记一道基线，
   * 换之前这条线花掉的则留在 carry 里。
   */
  _rebindSession(rec, sid) {
    if (rec.agent && rec.agent !== 'claude') return; // codex 有它自己那套认领
    let base = 0;
    try { base = cost.ofSession(sid).total; } catch (_) { /* 读不到就从 0 起 */ }

    /**
     * 【这条会话已经有别的线在记账了 → 把那条冻住，别让同一笔钱记两遍。】
     *
     * 场景是真的会发生：A、B 两个窗口都开着，你在 A 里 `/resume` 挑了 B 那条
     * 会话。两条 rec 从此读**同一份 jsonl 的同一个 total**，面板上各涨各的，
     * 各自结算时又都往流水里记一笔 —— 撞 CLAUDE.md「增量读不许重复计钱」。
     *
     * 处理方式是**跟过去、但只留一个记账的**：老那条的账停在此刻
     * （carry 收住、base 顶到当前 total，于是它的 costUsd 从此是个常数），
     * 新的照常跟。**不能反过来「发现冲突就不跟」** —— 不跟等于这条线的
     * sessionId 永远停在一个从没落盘的空 id 上，「接着聊」又变回开空会话，
     * 那正是这套东西当初要治的病。
     *
     * 顺带说清一件这道闸**防不住**的事：那两个 claude 进程此刻已经在抢同一份
     * jsonl 了（记忆会被交错写坏），那是在 CLI 里发生的，我们只是个记账的。
     * 所以这儿要吭一声，让日志里留得下痕迹。
     */
    for (const other of this.items.values()) {
      if (other === rec || other.status === 'closed') continue;
      if (other.sessionId !== sid) continue;
      other.costFrozen = true;
      this._patchSpec(other, { costFrozen: true });
      this.log('[term] ' + other.id + ' 也绑着会话 ' + sid.slice(0, 8) +
               '，账冻在这儿；两个窗口同写一条会话，记忆可能被写乱');
    }

    rec.costCarry = rec.costUsd || 0;
    rec.costBase = base;
    rec.sessionId = sid;
    // 它自己换到了另一条会话 —— 就算之前因为「被别的窗跟上」冻过账，
    // 新会话的钱是它自己的，解冻（冻结有进无出的话，这条线从此钱永久蒸发，
    // 评审抓的）
    rec.costFrozen = false;

    // 回写 spec：桌宠重启 _adopt 认回这个窗口时，钱和线才接得上
    this._patchSpec(rec, { sessionId: sid, costCarry: rec.costCarry, costBase: base, costFrozen: false });

    this.emit('claude-session', { dir: rec.dir, laneId: rec.laneId, sessionId: sid });
    this.log('[term] ' + rec.id + ' 跟到了会话 ' + sid.slice(0, 8) + '…（窗口里换过）');
  }

  /**
   * 认领 codex 的会话文件（**窗口活着就一直配**，跟着 _sweep 的 3 秒节拍试）。
   *
   * 认领到手三件事都齐了：算钱（rollout 里的 token_count）、「接着聊」
   * （codex resume <uuid>）、重启后找回（回写进 spec 文件给 _adopt）。
   * 已被**别的线**认领的 id 不抢 —— 同目录并行开两条也各认各的；
   * 自己上次那条（resume 时 spec 带来的）不算抢，认到新文件就换新的
   * （codex 的 resume 可能另起一份文件，钱和下次接着聊都得跟着新的走）。
   *
   * 开窗 90 秒之后的「晚认领」多一道新鲜度闸（只认 10 秒内还在写的档案）——
   * 不设的话，已出列死线的旧档案会被捡走：汇报重播 + 钱二次入账（评审抓的）。
   *
   * 【文档化的残余风险，文件系统层面分不出来的】同目录**两条以上**空任务
   * codex 窗一起挂着时，谁的档案先落盘、先手的那扇窗就认走 —— 后开的窗
   * 敲的第一句可能被先开的窗认走（认领时这儿会大声记一笔日志）。
   * 用户自己在同目录手开 codex 同理。开一扇空窗聊完再开下一扇就没这事。
   */
  _codexPeek(rec, now) {
    if (rec.agent !== 'codex' || rec.codexClaimed) return;
    // 窗口活着就一直配，**没有截止时间**。原来是「开窗后 90 秒」—— 实机死过
    // （w63，2026-08-21）：不带任务的终端，codex 要等用户敲**第一句话**才把
    // rollout 落盘 —— 文件名时间戳是会话创建（14:38:13），文件真正出生在
    // 14:39:36，90 秒窗到 14:39:37 截止，差一秒错过之后永远不看了。带任务
    // 派活是秒落盘的，所以自测全过、这条最常见的用法反而一直是死的。
    // 时间闸还在（born >= startedAt - 5s）：认的必须是这扇窗开了**之后**出生
    // 的档案。残余风险照旧文档化：窗口一直没人用、用户又在同目录自己开了个
    // codex，可能认错 —— 比整条线死了强。
    if (rec.status === 'done') return; // codex 已经退了还没认到 = 它压根没落过盘

    // 接着聊的窗口只认自己那条会话（resume 另起新文件时 id 不变）——
    // 不设这道闸，它会把同目录新开线刚落盘的会话抢走（评审抓的）
    const expectId = rec.codexSessionId || undefined;

    const claimed = new Set();
    for (const r of this.items.values()) {
      if (r !== rec && r.codexSessionId) claimed.add(r.codexSessionId);
    }

    // 同目录还有比我早开、也在等着认领的新线 → 让它先认。
    // 配对按开窗顺序来（最早的文件配最早的窗口），别让后开的抢在前面
    if (!expectId) {
      const myDir = path.resolve(rec.dir).toLowerCase();
      for (const r of this.items.values()) {
        if (r !== rec && r.agent === 'codex' && !r.codexClaimed && !r.codexSessionId &&
            r.status !== 'closed' && r.startedAt < rec.startedAt &&
            now - r.startedAt <= 90000 &&
            path.resolve(r.dir).toLowerCase() === myDir) return;
      }
    }

    let hit = null;
    try {
      hit = agents.findCodexSession({
        dir: rec.dir, sinceMs: rec.startedAt, claimed, expectId,
        // 开窗 90 秒后的晚认领只认「10 秒内还在写」的档案（防出列死线被捡走）
        freshWithinMs: now - rec.startedAt > 90000 ? 10000 : undefined,
      });
    } catch (_) { return; }
    if (!hit) return;

    // 同目录还有别的没认领的活窗：这次认领可能认的是**它**的会话（文件系统
    // 层面分不出来）。照认（先手赢），但必须大声留痕 —— 真串了线，日志里
    // 查得到是从这儿开始的
    if (!expectId) {
      const myDir2 = path.resolve(rec.dir).toLowerCase();
      for (const r of this.items.values()) {
        if (r !== rec && r.agent === 'codex' && !r.codexClaimed && !r.codexSessionId &&
            r.status !== 'closed' && r.status !== 'done' &&
            path.resolve(r.dir).toLowerCase() === myDir2) {
          this.log('[term] ⚠ ' + rec.id + ' 认领 ' + hit.sessionId.slice(0, 8) +
                   '… 时，同目录还有没认领的 ' + r.id +
                   ' —— 若那句话是在 ' + r.id + ' 的窗里敲的，两条线就串了');
        }
      }
    }

    rec.codexSessionId = hit.sessionId;
    rec.codexFile = hit.file;
    rec.codexBase = null;   // 新落盘的文件，钱从零算起（token_count 是本次运行的）
    rec.codexReadAt = 0;
    // 汇报从哪儿跟起：新认的文件整份都是这一窗的，从 0 —— 认领前就干完的
    // 快轮也不会丢。接着聊（expectId）认到的新文件可能抄了旧对话进去，
    // 从当前末尾跟起，抄进来的历史不重报
    rec.codexOffset = expectId
      ? (() => { try { return fs.statSync(hit.file).size; } catch (_) { return null; } })()
      : 0;
    rec.codexCarry = null;
    rec.codexClaimed = true;

    // 回写 spec：桌宠重启 _adopt 认回这个窗口时，钱才接得上、线才接得回。
    // codexClaimed 也要落 —— 不落的话认回来会重新开抢 90 秒（评审抓的）
    try {
      const specFile = path.join(this.specDir, rec.id + '.json');
      const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
      spec.codexSessionId = hit.sessionId;
      spec.codexFile = hit.file;
      spec.codexClaimed = true;
      spec.codexOffset = rec.codexOffset != null ? rec.codexOffset : undefined;
      delete spec.codexGlanceBase;
      delete spec.codexBase;
      fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');
    } catch (_) { /* 写不回就只是重启后这条线的钱变暗，不拦认领 */ }

    this.emit('codex-session', {
      id: rec.id, dir: rec.dir, laneId: rec.laneId,
      sessionId: hit.sessionId, file: hit.file,
    });
    this.log('[term] ' + rec.id + ' 认领了 codex 会话 ' + hit.sessionId.slice(0, 8) + '…');
  }

  /** 攒下的那点还没记账的钱，报出去写流水 */
  _settleCost(rec) {
    this._refreshCost(rec, true);
    const owed = rec.costUsd - (rec.costPaid || 0);
    if (!(owed > 1e-6)) return;
    rec.costPaid = rec.costUsd;
    /**
     * 【落盘，不然重启一次整条会话的钱再记一遍。】
     * 原来只有 codex 线落（_codexPersist 里那句），claude 线一直是漏的：
     * 终端还开着时重启桌宠 → _adopt 认回来 costPaid 归零、costUsd 又被算成
     * 全额 → 下一次结算 owed = 全额，当天账直接翻倍。而终端里那笔是
     * **几十美元量级**的，翻一倍非常显眼。
     */
    this._patchSpec(rec, { costPaid: rec.costPaid });
    this.emit('cost', {
      id: rec.id, project: rec.project, laneName: rec.laneName, costUsd: owed,
    });
  }

  list() {
    const now = Date.now();
    for (const rec of this.items.values()) this._refreshCost(rec);
    return Array.from(this.items.values())
      // 还在干的排前面，已完成的沉底。不排的话新派的活会被一堆历史埋掉
      .sort((a, b) => (Number(a.status === 'closed') - Number(b.status === 'closed')) ||
                      (b.startedAt - a.startedAt))
      .map((t) => ({
        id: t.id,
        name: t.name,
        // 面板要靠这两个把同目录的几条线区分开来显示
        project: t.project || t.name,
        laneName: t.laneName || '',
        laneId: t.laneId || null,
        dir: t.dir,
        task: t.task,
        status: t.status,
        elapsedMs: (t.closedAt || now) - t.startedAt,
        turns: t.turns,
        toolCount: t.toolCount,
        errorCount: t.errorCount,
        lastReport: t.lastReport,
        // 这一轮你实际让她干什么 —— 长会话聊了二十轮后，最初那句 task 早过时了
        lastPrompt: t.lastPrompt || '',
        // done/closed 的线靠它分「干成了」还是「砸了」（非零 = 异常收场）
        exitCode: (t.exitCode === undefined || t.exitCode === null) ? null : t.exitCode,
        // 最近一次报错首行（跟什么较劲）；护栏最近一次为什么喊你（留底，可追溯）
        lastError: t.lastError || '',
        lastAlarm: t.lastAlarm || null,
        // 只在真等着的时候给 —— 老的 waitDetail 是上次的事，别拿去误导
        waitDetail: t.status === 'waiting' ? (t.waitDetail || '') : '',
        // 钱的明细：四桶、命中率、大头模型（悬停在金额上看）
        costParts: t.costParts || null,
        costHit: (() => {
          // claude 侧公式在 cost.cacheHit（分母必须含 cacheWrite，理由见那边）；
          // codex 的 cached 本来就是 input 的子集，cached/input 语义已对齐
          const h = cost.cacheHit(t.costTokens);
          if (h != null) return h;
          if (t.codexTok && t.codexTok.input_tokens > 0) {
            return Math.round((100 * (t.codexTok.cached_input_tokens || 0)) / t.codexTok.input_tokens);
          }
          return null;
        })(),
        costModels: t.costModels
          ? Object.entries(t.costModels).sort((a, b) => b[1] - a[1]).slice(0, 2)
          : null,
        compactions: t.compactions || 0,
        // 黄红灯：跟 _pulse 同一套判据，别在面板另造一份阈值
        struggling: t.status === 'running' && t.errorCount >= STRUGGLE_ERRORS,
        stuckMin: (t.status === 'running' && now - (t.lastHookAt || t.startedAt) > STUCK_MS)
          ? Math.round((now - (t.lastHookAt || t.startedAt)) / 60000) : 0,
        agent: t.agent || 'claude',
        // 面板靠它决定「接着聊」的话术：认领到了、**而且档案还在**才敢说
        // 「能接上」—— 用户清过 ~/.codex 的话，接过去实际是新开一条，
        // 话就不能说满（评审抓的）
        codexSessionId: (t.codexSessionId && t.codexFile && this._codexFileAlive(t))
          ? t.codexSessionId : null,
        costUsd: t.costUsd || 0,
        // 动过的文件，改得最多的排前面。
        // `path` 是全路径（面板要拿它去打开文件），`name` 是**相对项目目录**的
        // 那一段 —— 光一个 basename 分不出 src/config.js 和 dist/config.js
        files: Array.from(t.filesAll || [])
          .sort((a, b) => b[1] - a[1])
          .slice(0, FILES_SHOWN)
          .map(([p, n]) => ({
            path: p,
            name: path.relative(t.dir, p).replace(/\\/g, '/') || path.basename(p),
            hits: n,
          })),
        fileCount: (t.filesAll || new Map()).size,
      }));
  }

  /**
   * 盯 codex 的会话档案：一轮干完（task_complete 落盘）就走跟 claude 一模一样
   * 的汇报路 —— 先 emit('turn')（流水的按轮统计靠它），再 emit('report')
   * （形状字段对字段照抄 _report），main 那头的语音、气泡、小抄、流水、心情
   * **一行都不用改**就全接上了。
   *
   * 【增量读】记住上次读到第几个字节（codexOffset），每拍只解析新长出来的
   * 那段 —— 工具数、报错数、动过的文件量出来的天然就是「这一段」的
   * （claude 每轮 UserPromptSubmit 清零是同一个语义），而且跟文件多大无关。
   * 轮没完先攒在 codexCarry 里，task_complete 一到连攒的一起报。
   *
   * 【进度要落盘】每报完一轮把 codexSeen（偏移/轮数/最后那句）和 costPaid
   * 写回 spec —— 桌宠重启认回来才不会把刚报过的那轮重播一遍、把已入账的钱
   * 再记一遍（评审抓的两条 high 都在这儿）。
   *
   * claude 靠 hook 推、这儿靠 3 秒一拍拉，慢个几秒，别的没差。
   * 护栏（动手**之前**报警）例外 —— 档案是干完才写的，拦不了，那条仍是
   * claude 线独有。
   */
  _codexWatch(rec) {
    if (rec.agent !== 'codex' || !rec.codexFile || rec.status === 'closed') return;
    let size = 0;
    try { size = fs.statSync(rec.codexFile).size; } catch (_) { return; }
    if (rec.codexOffset == null) {
      // 起点一直没定下来（open 时文件读不到）：从现在开始跟，旧的不追
      rec.codexOffset = size;
      return;
    }
    if (size === rec.codexOffset) return; // 没长，不重读

    const g = agents.codexGlance(rec.codexFile, rec.codexOffset);
    if (!g) return; // 读失败（锁文件那类）：偏移不动，下一拍再试
    rec.codexOffset = g.nextOffset;

    // 轮内的动静先攒着（工具是干活时就落盘的，task_complete 要等轮尾）
    const carry = rec.codexCarry || (rec.codexCarry = { toolCount: 0, errors: 0, files: {} });
    carry.toolCount += g.toolCount;
    carry.errors += g.errors;
    for (const [p, n] of Object.entries(g.files || {})) {
      carry.files[p] = (carry.files[p] || 0) + n;
    }
    if (g.lastPrompt) rec.lastPrompt = String(g.lastPrompt).slice(0, 500);
    // codex 在动了（新工具/新轮次落盘）→「在等你确认」翻回「干着呢」。
    // 不翻的话 waiting 卡死到关窗：面板一直喊「等你确认」，她的姿态也被
    // 这条僵尸 waiting 一直占着（waiting 权重最高，别的窗抢不过）——
    // codex 只挂了 PermissionRequest 一个 hook，「批准了」没有事件，
    // 但批准之后必然有工具动静，档案里看得见（评审抓的）
    if (rec.status === 'waiting' && (g.toolCount > 0 || g.turns > 0)) {
      rec.status = 'running';
      this.emit('change');
    }
    // codex 线没有 hook，「卡住」的动静判据靠档案在长
    rec.lastHookAt = Date.now();
    if (g.lastPrompt) this._timeline(rec, 'you', String(g.lastPrompt).slice(0, 300));
    if (!g.turns) return; // 轮还没完

    // ≥1 轮完成：把攒的一起结
    rec.turns += g.turns;
    rec.toolCount = carry.toolCount;   // 「这一段」的量，跟 claude 每轮清零同义
    rec.errorCount = carry.errors;
    const fresh = [];
    for (const [p, n] of Object.entries(carry.files)) {
      const abs = path.isAbsolute(p) ? p : path.join(rec.dir, p);
      fresh.push(path.basename(p));
      if (!rec.filesAll) rec.filesAll = new Map();
      rec.filesAll.set(abs, (rec.filesAll.get(abs) || 0) + n);
    }
    rec.files = new Set(fresh);
    rec.codexCarry = { toolCount: 0, errors: 0, files: {} };

    // 流水的按轮统计（当天干了几轮/动了几次工具/错了几次）靠这个事件 ——
    // 不发的话 codex 线在日/月摘要里永远是 0（评审抓的）
    this.emit('turn', {
      id: rec.id,
      project: rec.project,
      laneName: rec.laneName,
      turns: rec.turns,
      tools: rec.toolCount,
      errors: rec.errorCount,
    });

    // ——汇报，照抄 _report 的规矩：原话拿不到用概要兜底、同一句不报两遍、
    //   20 秒内不碎碎念（只管嘴，账照记）——
    const cfg = this.getConfig().supervise || {};
    const silent = cfg.enabled === false;

    let text = String(g.lastSaid || '').trim();
    if (text && text === rec.lastReport) text = ''; // 这轮没有新话
    if (!text) {
      if (rec.toolCount) {
        text = '动了 ' + rec.toolCount + ' 次工具' +
               (rec.errorCount ? '，其中 ' + rec.errorCount + ' 次报错' : '，一路顺利') + '。';
      } else if (rec.errorCount) {
        text = '这一段报了 ' + rec.errorCount + ' 次错。';
      }
      if (text === rec.lastReport) text = '';
    }

    if (text) {
      const gap = (cfg.minGapSec || 20) * 1000;
      const tooSoon = Boolean(rec.lastReportAt && Date.now() - rec.lastReportAt < gap);
      rec.lastReport = text;
      if (!tooSoon) rec.lastReportAt = Date.now();

      this.emit('report', {
        quiet: silent || tooSoon,
        id: rec.id,
        name: rec.name,
        project: rec.project,
        laneName: rec.laneName,
        dir: rec.dir,
        text,
        task: rec.lastPrompt || rec.task,
        files: Array.from(rec.files || []).slice(0, 8),
        toolCount: rec.toolCount,
        errorCount: rec.errorCount,
        speak: cfg.speak !== false,
      });
    }

    // 一轮干完把这轮的钱记进流水（有没有开口都记，跟 claude 同拍），
    // 然后把进度落盘 —— 顺序要紧：settle 先更新 costPaid，落盘才带得上
    this._settleCost(rec);
    this._codexPersist(rec);
    this.emit('change');
  }

  /**
   * 把 codex 线的盯档进度写回 spec。桌宠重启 _adopt 认回窗口时靠它接着数 ——
   * 不落盘的话：刚报过的那轮重播一遍、已入账的钱再记一遍。
   * 只在轮结束时写（3 秒一拍的中途不写，spec 不至于被刷成碎账）。
   */
  _codexPersist(rec) {
    try {
      const specFile = path.join(this.specDir, rec.id + '.json');
      const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
      spec.codexSeen = {
        offset: rec.codexOffset || 0,
        turns: rec.turns || 0,
        lastReport: rec.lastReport || '',
      };
      spec.costPaid = rec.costPaid || 0;
      fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');
    } catch (_) { /* 写不上就重启后可能重放一轮 —— 不拦正事 */ }
  }

  /** 会话档案还在不在。每 3 秒一次 existsSync 太碎，缓 10 秒 */
  _codexFileAlive(rec) {
    const now = Date.now();
    if (!rec.codexAliveAt || now - rec.codexAliveAt > 10000) {
      rec.codexAliveAt = now;
      try { rec.codexAlive = fs.existsSync(rec.codexFile); } catch (_) { rec.codexAlive = false; }
    }
    return Boolean(rec.codexAlive);
  }

  liveCount() {
    return Array.from(this.items.values())
      .filter((t) => t.status !== 'done' && t.status !== 'closed').length;
  }

  get(id) {
    return this.items.get(id) || null;
  }

  /**
   * 把某个终端窗口捞到最前面。
   *
   * 两条路，先快后稳：
   *   1. Windows Terminal 自己的 `-w <名字> focus-tab` —— 官方支持，最快
   *   2. 不行就上 user32：按窗口标题找，AttachThreadInput 绕过前台锁
   */
  async focus(id) {
    const rec = this.items.get(id);
    if (!rec) return { ok: false, error: '没这个终端' };

    // pid 都探不活了，窗口八成已经没了 —— 这时候还跑 `wt -w <名> focus-tab`，
    // wt 对不存在的名字**不报错，是新建一个空终端窗口**，你点一次多一个。
    // pid 有被顶号误报「活着」的可能，那只是让这道闸偶尔放行，
    // 后面按标题那条会兜住「窗口其实没了」的结论
    if (this.wt && rec.windowName && (!rec.pid || pidAlive(rec.pid))) {
      try {
        // 这一步很快（几百毫秒），先让窗口浮上来
        await run(this.wt, ['-w', rec.windowName, 'focus-tab'], 4000);
      } catch (err) {
        this.log('[term] wt focus 没成: ' + err.message);
      }
    }

    // 再用 user32 核一遍。wt 就算窗口早没了也会安静返回 0，只信它会把
    // 「窗口已经被你关了」也报成成功，用户点了没反应还不知道为什么。
    const check = await this._focusByTitle(rec.title).catch(() => null);

    // 【别在这儿删记录。】
    //
    // 上一版这儿写了「按标题找不到 = 窗口没了 = 顺手清掉」，那是错的，而且是
    // **破坏性的错**：Claude Code 跑起来会改控制台标题，标题一变这个查找就落空，
    // 于是你点一下「看看她在干嘛」，**一个还在干活的任务被我当场删了**。
    //
    // 判断窗口死没死只有一个权威依据：`_sweep` 里的 pid 探测（真的系统调用，
    // 问的是那个进程还在不在）。标题找不到有一堆无害的原因 —— 标题被改了、
    // 窗口最小化在别的虚拟桌面、PowerShell 起不来。
    //
    // **一个查找失败的信号，永远不该触发删除。**
    if (check && check.gone) {
      return {
        ok: false,
        error: '按标题没找到那个窗口。它可能改了标题或者在别的桌面上 —— ' +
               '要是真关了，几秒后它会自己从列表里消失',
      };
    }

    if (check) return check;
    return { ok: true }; // 核实不了（PowerShell 都跑不起来），姑且当它成了
  }

  async _focusByTitle(title) {
    try {
      const out = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_PS1, '-Title', title],
        8000
      );
      if (/^OK/m.test(out)) return { ok: true };
      // gone 跟别的失败不是一回事：它是「这条记录已经作废」的确凿证据，
      // 上层拿它去把记录清掉，不然你会对着一个不存在的窗口一直点
      if (/NOTFOUND/.test(out)) return { ok: false, gone: true, error: '那个窗口已经不在了' };
      return { ok: false, error: '系统没让窗口切到前台，你自己点一下任务栏吧' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  _cleanFiles(id) {
    for (const ext of ['.json', '.cmd']) {
      try { fs.unlinkSync(path.join(this.specDir, id + ext)); } catch (_) { /* 本来就没有也无所谓 */ }
    }
  }

  /** 一条线的详情（手机点开看的）：整包状态 + 时间线 */
  detail(id) {
    const rec = this.items.get(id);
    if (!rec) return null;
    const row = this.list().find((t) => t.id === id) || {};
    // 时间线是这轮才开始记的 —— 这之前开的窗口、以及桌宠重启认回来的窗口，
    // 手上一条都没有。**别给用户一张白纸**：拿现有字段兜一份出来
    // （当初派的活、这轮在干什么、最近一次汇报、最近一次报错），
    // 时间用启动时刻兜底，标上「（之前的）」不冒充精确时刻
    let tl = (rec.timeline || []).slice(-40);
    if (!tl.length) {
      const t0 = rec.startedAt || Date.now();
      if (rec.task) tl.push({ at: t0, kind: 'you', text: rec.task, rough: true });
      if (rec.lastPrompt && rec.lastPrompt !== rec.task) tl.push({ at: t0, kind: 'you', text: rec.lastPrompt, rough: true });
      if (rec.lastError) tl.push({ at: t0, kind: 'error', text: rec.lastError, rough: true });
      if (rec.lastReport) tl.push({ at: rec.lastReportAt || t0, kind: 'her', text: rec.lastReport, rough: true });
      if (rec.status === 'waiting' && rec.waitDetail) tl.push({ at: Date.now(), kind: 'wait', text: '在等你确认：' + rec.waitDetail, rough: true });
    }
    return {
      ...row,
      timeline: tl,
      files: row.files || [],
      // 能不能在手机上继续追问：窗口还活着才行（关了就只能看历史）
      canSend: rec.status !== 'closed',
    };
  }

  /**
   * 往这条线的终端里下发一句话（手机上「继续说」用的）。
   *
   * 【为什么走剪贴板而不是直接敲字】SendKeys 只能发键，中文根本发不出去；
   * 而且任务描述里的 {} () + ^ % ~ 在 SendKeys 语法里全是控制符，转义一处
   * 漏掉就是一句面目全非的指令进了终端。所以：把话放进剪贴板 → 精确聚焦
   * 那个窗口 → Ctrl+V + 回车。**剪贴板用完还回去**，不然你手上那份复制的
   * 东西就被我们悄悄换掉了。
   *
   * 跟放行同一套安全线：只认精确窗口（-Exact）、回执标题要对得上。
   */
  async sendText(id, text) {
    const rec = this.items.get(id);
    if (!rec) return { ok: false, error: '没这个终端' };
    if (rec.status === 'closed') return { ok: false, error: '这个窗口已经关了，接不上了' };
    const line = String(text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim();
    if (!line) return { ok: false, error: '话是空的' };
    if (line.length > 2000) return { ok: false, error: '太长了，分两次说吧' };

    let out = '';
    try {
      out = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', FOCUS_PS1, '-Title', rec.title, '-Exact', '-WaitMs', '4000',
        // 文本走 stdin（-PasteStdin）：命令行传中文要过一层编码，
        // 而参数表里的引号规则又是另一个雷区。stdin 干净利落
        '-PasteStdin',
      ], 15000, line);
    } catch (err) {
      return { ok: false, error: '没送出去：' + err.message };
    }
    const m = /^SENT (.*)$/m.exec(String(out));
    if (m && m[1].trim() === rec.title) {
      rec.status = 'running';
      this._timeline(rec, 'you', line.slice(0, 300));
      rec.lastPrompt = line.replace(/\s+/g, ' ').trim().slice(0, 120);
      this.emit('change');
      this.log('[term] ' + rec.id + ' 手机上追问了一句：' + line.slice(0, 40));
      return { ok: true };
    }
    if (m) return { ok: false, error: '聚焦到的窗口跟这条线对不上，没敢发（去电脑上说吧）' };
    return { ok: false, error: '窗口调不到前台，没敢发（标题可能被改了）' };
  }

  /**
   * 远程放行/拒绝：把确认键送进那个终端窗口。
   *
   * 【原理和边界，都要说实话】终端里的权限确认是 CLI 自己的交互界面，
   * 我们够不到它的进程 —— 唯一的路是把窗口调到前台、把按键送过去
   * （focus-window.ps1 的 -SendKeys，**只有确认窗口真到了前台才发键**，
   * 不然按键会砸进用户正在打字的别的窗口）。按键送到 ≠ 一定被吃下：
   * claude 的确认界面 1 = 允许、Esc = 拒绝；codex 是 y/n。
   * 界面改版按键就可能失效，所以返回话术只承诺「送到了」，
   * 让调用方几秒后看状态自证。只对 waiting 的线放行 —— 别的状态发键
   * 等于往人家终端里乱敲字。
   */
  async approveRemote(id, allow) {
    const rec = this.items.get(id);
    if (!rec) return { ok: false, error: '没这个终端' };
    if (rec.status !== 'waiting') return { ok: false, error: '这条线现在不在等确认' };
    const keys = rec.agent === 'codex' ? (allow ? 'y' : 'n') : (allow ? '1' : '{ESC}');
    let out = '';
    try {
      out = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        // -Exact：发键这条路**禁用「标题包含」兜底**。Claude 跑起来会改
        // 控制台标题，精确匹配落空是常态，而兜底会抓到同项目的分线窗口 ——
        // 把确认键敲进别的线（评审抓的高危）。宁可这次放行失败让你去电脑上点，
        // 也绝不敲错窗口
        '-File', FOCUS_PS1, '-Title', rec.title, '-SendKeys', keys, '-Exact',
        '-WaitMs', '4000',
      ], 12000);
    } catch (err) {
      return { ok: false, error: '按键没送出去：' + err.message };
    }
    // 回执里带回真正被聚焦的标题，跟 rec.title 严丝合缝才算数 ——
    // 双保险，脚本万一还是抓错了，这儿也不让它过
    const m = /^SENT (.*)$/m.exec(String(out));
    if (m && m[1].trim() === rec.title) {
      this.log('[term] ' + rec.id + ' 远程' + (allow ? '放行' : '拒绝') + '，按键已送进窗口');
      return { ok: true };
    }
    if (m) return { ok: false, error: '聚焦到的窗口跟这条线对不上，没敢发键（那条线的标题可能被改了，去电脑上点吧）' };
    return { ok: false, error: '窗口调不到前台，按键没敢发（标题可能被改了）' };
  }

  // 同一条线被新窗口接走了：把它已经 closed 的旧行收掉（历史都在新窗口里续写）
  _retireLane(laneId, keepId) {
    let removed = false;
    for (const [oldId, r] of [...this.items]) {
      if (oldId !== keepId && r.laneId === laneId && r.status === 'closed') {
        this.items.delete(oldId);
        this._cleanFiles(oldId);
        this.log('[term] ' + oldId + ' 的线被 ' + keepId + ' 接走了，旧行收起');
        removed = true;
      }
    }
    return removed;
  }

  // 从列表里去掉。不动那个窗口 —— 用户只是不想在面板上看见它了。
  forget(id) {
    if (this.items.has(id)) {
      this.items.delete(id);
      this._cleanFiles(id);
    }
    this.emit('change');
  }

  /**
   * 窗口没了的，从列表里清掉。
   *
   * 判据是 term-shell 这个进程还在不在 —— 它是终端窗口里的第一个进程，
   * 窗口被叉掉它就跟着没了。所以「进程没了」==「窗口没了」。
   *
   * 注意别把这个跟 close 上报搞混：claude 干完活退出时会报一次 close，
   * 但那会儿窗口还开着（term-shell 停在「按回车关掉」那一步等你看结果），
   * 这条就该继续留在列表里 —— 你可能还想点它把窗口调到前面看看它说了啥。
   * 真正该消失的时机是你把窗口关掉。
   */
  /**
   * 这个窗口没了 —— 但**不能直接删**：那条记录上挂着「这个活干成什么样了」，
   * 删了你就再也看不到结果了（窗口也已经没了）。
   *
   * 干过活的转成「已完成」留在列表上；一次都没干过的（开了就关、或者
   * 压根没起来）才真删，那种留着纯粹是噪音。
   *
   * 三条路都汇到这儿：term-shell 死前亲口报的 gone（最快，亚秒级）、
   * pid 探测（3 秒一拍）、心跳断了的兜底（pid 被复用时唯一的出路）。
   */
  _windowGone(rec, how) {
    // codex 的线收不到 hook 事件，turns 永远是 0 —— 但派了活它就真干过，
    // 得留下来（不留的话面板上的「再来」对 codex 线永远不出现）。
    // 没派活的 codex 空终端照旧直接去掉。
    const worked = rec.turns > 0 || rec.lastReport ||
                   (rec.agent === 'codex' && rec.task && rec.task.trim() &&
                    // 还得真起来过：term-shell 报过到（pid）或打过心跳。
                    // 从没报到的夭折线不算「干过」，别冒充「已完成」骗出「再来」
                    Boolean(rec.pid || rec.lastBeat));
    if (worked) {
      if (rec.status === 'closed') return false;
      rec.status = 'closed';
      rec.closedAt = rec.closedAt || Date.now();
      // 最后一轮的钱在这儿收尾 —— 那一轮很可能没触发汇报（你直接叉掉了窗口），
      // 不结这一下，最后那笔就永远进不了流水账
      this._settleCost(rec);
      this.log('[term] ' + rec.id + '（' + rec.name + '）窗口关了（' + how + '），转成已完成留着');
    } else {
      this.items.delete(rec.id);
      this._cleanFiles(rec.id);
      this.log('[term] ' + rec.id + '（' + rec.name + '）什么都没干过（' + how + '），直接去掉');
    }
    this.emit('change');
    return true;
  }

  _sweep() {
    let dirty = false;
    const now = Date.now();

    for (const rec of this.items.values()) {
      if (rec.status === 'closed') continue;
      this._codexPeek(rec, now);
      this._codexWatch(rec);
      const alive = pidAlive(rec.pid);

      if (alive === false) {
        this._windowGone(rec, 'pid 探测');
        continue;
      }

      /**
       * pid 说「活着」也不能全信 —— Windows 的 pid 是回收复用的。
       * term-shell 一死，号码可能立刻发给别的进程，探测就一直误报，
       * 面板上那条要挂到接盘的进程也退出才消失（实际见过挂几分钟的）。
       *
       * 所以再核一道心跳：term-shell 每 5 秒打一次。心跳断了超过 16 秒
       * （三个心跳都没来），并且**连着三拍**都是这样，才判窗口没了。
       * 「连着三拍」是给睡眠唤醒留的余量 —— 刚唤醒那一拍，上一次心跳
       * 停在入睡前很正常，真活着的话 5 秒内新心跳就到了。
       */
      if (rec.status !== 'done' && rec.lastBeat && now - rec.lastBeat > 16000) {
        rec.staleBeats = (rec.staleBeats || 0) + 1;
        if (rec.staleBeats >= 3) {
          this._windowGone(rec, '心跳断了 ' + Math.round((now - rec.lastBeat) / 1000) + ' 秒');
          continue;
        }
      } else {
        rec.staleBeats = 0;
      }

      // pid 还没报上来（窗口刚开、或者压根没起来），只能靠心跳兜底
      if (alive === null && now - rec.lastSeen > DEAD_MS) {
        this._windowGone(rec, '一直没动静');
      }
    }

    // 已完成的只留最近几条。留着是为了「回头看一眼那个活干成什么样」，
    // 不是攒历史 —— 攒多了列表就没法看了
    const done = [...this.items.values()]
      .filter((r) => r.status === 'closed')
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    for (const r of done.slice(FINISHED_KEEP)) {
      this.items.delete(r.id);
      this._cleanFiles(r.id);
      dirty = true;
    }

    if (dirty) this.emit('change');
    this._pulse(now);
  }

  /**
   * 一条线的活真的干完了 —— **报一次，只报一次**。
   *
   * 这个时刻以前是个哑巴：状态变灰、列表里沉底，她本人一点反应都没有。
   * 原因是「干完了给个反应」那套挂在 sessions.js（无头模式）上，而默认早就
   * 换成真终端了 —— 于是 mood.onTaskDone **在正常使用里从来没被调用过**，
   * 「一遍过就得意四分钟」「砸了会低落」这些写好的东西全是死的。
   *
   * close（claude 自己退了）和 SessionEnd（hook 报的）可能都会来，
   * 谁先到算谁的，靠 rec.finished 挡住第二次。
   */
  _finish(rec, code) {
    if (rec.finished) return;
    rec.finished = true;
    this.emit('finish', {
      id: rec.id,
      name: rec.name,
      project: rec.project,
      laneName: rec.laneName || '',
      // 她被派出去的活，还是你自己开的终端 —— 上层据此决定反应有多大
      dispatched: Boolean(rec.dispatched),
      // 退出码拿不到时（SessionEnd 那条路）当成功。**宁可少沮丧一次** ——
      // 把正常收工误判成砸了，她会没来由地低落，你还找不到原因
      ok: code == null || code === 0,
      turns: rec.turns || 0,
      tools: rec.toolCount || 0,
      errors: rec.errorCount || 0,
      elapsedMs: Date.now() - rec.startedAt,
    });
  }

  /**
   * 她现在整体在干什么 —— 每三秒吐一次，但**只在变了的时候吐**。
   *
   * 这条流是「派出去之后那几分钟你是瞎的」的解药。原来这些数据只喂两个地方：
   * 面板上的列表，和一段结束时的那句汇报。中间那几分钟她身上一点反应都没有 ——
   * 你不知道她在正轨上还是在挖坑，等她开口时可能已经改了二十个文件。
   *
   * 数据本来就全在记录里（动了几次工具、报了几次错、多久没动静、是不是在等你），
   * 缺的只是「持续说出来」这一步。而说的方式是**身体**，不是嘴 ——
   * 嘴要花钱，而且每隔几分钟念一句进度比不说还烦。
   *
   * 好几个终端一起跑时取**最该被看见**的那个：
   * 干偏了 > 等你确认 > 一直报错 > 卡住不动 > 正常干着。
   * 她只有一个身体，得让位给最要紧的。
   */
  _pulse(now = Date.now()) {
    const RANK = { alarm: 5, waiting: 4, struggling: 3, stuck: 2, working: 1 };
    let best = null;

    for (const rec of this.items.values()) {
      const alarming = rec.alarmUntil > now;
      if (rec.status === 'done' || rec.status === 'closed') continue;
      // idle（这一轮完事了）本来该把身体交还给心情，**但刚喊过你的除外** ——
      // 她转过来说「你看一眼」，结果那一轮正好在这时候结束，
      // 姿态会被当场掐掉，25 秒缩水成一两秒，你一抬头人已经转回去了
      if (rec.status === 'idle' && !alarming) continue;

      let state = null;
      // 刚喊过你，先保持转过来看着你这个姿态。
      // 到点自然就轮不到它了，**不用写任何清理代码**
      if (alarming) state = 'alarm';
      else if (rec.status === 'waiting') state = 'waiting';
      else if (rec.status === 'running') {
        if (rec.errorCount >= STRUGGLE_ERRORS) state = 'struggling';
        // 状态还是 running，但这么久没有任何 hook 事件进来 —— 多半卡住了
        else if (now - (rec.lastHookAt || rec.startedAt) > STUCK_MS) state = 'stuck';
        else state = 'working';
      }
      if (!state) continue;

      if (!best || RANK[state] > RANK[best.state]) {
        best = {
          state,
          id: rec.id,
          name: rec.name,
          tools: rec.toolCount || 0,
          errors: rec.errorCount || 0,
          files: rec.files ? rec.files.size : 0,
        };
      }
    }

    // 只在「状态」或「是哪个终端」变了的时候才吐。工具数每秒都在涨，
    // 跟着吐的话渲染层每三秒被打断一次，姿态永远在重新淡入
    const key = best ? best.state + ':' + best.id : 'none';
    if (key === this._pulseKey) return;
    this._pulseKey = key;
    this.emit('pulse', best || { state: 'none' });
  }

  dispose() {
    // codex 线的钱只有关窗那一个结算点（claude 每轮汇报都结过）。
    // 用户先退桌宠、窗口还开着的话，这笔就永远进不了流水 —— 走之前结掉
    for (const rec of this.items.values()) {
      if (rec.agent === 'codex' && rec.costUsd - (rec.costPaid || 0) > 1e-6) {
        try {
          this._settleCost(rec);
          this._codexPersist(rec); // 不落盘的话，重启认回来这笔会再记一遍
        } catch (_) { /* 结不上也不能拦退出 */ }
      }
    }
    clearInterval(this.timer);
  }
}

// 跑一个命令拿它的输出，带超时。
function run(bin, args, timeout = 5000, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve(String(stdout || ''));
    });
    // 有话要喂就喂（手机追问那条路：文本走 stdin，不过命令行）
    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* 对面已经退了，没什么可做的 */ });
      child.stdin.end(String(stdin), 'utf8');
    }
  });
}

module.exports = {
  TerminalManager, readLastAssistantText, findWt, findNode, pidAlive, spokenReport,
  // 护栏那三个是纯函数，导出来给自检拿几十条真命令喂 —— 这功能的生死线是误报率，
  // 只能靠表驱动的用例守住
  checkDanger, isInside, filePathOf, REWRITE_MAX,
};
