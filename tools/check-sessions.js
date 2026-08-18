'use strict';

// 她给每个项目记的那条会话，现在还在不在。
//
// 起因是一个很难自己发现的现象：你在终端里跟她干了半天活，下次打开发现
// 她什么都不记得了 —— 而且**不报任何错**，因为 sessions.js 发现接不上之后
// 会安静地换一个新 id 重开（src/sessions.js 的 _resumableRecord）。
// 记忆断了，但表面上一切正常。
//
// 会话丢失有两个常见原因，这个工具帮你分清楚是哪个：
//   1. **交互式会话直接叉窗口了** —— 它要正常退出（`/exit`）才落盘。
//      窗口被叉掉就什么都没留下，registry 上却还记着「聊过 6 轮」。
//   2. **被 30 天自动清理了** —— `~/.claude/projects` 下的会话不是永久的。
//
// 顺带也报出「目录里还躺着别的桌宠会话」的情况 —— 那说明记忆还在，
// 只是 registry 指错了地方，可以手动接回来。
//
// 跑法：npm run sessions      不花钱、不联网、只读。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { projectStoreDir, sessionExists } = require(path.join(ROOT, 'src', 'sessions'));

const PROJ = path.join(os.homedir(), '.claude', 'projects');
const REGISTRY = path.join(ROOT, 'sessions', 'registry.json');

/** 这条会话叫什么名字。只读文件开头一段 —— 有的会话有几十 MB。 */
function titleOf(file) {
  let txt = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(256 * 1024, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    txt = buf.toString('utf8');
  } catch (_) {
    return null;
  }

  let name = null;
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      // customTitle 是 `/rename` 和 `-n` 共用的那个字段；aiTitle 是 claude 自己起的
      if (typeof j.customTitle === 'string') name = j.customTitle;
      else if (!name && typeof j.aiTitle === 'string') name = j.aiTitle;
    } catch (_) {
      /* 半行/坏行，跳过 */
    }
  }
  return name;
}

/** 这个项目目录下，桌宠自己开的会话有哪些 */
function petSessionsIn(projectPath) {
  const dir = path.join(PROJ, projectStoreDir(projectPath));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (_) {
    return [];
  }

  return files
    .map((f) => {
      const full = path.join(dir, f);
      let m = 0;
      let size = 0;
      try {
        const s = fs.statSync(full);
        m = s.mtimeMs;
        size = s.size;
      } catch (_) { /* 读不到就当 0 */ }
      return { id: f.replace(/\.jsonl$/, ''), name: titleOf(full), mtime: m, size };
    })
    // 桌宠开的会话名字都以 waifu: 开头（-n 给的）。别的是你自己开的，不该动
    .filter((s) => s.name && s.name.startsWith('waifu:'))
    .sort((a, b) => b.mtime - a.mtime);
}

const ago = (ms) => {
  const d = (Date.now() - ms) / 86400000;
  if (d < 1 / 24) return Math.round(d * 24 * 60) + ' 分钟前';
  if (d < 1) return Math.round(d * 24) + ' 小时前';
  return d.toFixed(1) + ' 天前';
};

let registry = {};
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
} catch (_) {
  console.log('还没有 registry.json —— 一个活都没派过。');
  process.exit(0);
}

const rows = Object.values(registry);
if (!rows.length) {
  console.log('registry 是空的。');
  process.exit(0);
}

console.log('\n她给每个项目记的会话：\n');

let lost = 0;
let recoverable = 0;

for (const r of rows) {
  const alive = sessionExists(r.path, r.sessionId);
  const others = petSessionsIn(r.path).filter((s) => s.id !== r.sessionId);

  console.log('【' + r.name + '】  ' + r.path);
  console.log('   registry 记着: ' + r.sessionId.slice(0, 8) + '…  聊过 ' + (r.turns || 0) + ' 轮  ' +
              (alive ? '\x1b[32m✓ 会话还在\x1b[0m' : '\x1b[31m✗ 这条会话已经不在磁盘上了\x1b[0m'));

  if (!alive) {
    lost++;
    if (others.length) {
      recoverable++;
      console.log('   \x1b[33m同一个项目下还躺着 ' + others.length + ' 条她开过的会话：\x1b[0m');
      for (const s of others.slice(0, 3)) {
        console.log('     ' + s.id.slice(0, 8) + '…  「' + s.name + '」  ' +
                    (s.size / 1024).toFixed(0) + 'KB  ' + ago(s.mtime));
      }
      console.log('   → 记忆还在，只是 registry 指错了。想接回来的话：');
      console.log('     把 sessions/registry.json 里这条的 sessionId 改成上面某一个，' +
                  'turns 改成大于 0 的数');
    } else {
      console.log('   → 这个项目下一条她开过的会话都没有了，接不回来了');
    }
  }
  console.log('');
}

console.log('—'.repeat(56));
console.log(rows.length + ' 个项目，' + lost + ' 个的会话丢了' +
            (recoverable ? '（其中 ' + recoverable + ' 个还能接回来）' : ''));

if (lost) {
  console.log('');
  console.log('会话为什么会丢，两个常见原因：');
  console.log('  1. **交互式终端直接叉窗口了** —— 会话要正常退出（`/exit`）才落盘。');
  console.log('     窗口被叉掉就什么都没留下，而 registry 上还记着聊过几轮。');
  console.log('  2. **超过 30 天** —— ~/.claude/projects 下的会话不是永久保存的。');
  console.log('');
  console.log('丢了之后她不会报错，只会安静地换条新会话重开（sessions.js 的 _resumableRecord），');
  console.log('所以从外面看就是「她突然不记得之前的事了」。');
}
