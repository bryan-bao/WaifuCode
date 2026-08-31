'use strict';

// 把桌宠的 hook 装进（或卸出）~/.claude/settings.json。
//
// 这个文件是你 Claude Code 的总配置，里面还有状态栏、插件之类的东西，
// 所以这里的原则是：只增不改、先备份、可幂等、可完整卸载。
// 任何一步看着不对就直接罢工，绝不硬写。
//
//   装:  node hooks/install.js
//   卸:  node hooks/install.js --remove
//
// 【2026-08-31 起桌宠开机自己调它】原来只有开发机手动 `npm run install-hooks`
// 跑过，发给别人的安装包**根本没装 hook** —— 那台机器上她只是个不会说话的
// 动画：状态灯、护栏、「等你确认」、回来汇报全部静默失效，还没有任何报错。
// 所以 main.js 启动时调一次 install()，装完 claude 也调一次。
// 为此这文件改成了「既是脚本也是模块」：exports.install 给主进程用，
// 直接 `node hooks/install.js` 跑还是老样子。
//
// 【开机调 = 每次开机都跑，所以三条硬规矩】
//   1. 算出来的内容跟盘上一样就**一个字节都不写、不备份**。不然每次开机
//      多一个 settings.json.waifu-backup-* 文件，一年下来几百个。
//   2. 认「哪条是我们的」不能靠路径里有没有 WaifuCode 字样：用户能把包装到
//      D:\Apps\xiaoyi 这种目录。签名是**命令尾巴上的事件名**（notify.js <事件>）。
//   3. 没有真 node（原生安装的 claude 机器上没有 node.exe）时，写一个 .cmd
//      垫片把 electron.exe 掰成 node —— 垫片落在**数据目录**，安装目录可能只读。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const DEFAULT_NOTIFY = path.join(__dirname, 'notify.js');

// 这几个事件足够拼出「她在干什么」的全貌了，再多只会拖慢你敲代码。
//
// SessionEnd 是后补的：src/terminals.js 里早就写好了处理它的分支，
// 但这张表里一直没有它 —— 于是那段代码从来没被执行过，
// 「你把终端窗口关了」这件事她其实是靠心跳超时慢慢猜出来的。
// 装了它之后窗口一关就立刻知道。
// PreCompact 是后补的：上下文压缩 = 她开始忘事 + 账单大头的信号点，
// 装上它那一刻她才提醒得了你「该收尾开新线了」
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd', 'PreCompact'];

/**
 * 这一组 hook 是不是我们装的。
 *
 * 签名是「…notify.js" <事件名>」这个尾巴 —— 事件名是我们传给 notify.js 的参数，
 * 别的工具不会这么写。不看路径里有没有 WaifuCode：装到别的目录名下也要认得出，
 * 不然旧条目清不掉、越装越多。
 */
const OURS = new RegExp('notify\\.(?:js|cmd)"?\\s+(?:' + EVENTS.join('|') + ')\\s*$');
function isOurs(group) {
  if (!group || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((h) => typeof h.command === 'string' && OURS.test(h.command));
}

function entryFor(event, runner) {
  const cmd = runner + ' ' + event;
  // PreToolUse / PostToolUse 需要 matcher 才会对所有工具生效。
  // matcher 放前面 —— 老版本就是这个顺序，比较那步是按内容不按顺序的，
  // 但写出去的样子跟以前一致，diff 起来省心
  const group = (event === 'PreToolUse' || event === 'PostToolUse') ? { matcher: '*' } : {};
  group.hooks = [{ type: 'command', command: cmd, timeout: 5 }];
  return group;
}

/** 按内容比、不按键的顺序比 —— Claude Code 自己改设置时会把文件重写一遍，
 *  键的顺序可能变；顺序一变就当「不一样」重写 + 备份，等于每次都白折腾一回 */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * 拼「怎么跑 notify.js」那半截命令。
 *
 * 有真 node 就 `"node.exe" "notify.js"`。没有（原生安装的 claude 机器上常见）
 * 就写一个 .cmd 垫片：`set ELECTRON_RUN_AS_NODE=1` 再拉 electron.exe ——
 * 这是 term-shell 那条链早就在用的招（terminals.findNode 的 asNode）。
 * 垫片落在 wrapperDir（数据目录），安装目录可能是只读的。
 */
function runnerFor({ nodeBin, asNode, notify, wrapperDir }) {
  if (!asNode) return '"' + nodeBin + '" "' + notify + '"';
  if (!wrapperDir) throw new Error('没有真 node 又没给垫片目录');
  fs.mkdirSync(wrapperDir, { recursive: true });
  const cmdFile = path.join(wrapperDir, 'notify.cmd');
  // %* 把事件名原样透传；@echo off 免得 cmd 把命令回显进 hook 的 stdout
  // （notify.js 的铁律：绝不往 stdout 写东西，某些 hook 的 stdout 会回灌给模型）
  const body = '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"' + nodeBin + '" "' + notify + '" %*\r\n';
  let cur = null;
  try { cur = fs.readFileSync(cmdFile, 'utf8'); } catch (_) { /* 没有就写 */ }
  if (cur !== body) fs.writeFileSync(cmdFile, body, 'utf8');
  return '"' + cmdFile + '"';
}

/**
 * 装 / 卸。返回 { changed, added, removed, backup, settings, error }，**不抛不 exit**
 * —— 主进程开机调它，出错只能记一行，不能把桌宠拖死。
 *
 * @param {object} o
 * @param {string} o.settingsPath  默认 ~/.claude/settings.json（自检要指到临时文件）
 * @param {string} o.nodeBin       跑 notify.js 的可执行文件
 * @param {boolean} o.asNode       nodeBin 其实是 electron.exe，要靠 ELECTRON_RUN_AS_NODE
 * @param {string} o.notify        notify.js 的绝对路径
 * @param {string} o.wrapperDir    asNode 时 .cmd 垫片放哪
 * @param {boolean} o.remove       卸
 */
function install(o = {}) {
  const settingsPath = o.settingsPath || DEFAULT_SETTINGS;
  const notify = o.notify || DEFAULT_NOTIFY;
  const nodeBin = o.nodeBin || process.execPath;
  const remove = Boolean(o.remove);
  const out = { changed: false, added: 0, removed: 0, backup: null, settings: settingsPath, error: null };

  let settings = {};
  let raw = null;
  if (fs.existsSync(settingsPath)) {
    try {
      raw = fs.readFileSync(settingsPath, 'utf8');
      // 摘 BOM：PowerShell 5.1 的 utf8 带 BOM，JSON.parse 见了就炸（config.json 栽过）
      settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('顶层不是对象');
    } catch (err) {
      out.error = 'settings.json 解析不了，我不敢动它：' + err.message;
      return out;
    }
  } else if (remove) {
    return out; // 没文件，没什么可卸的
  }

  let runner = '';
  if (!remove) {
    try { runner = runnerFor({ nodeBin, asNode: Boolean(o.asNode), notify, wrapperDir: o.wrapperDir }); }
    catch (err) { out.error = err.message; return out; }
  }

  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks : {};
  const next = { ...settings, hooks: { ...hooks } };

  for (const ev of EVENTS) {
    const list = Array.isArray(next.hooks[ev]) ? next.hooks[ev] : [];
    // 先把我们自己的旧条目摘掉 —— 重复装不该越装越多，路径变了也顺手换新
    const cleaned = list.filter((g) => {
      if (isOurs(g)) { out.removed++; return false; }
      return true;
    });
    if (!remove) { cleaned.push(entryFor(ev, runner)); out.added++; }
    if (cleaned.length) next.hooks[ev] = cleaned;
    else delete next.hooks[ev];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;

  const text = JSON.stringify(next, null, 2) + '\n';
  // 规矩 1：内容没变就一个字节都不动（开机调用的前提）。按内容比不按顺序比
  if (raw !== null && canon(JSON.parse(raw.replace(/^﻿/, ''))) === canon(next)) {
    out.added = 0; out.removed = 0;
    return out;
  }

  try {
    if (raw !== null) {
      // 备份。改别人的总配置之前，永远先留条退路。
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      out.backup = settingsPath + '.waifu-backup-' + stamp;
      fs.writeFileSync(out.backup, raw, 'utf8');
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, text, 'utf8');
    out.changed = true;
  } catch (err) {
    out.error = '写不进去：' + err.message;
  }
  return out;
}

function cli() {
  const remove = process.argv.includes('--remove');
  // 手动跑的时候 process.execPath 就是 node 本尊
  const r = install({ remove, nodeBin: process.execPath });
  if (r.error) {
    console.error('✗ ' + r.error);
    if (r.error.includes('解析不了')) console.error('  请先自己修好 ' + r.settings + ' 再来。');
    process.exit(1);
  }
  if (r.backup) console.log('已备份原配置 -> ' + r.backup);
  if (remove) {
    console.log(r.changed ? '✓ 已卸载 ' + r.removed + ' 条 WaifuCode hook。你原有的配置一个字没动。'
                          : 'settings.json 里本来就没有 WaifuCode 的 hook。');
    return;
  }
  if (!r.changed) { console.log('✓ hook 已经是最新的，没动。'); return; }
  console.log('✓ 已装上 ' + r.added + ' 条 hook' + (r.removed ? '（顺手清掉 ' + r.removed + ' 条旧的）' : ''));
  console.log('  监听事件: ' + EVENTS.join(', '));
  console.log('  转发脚本: ' + DEFAULT_NOTIFY);
  console.log('');
  console.log('注意：新开的 Claude Code 会话才会生效，当前正在跑的窗口不受影响。');
  console.log('不想要了随时 npm run uninstall-hooks。');
}

module.exports = { install, isOurs, EVENTS, DEFAULT_SETTINGS };

if (require.main === module) cli();
