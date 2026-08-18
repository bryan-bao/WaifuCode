'use strict';

// Claude Code hook 的转发器。
//
// Claude Code 每触发一个 hook 就会拉起这个脚本一次，把事件 JSON 从 stdin 喂进来。
// 这里唯一的职责就是把它塞给桌宠的本地服务，然后立刻退出。
//
// 三条铁律（都是为了不拖累你正常敲代码）：
//   1. 无论如何都以 0 退出 —— 非 0 会被 Claude Code 当成 hook 失败，弹错误给你看
//   2. 超时必须短 —— 桌宠没开着的时候不能让 Claude Code 干等
//   3. 绝不往 stdout 写东西 —— 某些 hook 的 stdout 会被当作指令回灌给模型

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const EVENT = process.argv[2] || 'Unknown';
// 默认找桌宠自己的运行时文件；自测时用环境变量指到别处去，
// 免得测试事件汇报给正开着的那只真桌宠
const RUNTIME = process.env.WAIFU_RUNTIME_FILE || path.join(__dirname, '..', 'sessions', 'runtime.json');

function bail() {
  process.exit(0);
}

// 桌宠自己起的进程（后台派活、私聊）不用往回报：
// 那些活她本来就在直接盯着输出，再走一遍 hook 等于同一件事进两次账。
// 终端任务不在此列 —— 那些**只能**靠 hook 感知，所以带的是 WAIFU_TERM_ID。
if (process.env.WAIFU_SELF) bail();

let port = null;
try {
  port = JSON.parse(fs.readFileSync(RUNTIME, 'utf8')).port;
} catch (_) {
  bail(); // 桌宠没在跑，安静退出
}
if (!port) bail();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });

process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input || '{}');
  } catch (_) {
    payload = {};
  }
  payload.waifuEvent = EVENT;
  payload.waifuCwd = process.cwd();
  // hook 是 claude 的子进程，所以能读到 term-shell 给 claude 注入的这个变量。
  // 桌宠靠它把事件准确归到「哪个终端窗口」，而不是把你自己另开的窗口也算进来。
  payload.waifuTermId = process.env.WAIFU_TERM_ID || null;

  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 800,
    },
    (res) => { res.resume(); res.on('end', bail); }
  );

  req.on('error', bail);
  req.on('timeout', () => { req.destroy(); bail(); });
  req.write(body);
  req.end();
});

// stdin 迟迟不来也不能挂住 Claude Code
setTimeout(bail, 1500);
