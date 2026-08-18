'use strict';

// 验终端这条链路：能不能用 Windows Terminal 开出一个像样的窗口，
// 开完之后还能不能用代码把它捞回最前面。
//
// 会弹一个真窗口出来，它自己会在 12 秒后退出 —— 这里不去 kill 任何进程。

const { spawn, execFile } = require('child_process');
const path = require('path');
const { findWt, findNode } = require('../src/terminals');

const WINDOW = 'waifu-selftest';
const TITLE = 'WaifuCode · 自检窗口';
const FOCUS_PS1 = path.join(__dirname, 'focus-window.ps1');

function run(bin, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(err.message + ' ' + (stderr || '')));
      resolve(String(stdout || ''));
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const wt = findWt();
  const node = findNode();

  console.log('Windows Terminal : ' + (wt || '没找到'));
  console.log('node             : ' + node.bin + (node.asNode ? ' (要靠 ELECTRON_RUN_AS_NODE)' : ''));
  console.log('');

  if (!wt) {
    console.log('没有 wt.exe，会回落到老式控制台。这台机器上测不了 wt 这条路。');
    process.exit(0);
  }

  console.log('[1] 开一个具名窗口（它会自己数 12 秒然后退出）');
  const args = [
    '-w', WINDOW,
    'new-tab',
    '--title', TITLE,
    '-d', path.join(__dirname, '..'),
    'cmd', '/c', 'echo WaifuCode 自检窗口，12 秒后自己关。 && timeout /t 12',
  ];
  console.log('    wt ' + args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '));

  const child = spawn(wt, args, { detached: true, windowsHide: false });
  child.unref();
  child.on('error', (e) => console.log('    \x1b[31m起不来: ' + e.message + '\x1b[0m'));

  await wait(2500);

  console.log('');
  console.log('[2] 用 wt -w ' + WINDOW + ' focus-tab 把它调到最前面');
  try {
    await run(wt, ['-w', WINDOW, 'focus-tab']);
    console.log('    \x1b[32m命令没报错\x1b[0m（wt 就算窗口不在也会安静返回，所以还得核一下）');
  } catch (err) {
    console.log('    \x1b[31m失败: ' + err.message + '\x1b[0m');
  }

  await wait(800);

  console.log('');
  console.log('[3] 用 user32 按标题找，核实窗口确实存在且能置顶');
  try {
    const out = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', FOCUS_PS1, '-Title', TITLE,
    ], 15000);
    const line = out.trim().split('\n')[0];
    if (/^OK/.test(line)) console.log('    \x1b[32m✓ 找到了，也置顶了\x1b[0m: ' + line.trim());
    else if (/NOTFOUND/.test(line)) console.log('    \x1b[33m× 没找到这个标题的窗口\x1b[0m —— wt 可能把标题改了');
    else console.log('    \x1b[33m× ' + line.trim() + '\x1b[0m');
  } catch (err) {
    console.log('    \x1b[31m失败: ' + err.message + '\x1b[0m');
  }

  console.log('');
  console.log('[4] 列一下现在所有可见窗口的标题，看 wt 到底把标题设成了什么');
  try {
    const out = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | " +
      "Select-Object -ExpandProperty MainWindowTitle",
    ], 15000);
    out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((t) => console.log('    · ' + t));
  } catch (err) {
    console.log('    (列不出来: ' + err.message + ')');
  }

  console.log('');
  console.log('测试窗口会自己关，不用管它。');
})();
