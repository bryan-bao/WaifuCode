'use strict';

// 终端任务的外壳。
//
// 你从桌宠点「开终端我看着」时，终端窗口里跑的不是裸 claude，而是这个脚本，
// 它再把 claude 拉起来。中间夹这一层是为了三件事：
//
//   1. **她得知道这个终端还开着**。裸 claude 跑在别人家的窗口里，桌宠只能靠
//      hook 事件猜；夹一层就能实打实地上报「开了」「还活着」「关了」。
//   2. **参数不用过命令行**。项目路径和任务描述里有空格、引号、中文、分号，
//      经过 cmd 和 wt 两层转义之后基本必炸。改成把参数写进一个 json 文件，
//      命令行上只留一个 id。
//   3. **给 claude 注入 WAIFU_TERM_ID**。hook 是 claude 的子进程，能读到这个
//      环境变量，桌宠据此把 hook 事件准确归到是哪个终端 —— 而不是把你自己
//      另开的窗口也算进来。
//
// claude 是 stdio: 'inherit' 起的，所以它的交互界面、颜色、快捷键跟你手动敲
// 一模一样，你随时可以插手接管。

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = process.argv[2];

if (!arg) {
  console.error('用法: node term-shell.js <参数文件.json>');
  process.exit(2);
}

// 收完整路径。早先是只收一个 id、自己去 sessions/terminals 底下拼路径，
// 那样一换存储目录就找不着了（自检脚本第一次跑就栽在这儿）。
const specFile = arg.toLowerCase().endsWith('.json')
  ? arg
  : path.join(ROOT, 'sessions', 'terminals', arg + '.json');

let spec = null;
try {
  spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
} catch (err) {
  console.error('\x1b[31m读不到这个终端任务的参数\x1b[0m');
  console.error('  ' + specFile);
  console.error('  ' + err.message);
  console.error('');
  // 这儿不能让窗口一闪而过 —— 出错信息得留在屏幕上给人看见。
  // CommonJS 的模块顶层是个函数体，所以这个 return 是合法的。
  hold(2);
  return;
}

const id = spec.id || path.basename(specFile, '.json');

// --- 跟桌宠通气 -------------------------------------------------------------
// 桌宠关了、端口变了都不该影响你在这儿正常干活，所以这里永远是「尽力而为」：
// 发不出去就算了，绝不阻塞、绝不报错刷屏。
function tell(payload) {
  return new Promise((resolve) => {
    let port = spec.port;
    try {
      // 每次现读，桌宠中途重启换了端口也能接上
      const rt = spec.runtimeFile || path.join(ROOT, 'sessions', 'runtime.json');
      port = JSON.parse(fs.readFileSync(rt, 'utf8')).port;
    } catch (_) {
      /* 用 spec 里那个 */
    }
    if (!port) return resolve();

    const body = Buffer.from(JSON.stringify({ ...payload, termId: id }), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/term',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: 1000,
      },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// --- 拼 claude 的参数 -------------------------------------------------------
function claudeArgs(useResume) {
  const args = [];

  /**
   * 这一趟用哪条会话，两种情况。
   *
   * **全新（默认）** —— 拿我们指定的 id 开条干净的。
   *
   * 从桌宠点开终端**永远走这条**：不去 --resume 上次的记录。
   * 想接着上次聊，你自己在终端里敲 `/resume` 挑一条 —— 那是你明确的动作，
   * 不该每次开窗口都替你读一遍（慢、烧钱，而且多半不是你要的那条）。
   *
   * **接着上次（useResume）** —— 只有你在面板上点某条老线的「接着聊」
   * 才走这儿。（--resume 接不上时会落回上面那条：失败恰恰说明这条会话不存在。）
   */
  if (useResume) {
    args.push('--resume', spec.sessionId);
  } else {
    args.push('--session-id', spec.sessionId);
  }

  /**
   * 只在**新开会话**时给名字，接着上次的时候不给。
   *
   * `-n` 设的是会话的 `customTitle`，而 `/rename` 改的**正是同一个字段**。
   * 原来这里每次都传，于是你在终端里 `/rename` 改好的名字，
   * 下次桌宠再开这个终端就被冲回 `waifu:项目名` 了。
   *
   * 实测（同一条会话连续三次）：
   *   --session-id … -n 名字甲   → customTitle=名字甲
   *   --resume …     -n 名字乙   → customTitle=名字乙   ← 覆盖了
   *   --resume …     不传 -n     → customTitle=名字乙   ← 保住了
   *
   * 不传也不会丢终端标题：claude 会沿用会话里已有的 customTitle 去设，
   * 桌宠照样按标题找得回这个窗口。当初写这行时担心的「标题被冲掉」，
   * 只发生在**首次创建**（那时候会话还没有名字）。
   */
  if (spec.title && !useResume) args.push('-n', spec.title);

  // 权限模式。终端里虽然有你盯着，但让它自己判断安全与否还是省事得多，
  // 不然每跑一条命令都要你按一次回车。
  if (spec.permissionMode) args.push('--permission-mode', spec.permissionMode);
  // 面板上选的模型。没选就不传 —— 让 claude 用它自己设置里的
  if (spec.model) args.push('--model', spec.model);

  if (Array.isArray(spec.extraArgs)) args.push(...spec.extraArgs);

  // 任务描述作为初始 prompt，一进去就开跑
  if (spec.task && spec.task.trim()) args.push(spec.task);

  return args;
}

// codex 跟 claude 只差参数怎么拼。差异收在 src/agents.js，这儿只分个岔。
// （打包是 asar:false，src/ 跟 hooks/ 一样躺在真实磁盘上，require 得到。）
function buildArgs(useResume) {
  if (spec.agent === 'codex') {
    return require(path.join(ROOT, 'src', 'agents.js')).codexArgs(spec);
  }
  return claudeArgs(useResume);
}

function banner() {
  const line = '─'.repeat(58);
  console.log('\x1b[36m' + line + '\x1b[0m');
  console.log('\x1b[36m  WaifuCode\x1b[0m  ' + (spec.name || '') + '   \x1b[90m' + spec.dir + '\x1b[0m');
  if (spec.task && spec.task.trim()) {
    console.log('\x1b[90m  活儿：' + spec.task.replace(/\s+/g, ' ').slice(0, 100) + '\x1b[0m');
  }
  if (spec.agent === 'codex') {
    // codex 没有 claude 那套 hook，她收不到里面的动静 —— 别许诺「会来汇报」
    console.log('\x1b[90m  这扇窗跑的是 Codex。她只管开关窗口，里面的事不盯。\x1b[0m');
  } else {
    console.log('\x1b[90m  她在旁边看着，每做完一段会去跟你汇报。\x1b[0m');
    console.log('\x1b[90m  想让她记住这次聊的，用 /exit 退出，别直接叉窗口。\x1b[0m');
  }
  console.log('\x1b[36m' + line + '\x1b[0m');
  console.log('');
}

// --- 走起 -------------------------------------------------------------------
let beat = null;
let retried = false;

(async () => {
  banner();
  await tell({ phase: 'open', pid: process.pid, dir: spec.dir, name: spec.name, task: spec.task });

  // 心跳。桌宠主要靠探测这个进程还在不在来判断窗口关没关，
  // 心跳是兜底 —— 顺带也让它知道我们这边一切正常。
  //
  // 同时**把窗口标题写回去**：Claude Code 跑起来会改控制台标题，一改桌宠那边
  // 「按标题把窗口调到前面」就落空了 —— 你点「看看她在干嘛」会没反应。
  // 启动脚本里那句 `title` 只管开头一次，压不住后面的改动，得一直按着。
  beat = setInterval(() => {
    tell({ phase: 'beat', pid: process.pid });
    if (spec.title) {
      // Node 在 Windows 上给 process.title 赋值就是改控制台窗口标题
      try { process.title = spec.title; } catch (_) { /* 改不了就算了，不影响干活 */ }
    }
  }, 5000);
  if (beat.unref) beat.unref();

  if (spec.title) { try { process.title = spec.title; } catch (_) { /* 同上 */ } }

  // Ctrl+C 交给 claude 自己处理，这一层别抢
  process.on('SIGINT', () => {});

  /**
   * 窗口被叉掉的那一刻，抢在死前喊一声「我没了」。
   *
   * Windows 上关掉控制台窗口，Node 会收到一个 SIGHUP，然后系统给大约 5 秒
   * 收拾后事。不喊这一声的话，桌宠只能靠 3 秒一拍的 pid 探测发现窗口没了 ——
   * 而 Windows 的 pid 是**回收复用**的：term-shell 一死，号码很快就发给别的进程，
   * 探测就一直报「还活着」，面板上那条要挂到接盘的进程也退出才消失。
   * 实际表现：你把窗口关了，列表里它还亮着，一点还提示「按标题没找到窗口」。
   *
   * tell() 是一发 1 秒超时的本地 HTTP，5 秒的余量绰绰有余。
   * 发不出去也无所谓 —— 桌宠那边还有「心跳断了」的兜底（_sweep）。
   */
  process.on('SIGHUP', () => {
    clearInterval(beat);
    tell({ phase: 'gone' }).then(() => process.exit(0), () => process.exit(0));
  });

  launch(Boolean(spec.resume));
})();

/**
 * 【`shell: true` 那条路是零转义的，带空格的参数会当场碎掉。】
 *
 * Node 在 shell 模式下**只是拿空格把 args 拼成一条命令行，一个引号都不加**。
 * 实测（`spawn(bat, ['-n','WaifuCode · 我的 项目', '--append-system-prompt-file',
 * 'C:\My Data\notes\x.md'], {shell:true})`）那头收到的是：
 *
 *     [-n] [WaifuCode] [·] [我的] [项目] [--append-system-prompt-file]
 *     [C:\My] [Data\notes\x.md]
 *
 * 这不是理论问题，两条都在发生：
 *   · `-n` 的标题**恒定带空格**（`WaifuCode · 项目名`），所以只要 claude 是
 *     npm 装的（`claude.cmd` → isBatch），会话名一直是坏的 —— 被截成
 *     「WaifuCode」，「·」和项目名当成 prompt 混进这一轮任务
 *   · 小抄那个参数带的是数据目录全路径，装到 `C:\Program Files\WaifuCode`、
 *     便携版解压到带空格的文件夹、或者 Windows 用户名带空格，路径就断成两截
 *
 * 开发机是 `~/.local/bin/claude.exe`（shell:false），所以这条路自检永远走不到。
 *
 * 顺带堵住一个更难看的口子：`spec.task` 是外面传进来的自由文本，
 * 原来直接拼进命令行，里面有 `&&`、`|` 的话 cmd 会当成第二条命令去执行。
 * 包进引号之后 cmd 就不解析它们了。
 */
function quoteArg(a) {
  // 换行在 cmd 的命令行里**没有任何转义写法**，包进引号也会被当成第二条命令。
  // 任务描述和（codex 线拼进 prompt 的）小抄都是多行文本，走 .cmd 安装的
  // 批处理路时只能折成空格 —— 意思还在，排版没了。.exe 安装（shell:false）不受影响。
  const s = String(a).replace(/\r?\n/g, ' ');
  return /["\s]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function launch(useResume) {
  const bin = spec.bin || spec.claudeBin || 'claude'; // codex 的线由 spec.bin 指路
  const isBatch = /\.(cmd|bat)$/i.test(bin); // npm 装的是 .cmd，得靠 shell 才拉得起来
  const startedAt = Date.now();

  const args = buildArgs(useResume);
  const child = spawn(bin, isBatch ? args.map(quoteArg) : args, {
    cwd: spec.dir,
    stdio: 'inherit', // 关键：交互界面原样透传，你能随时接管
    shell: isBatch,
    env: {
      ...process.env,
      // hook 是 claude 的子进程，会继承这两个变量 —— 桌宠据此认人、认路
      WAIFU_TERM_ID: id,
      WAIFU_TERM_NAME: spec.name || '',
      WAIFU_RUNTIME_FILE: spec.runtimeFile || '',
    },
  });

  child.on('error', async (err) => {
    console.error('\n\x1b[31m起不来: ' + err.message + '\x1b[0m');
    console.error('CLI 路径: ' + bin);
    await tell({ phase: 'close', code: -1, error: err.message });
    hold(1);
  });

  child.on('exit', async (code) => {
    // 接旧会话没接上（窗口开出来就一行红字 "No conversation found with session ID"）。
    // 上次多半是被直接叉掉的 —— 交互式会话要正常退出才落盘。
    // 别把这行红字甩给用户，自己拿同一个 id 开条新的重来一遍。
    if (code !== 0 && useResume && !retried && Date.now() - startedAt < 8000) {
      retried = true;
      console.log('');
      console.log('\x1b[33m  接上次那条会话没接上，上次多半没正常退出、没存下来。\x1b[0m');
      console.log('\x1b[33m  这就给你开条新的，重来一遍。\x1b[0m');
      console.log('');
      launch(false);
      return;
    }

    await tell({ phase: 'close', code });
    console.log('');
    console.log('\x1b[36m' + '─'.repeat(58) + '\x1b[0m');
    console.log(
      code === 0
        ? '\x1b[32m  这个活儿结束了。\x1b[0m'
        : '\x1b[33m  ' + (spec.agent === 'codex' ? 'codex' : 'claude') + ' 退出，代码 ' + code + '。\x1b[0m'
    );
    hold(code === 0 ? 0 : 1);
  });
}

// claude 退完就把窗口关掉的话，你根本来不及看最后输出了什么。
// 停在这儿等一下键，让人有机会往回翻。
function hold(exitCode) {
  console.log('\x1b[90m  按回车关掉这个窗口。\x1b[0m');
  console.log('\x1b[36m' + '─'.repeat(58) + '\x1b[0m');
  // 按回车正常退出的这条路也喊一声 —— 跟被叉掉那条（SIGHUP）殊途同归，
  // 桌宠立刻知道「窗口没了」，不用等 pid 探测慢慢发现
  const bye = (code) => tell({ phase: 'gone' }).then(() => process.exit(code), () => process.exit(code));
  try {
    process.stdin.resume();
    process.stdin.once('data', () => bye(exitCode));
    // 万一 stdin 已经没了（窗口被外面掐了），别永远挂着
    process.stdin.on('error', () => bye(exitCode));
  } catch (_) {
    process.exit(exitCode);
  }
}
