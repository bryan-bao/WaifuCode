'use strict';

// 「监督」这条链路的端到端自检。
//
// 走的是真路径：真开一个 Windows Terminal 窗口、真起一个 claude 交互会话、
// 真等它触发 hook。要验的是这几件事一环扣一环地成立：
//
//   开窗口 → term-shell 报到 → claude 起来了 → hook 带着 termId 回来
//   → 她干完一段 → 我们能从 transcript 里读出「刚才干了什么」→ 汇报出来
//
// 这里起一个自己的小服务收事件，并把 runtime 指向临时文件，
// 所以不会打扰你正开着的那只桌宠。
//
// 会真调一次 API（几分钱）。跑完那个终端窗口会**留着**——它本来就是给你的，
// 你可以接着在里面干活，也可以自己关掉。这个脚本不会去动它。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { TerminalManager } = require('../src/terminals');
const { resolveClaudeBin } = require('../src/sessions');

const TMP = path.join(os.tmpdir(), 'waifu-supervise-test');
fs.mkdirSync(TMP, { recursive: true });
const RUNTIME = path.join(TMP, 'runtime.json');

// 给她一个暗号。汇报里带着这个暗号，才能证明读到的确实是**她**说的话 ——
// 之前踩过一次：兜底逻辑挑了目录里最近改过的文件，结果汇报的是用户自己
// 另一个会话里的内容，四项全绿但内容是别人的。
const MARK = 'XYZZY-7788';
const TASK = '请只回答一句话，并在这句话里原样带上这个暗号：' + MARK + '。不要用任何工具。';

const seen = { open: false, hook: false, stop: false, report: false, right: false };
const t0 = Date.now();

function stamp() {
  return '\x1b[90m[' + String(Math.round((Date.now() - t0) / 1000)).padStart(3) + 's]\x1b[0m ';
}

const terminals = new TerminalManager({
  storeDir: TMP,
  runtimeFile: RUNTIME,
  claudeBin: resolveClaudeBin(),
  getConfig: () => ({ terminal: { app: 'auto' }, supervise: { enabled: true, speak: false, minGapSec: 0 } }),
  log: (m) => console.log(stamp() + '\x1b[90m' + m + '\x1b[0m'),
});

terminals.on('change', () => {
  const t = terminals.list()[0];
  if (t) console.log(stamp() + '状态 → \x1b[36m' + t.status + '\x1b[0m  轮次=' + t.turns + ' 工具=' + t.toolCount);
});

terminals.on('report', (e) => {
  seen.report = true;
  const right = String(e.text).includes(MARK);
  if (right) seen.right = true;

  console.log('');
  console.log(stamp() + '\x1b[32m★ 阶段汇报来了\x1b[0m');
  console.log('    「' + String(e.text).replace(/\s+/g, ' ').slice(0, 200) + '」');
  console.log('    这轮的活: ' + (e.task || '?'));
  if (e.files && e.files.length) console.log('    动过的文件: ' + e.files.join('、'));
  console.log('    ' + (right
    ? '\x1b[32m暗号对得上，确实是她说的话\x1b[0m'
    : '\x1b[31m暗号对不上！读到的是别人的话，串台了\x1b[0m'));
  console.log('');
});

terminals.on('attention', (e) => {
  console.log(stamp() + '\x1b[33m! 在等你确认: ' + e.text + '\x1b[0m');
});

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body); } catch (_) { /* 忽略脏数据 */ }

    if (req.url === '/term') {
      if (p.phase === 'open') {
        seen.open = true;
        console.log(stamp() + '\x1b[32m✓ term-shell 报到了\x1b[0m  pid=' + p.pid);
      } else if (p.phase === 'close') {
        console.log(stamp() + 'term-shell 说它结束了 code=' + p.code);
      }
      terminals.onShellEvent(p);
    } else if (req.url === '/hook') {
      const name = p.waifuEvent || p.hook_event_name;
      if (p.waifuTermId) {
        if (!seen.hook) {
          seen.hook = true;
          console.log(stamp() + '\x1b[32m✓ hook 带回了 termId=' + p.waifuTermId + '\x1b[0m');
        }
        if (name === 'Stop') {
          seen.stop = true;
          console.log(stamp() + '\x1b[32m✓ Stop 事件到了\x1b[0m  transcript=' +
            (p.transcript_path ? path.basename(p.transcript_path) : '\x1b[31m没给\x1b[0m'));
        }
      } else {
        console.log(stamp() + '\x1b[90m(一条没带 termId 的 hook: ' + name + ')\x1b[0m');
      }
      terminals.onHookEvent(p);
    }

    res.writeHead(204);
    res.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync(RUNTIME, JSON.stringify({ port, pid: process.pid }, null, 2), 'utf8');

  console.log('自检服务   127.0.0.1:' + port);
  console.log('claude     ' + resolveClaudeBin());
  console.log('临时目录   ' + TMP);
  console.log('');
  console.log('要她干的活：' + TASK);
  console.log('');

  const r = terminals.open({
    projectPath: path.join(__dirname, '..'),
    task: TASK,
    sessionId: crypto.randomUUID(),
    resume: false,
    name: '自检',
    port,
  });
  console.log(stamp() + '开了窗口 ' + r.id + '，等她干活…');
  console.log('');
});

// 到点收工。不去动那个终端窗口 —— 它是留给你的。
setTimeout(() => {
  console.log('');
  console.log('─'.repeat(56));
  const ok = (k, label) => console.log('  ' + (seen[k] ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  ok('open', 'term-shell 报到（说明窗口和包装层都起来了）');
  ok('hook', 'hook 带回了 termId（说明认得出是哪个终端）');
  ok('stop', 'Stop 事件（说明抓得到「一段做完了」这个时机）');
  ok('report', '阶段汇报（说明从 transcript 里读出了成果）');
  ok('right', '汇报内容确实是她说的（暗号 ' + MARK + ' 对得上，没串台）');
  console.log('─'.repeat(56));
  console.log('那个终端窗口留着没动，你可以接着用，也可以自己关掉。');

  terminals.dispose();
  server.close();
  process.exit(Object.values(seen).every(Boolean) ? 0 : 1);
}, 45 * 1000);
