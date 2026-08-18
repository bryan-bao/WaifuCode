'use strict';

// 一键打包：自检 → 打包 → 报路径。
//
// 双击项目根目录的「打包.bat」就是跑这个。也可以自己 npm run pack。
//
// 这里干的事有三件是别处不好塞的：
//
//  1. **把 electron-builder 的缓存挪到 D 盘。** 它默认往
//     %LOCALAPPDATA%\electron-builder\Cache 里塞东西 —— Electron 运行时
//     一份 100MB 出头、NSIS 的家伙事还有几十 MB，全在系统盘。
//     这台机器 C 盘只剩不到 30G，不挪不行。
//
//  2. **打包前先跑自检。** 打出来一个跑不起来的包，发给别人才发现，
//     那个来回的代价比在这儿多等十秒大得多。
//
//  3. **最后把产物路径和大小打出来。** 不然你得自己去 dist 里翻。
//
// -----------------------------------------------------------------------
// package.json 里 "build" 那段的几个选择（JSON 塞不进注释，记在这儿）
// -----------------------------------------------------------------------
//
// · **`asar: false` 是必须的，别手贱打开。**
//   asar 是个只读归档，Electron 自己读得了，**外面的进程读不了**。而这个项目有三处
//   是外面的进程在读：`hooks/term-shell.js` 由另起的 node.exe 跑、
//   `tools/focus-window.ps1` 由 powershell 跑、模型文件由 pixi 拿 file:// 去抓 .moc3。
//   打进 asar 之后这三样全哑，而且**不一定报错** —— 表现是终端开不出来、
//   点「看看她在干嘛」没反应、桌面上一片空白。
//
// · **`files` 里排掉 `vendor/pylibs`**（55MB 的 python 库）。全项目没有一行代码引用它。
//
// · **不打包 `music/`。** 放什么歌是使用者自己的事，版权也是。
//   `src/perform.js` 第一次启动会自己把文件夹和说明建出来。
//
// · **`extraMetadata.productName` 不能省。**
//   electron-builder 的 `productName` 只管 exe 文件名和快捷方式名字，**不会写进
//   打包后的 package.json**。而 Electron 认的是 package.json 里的
//   `productName`（没有才退回 `name`）—— 那就还是 `waifu-code`。
//   后果：装好的 App 和你 `npm start` 起的那只**共用同一个 userData 目录**，
//   于是共用同一把单实例锁。开发那只在跑的时候双击安装版，**它一声不吭就退了**
//   （exit 0，什么都不写，连日志都没有）。实测踩过，查了半天。
//
// · **`perMachine: false`。** 装到用户自己名下，不要管理员权限。
//   要了管理员反而更糟：装进 Program Files 之后目录只读，
//   数据得退到 AppData 去，那就不是「一个文件夹拷走就搬家」了。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const DIST = path.join(ROOT, 'dist');

const C = {
  dim: (s) => '\x1b[90m' + s + '\x1b[0m',
  ok: (s) => '\x1b[32m' + s + '\x1b[0m',
  bad: (s) => '\x1b[31m' + s + '\x1b[0m',
  hi: (s) => '\x1b[36m' + s + '\x1b[0m',
  b: (s) => '\x1b[1m' + s + '\x1b[0m',
};

function die(msg, hint) {
  console.log('');
  console.log(C.bad('✗ ' + msg));
  if (hint) console.log('  ' + hint);
  console.log('');
  process.exit(1);
}

function step(n, title) {
  console.log('');
  console.log(C.b('[' + n + '] ' + title));
}

/** 跑一条命令，直连当前终端（打包要输出进度，缓冲起来看着像卡死了） */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    shell: process.platform === 'win32', // npm/npx 在 Windows 上是 .cmd
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
  });
  return r;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// 绕开 winCodeSign 的软链接问题
// ---------------------------------------------------------------------------
//
// electron-builder 要用一个叫 winCodeSign 的工具包（里面有 rcedit —— 给 exe
// 换图标、写版本号靠它，**不签名也躲不掉**）。这个包是给三个平台合发的，
// 里面有两个 **macOS 的软链接**：
//
//     darwin/10.12/lib/libcrypto.dylib
//     darwin/10.12/lib/libssl.dylib
//
// 在 Windows 上建软链接是要特权的（默认只有管理员有，或者开了「开发者模式」）。
// 建不出来 → 7za 返回 exit 2 → electron-builder 判定解压失败 → 重试四次 → 打包中止。
// 报错长这样：`Cannot create symbolic link : 客户端没有所需的特权`
//
// 这两个文件在 Windows 上**一个字节都用不到**。所以这里抢在前面自己解压一遍，
// 把 darwin 整个跳过，结果放进它期望的缓存位置，它就直接拿去用了。
//
// 版本号不写死：先让 app-builder 自己去下（它知道该下哪个版本），
// 等它在解压那步栽了，从它自己打印的 URL 里把版本抠出来，
// 顺手把它下好的那个 .7z 捡起来用 —— 不用重下，也不用我们知道任何 URL。
//
// 另一条路是让用户去开 Windows 的「开发者模式」。不采纳：那是台机器级别的设置，
// 为了打个包让人改系统设置，太重了，而且发给别人之后对方也得改。

function findFile(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === name) return p;
    }
  }
  return null;
}

/** 缓存里已经有解压好的 winCodeSign 了吗 */
function haveWinCodeSign(dir) {
  try {
    return fs.readdirSync(dir).some(
      (n) => /^winCodeSign-/.test(n) && fs.statSync(path.join(dir, n)).isDirectory()
    );
  } catch (_) {
    return false;
  }
}

function seedWinCodeSign(cacheRoot) {
  const dir = path.join(cacheRoot, 'winCodeSign');
  if (haveWinCodeSign(dir)) return { ok: true, how: '缓存里已经有了' };

  const appBuilder = findFile(path.join(ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64'),
                              'app-builder.exe');
  const sevenZip = findFile(path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64'), '7za.exe');
  if (!appBuilder || !sevenZip) {
    // 找不到家伙事就别自作主张，让 electron-builder 自己去试
    return { ok: false, how: '没找到 app-builder / 7za，跳过这步' };
  }

  fs.mkdirSync(dir, { recursive: true });

  // 让它去下。解压那步大概率会栽（除非这台机器开了开发者模式），无所谓 ——
  // 我们要的是「下下来的那个 .7z」和「它想要哪个版本」
  const r = spawnSync(appBuilder, ['download-artifact', '--name', 'winCodeSign'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_BUILDER_CACHE: cacheRoot },
  });

  if (haveWinCodeSign(dir)) return { ok: true, how: '这台机器能建软链接，原样解压的' };

  const out = String(r.stdout || '') + String(r.stderr || '');
  const ver = (out.match(/winCodeSign-(\d+(?:\.\d+)+)\.7z/) || [])[1];
  if (!ver) return { ok: false, how: '没看出它要哪个版本，跳过这步' };

  // 捡它刚下好的那个包（文件名是随机数字）
  const archives = fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.7z'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!archives.length) return { ok: false, how: '没找到下好的包，跳过这步' };

  const target = path.join(dir, 'winCodeSign-' + ver);
  const un = spawnSync(sevenZip,
    ['x', '-bd', '-y', '-x!darwin', path.join(dir, archives[0].n), '-o' + target],
    { encoding: 'utf8' });

  if (un.status !== 0 || !haveWinCodeSign(dir)) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* 无所谓 */ }
    return { ok: false, how: '自己解压也没成，跳过这步' };
  }

  // 收拾现场：失败留下的临时目录和下载包
  for (const n of fs.readdirSync(dir)) {
    if (/^winCodeSign-/.test(n)) continue;
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch (_) { /* 无所谓 */ }
  }

  return { ok: true, how: '跳过 darwin 那两个软链接，自己解压的（版本 ' + ver + '）' };
}

// ---------------------------------------------------------------------------

console.log('');
console.log(C.b('WaifuCode 打包'));
console.log(C.dim('  项目: ' + ROOT));

// --- 1. 家伙事齐不齐 --------------------------------------------------------

step(1, '看看家伙事');

{
  const v = run('node', ['-v'], { quiet: true });
  if (v.status !== 0) die('找不到 node', '装一个 Node.js 再来：https://nodejs.org');
  console.log('  ' + C.ok('✓') + ' node ' + String(v.stdout).trim());
}

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) {
  die('依赖没装', '先在项目目录跑一次：npm install');
}
console.log('  ' + C.ok('✓') + ' 依赖在');

// electron-builder 是打包才要的，平时用不上，所以按需装
const BUILDER = path.join(ROOT, 'node_modules', 'electron-builder');
if (!fs.existsSync(BUILDER)) {
  console.log('  ' + C.dim('电脑上还没有 electron-builder，现在装（只装这一次，几分钟）'));
  console.log('  ' + C.dim('装到: ' + BUILDER));
  // 万一这一趟顺带触发了 electron 的下载，也别让那 110MB 落到 C 盘去。
  // 名字必须是 electron_config_cache 这个原名 —— 写进 .npmrc 是没用的，
  // npm 会把它改名成 npm_config_electron_config_cache，而 install.js 不看那个
  const r = run('npm', ['install', '-D', 'electron-builder@^25', '--no-audit', '--no-fund'], {
    env: { electron_config_cache: path.join(CACHE, 'electron') },
  });
  if (r.status !== 0) die('electron-builder 装不上', '看看上面的报错，多半是网络问题');
}
console.log('  ' + C.ok('✓') + ' electron-builder 在');

// --- 2. 自检 ----------------------------------------------------------------

step(2, '打包前自检');
console.log(C.dim('  （几秒钟。打出来一个跑不起来的包才是真浪费时间）'));

const CHECKS = [
  ['接线（IPC 白名单）', ['tools/test-wiring.js']],
  ['心情系统', ['test-mood.js']],
  ['上下文', ['tools/test-context.js']],
  ['姿态', ['tools/test-posture.js']],
  ['终端生命周期', ['tools/test-termlife.js']],
];

for (const [name, args] of CHECKS) {
  const r = run('node', args, { quiet: true });
  if (r.status !== 0) {
    console.log('  ' + C.bad('✗') + ' ' + name);
    console.log('');
    console.log(String(r.stdout || '') + String(r.stderr || ''));
    die('自检没过，不打包', '先把上面那条修好');
  }
  console.log('  ' + C.ok('✓') + ' ' + name);
}

// --- 3. 打包 ----------------------------------------------------------------

step(3, '打包');

// 缓存全挪到项目底下的 .cache —— 默认在 %LOCALAPPDATA%（系统盘），
// Electron 运行时 + NSIS 家伙事加起来一百多 MB，别往 C 盘塞
fs.mkdirSync(CACHE, { recursive: true });
const env = {
  ELECTRON_BUILDER_CACHE: path.join(CACHE, 'electron-builder'),
  ELECTRON_CACHE: path.join(CACHE, 'electron'),
};
console.log(C.dim('  缓存目录: ' + CACHE + '（不占 C 盘）'));
console.log(C.dim('  头一次要下 Electron 运行时，一百多 MB，慢是正常的'));

// 见上面那一大段：winCodeSign 里有两个 macOS 软链接，Windows 上没特权建不出来，
// 建不出来整个打包就中止。抢在前头自己解压一遍，跳过那两个文件。
const seed = seedWinCodeSign(env.ELECTRON_BUILDER_CACHE);
console.log(C.dim('  winCodeSign: ' + seed.how));
console.log('');

const build = run('npx', ['electron-builder', '--win', '--x64'], { env });
if (build.status !== 0) die('打包失败', '往上翻，electron-builder 会说是哪儿的问题');

// --- 4. 交货 ----------------------------------------------------------------

step(4, '打好了');

let out = [];
try {
  out = fs
    .readdirSync(DIST)
    .filter((f) => /\.(exe|zip)$/i.test(f))
    .map((f) => ({ f, size: fs.statSync(path.join(DIST, f)).size }))
    .sort((a, b) => b.size - a.size);
} catch (_) {
  /* 下面会报「一个产物都没有」 */
}

if (!out.length) die('dist 里一个产物都没有', '打包过程可能被中途打断了，重跑一次');

console.log('');
for (const { f, size } of out) {
  const kind = /安装版/.test(f) ? '安装版（双击装，可选装到哪个盘）'
             : /免安装/.test(f) ? '免安装版（解压就能跑，数据在 exe 旁边）'
             : '';
  console.log('  ' + C.hi(path.join(DIST, f)));
  console.log('    ' + mb(size) + (kind ? '  ' + C.dim('· ' + kind) : ''));
}

console.log('');
console.log('  ' + C.b('发给别人：') + '上面这两个文件，随便挑一个发过去就行。');
console.log('  ' + C.dim('用法写在 dist\\win-unpacked\\给使用者看.txt，安装包里也带着。'));
console.log('');
console.log('  ' + C.dim('提醒：对方要想用「派活 / 私聊」，他自己电脑上得先装 Claude Code。'));
console.log('  ' + C.dim('      唱跳、摸头、小游戏这些不用，装完就能玩。'));
console.log('');
console.log(C.dim('  （这段中文是 node 打的，不是 bat 打的 —— bat 里写中文会被 cmd 解析坏，'));
console.log(C.dim('    详见 打包.bat 开头那段注释）'));
console.log('');
