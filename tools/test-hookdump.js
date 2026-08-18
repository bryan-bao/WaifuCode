'use strict';

// 把 hook 事件的完整 payload 摊开看一遍。
//
// 起因：交互式会话的 transcript 要等会话结束才落盘，Stop 的时候文件压根不存在，
// 「读 transcript 拿成果」这条路走不通。那就只能从 hook 事件本身榨信息 ——
// 得先知道它到底给了我们什么。
//
// 用 -p 跑（非交互、快、便宜），hook 的字段结构跟交互式是一样的。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { resolveClaudeBin } = require('../src/sessions');

const TMP = path.join(os.tmpdir(), 'waifu-hookdump');
fs.mkdirSync(TMP, { recursive: true });
const RUNTIME = path.join(TMP, 'runtime.json');
const DUMP = path.join(TMP, 'events.json');

const events = [];

// 值太长的截断，不然满屏都是文件内容
function shrink(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 160 ? v.slice(0, 160) + '…(' + v.length + '字)' : v;
  if (Array.isArray(v)) return depth > 2 ? '[…' + v.length + '项]' : v.slice(0, 3).map((x) => shrink(x, depth + 1));
  if (typeof v === 'object') {
    if (depth > 2) return '{…}';
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = shrink(val, depth + 1);
    return o;
  }
  return v;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try {
      const p = JSON.parse(body);
      events.push(p);
      const name = p.waifuEvent || p.hook_event_name;
      console.log('\n\x1b[36m▼ ' + name + '\x1b[0m  (termId=' + (p.waifuTermId || '无') + ')');
      console.log('  顶层字段: ' + Object.keys(p).join(', '));
      for (const [k, v] of Object.entries(p)) {
        if (k === 'waifuEvent' || k === 'waifuCwd' || k === 'waifuTermId') continue;
        console.log('    ' + k + ': ' + JSON.stringify(shrink(v)));
      }
    } catch (err) {
      console.log('解析失败: ' + err.message);
    }
    res.writeHead(204);
    res.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync(RUNTIME, JSON.stringify({ port, pid: process.pid }, null, 2), 'utf8');
  console.log('收事件的服务: 127.0.0.1:' + port);
  console.log('');

  const bin = resolveClaudeBin();
  const proc = spawn(
    bin,
    ['-p', '读一下 package.json，用一句话告诉我这个项目叫什么名字。',
     '--permission-mode', 'acceptEdits', '--max-budget-usd', '0.30'],
    {
      cwd: path.join(__dirname, '..'),
      windowsHide: true,
      env: {
        ...process.env,
        WAIFU_RUNTIME_FILE: RUNTIME,
        WAIFU_TERM_ID: 'dumptest', // 冒充一个终端任务，看 hook 能不能带回来
        WAIFU_SELF: '',            // 这次要让它上报，别被自己人的过滤挡掉
      },
    }
  );

  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.on('close', (code) => {
    setTimeout(() => {
      console.log('\n' + '─'.repeat(58));
      console.log('claude 退出 code=' + code);
      console.log('它说: ' + out.trim().slice(0, 200));
      console.log('');
      console.log('一共收到 ' + events.length + ' 个 hook 事件: ' +
        events.map((e) => e.waifuEvent).join(' → '));
      fs.writeFileSync(DUMP, JSON.stringify(events, null, 2), 'utf8');
      console.log('完整 payload 存到: ' + DUMP);
      server.close();
      process.exit(0);
    }, 1200); // 等最后几个 hook 把包发完
  });
});
