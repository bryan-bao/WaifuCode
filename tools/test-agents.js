'use strict';

// codex 那条线的自检（离线，几百毫秒跑完）。守四件事：
//
//   1. 权限映射：claude 的模式名 → codex 的 -a/-s 两个旋钮，宁紧勿松 ——
//      **永远不许**映射出 danger-full-access 或那个 --dangerously-bypass 开关
//   2. 小抄拼进开场 prompt 的规矩：有活才拼、没活一个 prompt 都不发（发了就是替
//      用户开跑一轮，花的是他 OpenAI 的钱）、小抄读不到就当没有
//   3. term-shell 里那几处分岔别被人顺手删了（跟 test-termlife 钉引号一个套路）
//   4. 关窗去留：codex 的线收不到 hook，turns 恒 0 —— 派过活的必须留成「已完成」
//      （不留「再来」永远不出现），而 claude 那边的老规矩一个字不许变

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const agents = require(path.join(ROOT, 'src', 'agents.js'));
const { TerminalManager } = require(path.join(ROOT, 'src', 'terminals.js'));

let failed = 0;
function check(cond, msg) {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + msg);
  if (!cond) failed++;
}

const TMP = path.join(os.tmpdir(), 'waifu-test-agents-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });

console.log('\n[1] 权限映射：claude 的模式名 → codex 的两个旋钮');
{
  const flags = (mode) => agents.codexArgs({ permissionMode: mode, task: '' }).join(' ');
  check(flags('auto') === '-a on-request -s workspace-write', 'auto → 问它自己看，沙箱圈在项目里');
  check(flags('acceptEdits') === '-a on-request -s workspace-write', 'acceptEdits → 同上（codex 没有更贴的档位）');
  check(flags('plan') === '-a untrusted -s read-only', 'plan → 只读沙箱，一个字都改不了');
  check(flags('dontAsk') === '-a never -s workspace-write', 'dontAsk → 别问了，但沙箱还圈着');
  check(flags('manual') === '-a untrusted -s workspace-write', 'manual → 什么都问');
  check(flags('瞎写的') === flags('auto'), '不认识的模式落回 auto，不许裸奔');
  check(flags(undefined) === flags('auto'), '没给模式也落回 auto');
}

console.log('\n[2] 永远不许松开的那两道闸');
{
  for (const mode of ['auto', 'acceptEdits', 'plan', 'dontAsk', 'manual', '随便']) {
    const all = agents.codexArgs({ permissionMode: mode, task: 'x' }).join(' ');
    check(!all.includes('danger-full-access') && !all.includes('dangerously'),
          mode + ' → **没有** danger-full-access / --dangerously-bypass');
  }
  const all = agents.codexArgs({ permissionMode: 'auto', task: 'x', model: 'gpt-x' }).join(' ');
  check(!all.includes('--setting-sources'), '不带 --setting-sources（那是 claude 链的禁词，这儿也别沾）');
  check(!all.includes('--append-system-prompt-file'), '不带 --append-system-prompt-file（codex 不认，带了当场起不来）');
}

console.log('\n[3] 小抄拼进开场 prompt 的规矩');
{
  const memoFile = path.join(TMP, 'memo.md');
  fs.writeFileSync(memoFile, '# 小抄\n- 上次改到 login.js', 'utf8');

  const a = agents.codexArgs({ permissionMode: 'auto', task: '接着修', notesFile: memoFile });
  const prompt = a[a.length - 1];
  check(prompt.includes('上次改到 login.js') && prompt.includes('接着修'),
        '有活：小抄内容 + 任务拼成一个 prompt');
  check(a.filter((x) => x.includes('接着修')).length === 1, '任务只出现一次（没有重复的 positional）');

  const b = agents.codexArgs({ permissionMode: 'auto', task: '', notesFile: memoFile });
  check(b.length === 4 && b.every((x) => x.startsWith('-') || ['on-request', 'workspace-write'].includes(x)),
        '**没活就一个 prompt 都不发** —— 递过去等于替用户开跑一轮，那是花钱的事');

  const c = agents.codexArgs({ permissionMode: 'auto', task: '干活', notesFile: path.join(TMP, '不存在.md') });
  check(c[c.length - 1] === '干活', '小抄读不到 → 任务原样发，跟全新项目一个样');

  const d = agents.codexArgs({ permissionMode: 'auto', task: '干活', model: 'gpt-test' });
  check(d.join(' ').includes('-m gpt-test'), '给了模型才带 -m（管道留着，面板上现在不选）');
  const e = agents.codexArgs({ permissionMode: 'auto', task: '干活' });
  check(!e.includes('-m'), '没给模型就不带 -m，跟 ~/.codex/config.toml 走');
}

console.log('\n[4] 找 codex 的可执行文件');
{
  const fake = path.join(TMP, 'codex.cmd');
  fs.writeFileSync(fake, '@echo off\r\n', 'utf8');
  const old = process.env.WAIFU_CODEX_BIN;
  process.env.WAIFU_CODEX_BIN = fake;
  check(agents.resolveCodexBin() === fake, 'WAIFU_CODEX_BIN 指哪儿用哪儿');
  process.env.WAIFU_CODEX_BIN = path.join(TMP, '没有这个文件.exe');
  check(agents.resolveCodexBin() !== path.join(TMP, '没有这个文件.exe'),
        '环境变量指了个不存在的，当没设（回落 PATH）');
  if (old === undefined) delete process.env.WAIFU_CODEX_BIN;
  else process.env.WAIFU_CODEX_BIN = old;
  check(typeof agents.resolveCodexBin() === 'string' && agents.resolveCodexBin().length > 0,
        '兜底也得给个字符串（guard 在上游拦「没装」）');
}

console.log('\n[5] term-shell 里的分岔别被人顺手删了');
{
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'term-shell.js'), 'utf8');
  check(src.includes("spec.agent === 'codex'"), 'buildArgs 里有 codex 的岔路');
  check(src.includes('spec.bin || spec.claudeBin'), 'launch 认 spec.bin（codex 的可执行文件走这儿）');
  check(src.includes('codexArgs'), '参数拼法确实是从 src/agents.js 取的');
  check(/replace\(\/\\r\?\\n\/g, ' '\)/.test(src),
        'quoteArg 把换行折成空格 —— cmd 的命令行里换行**没有转义写法**，会被当成第二条命令');
}

console.log('\n[6] 关窗去留：codex 的线 turns 恒 0，派过活的必须留下');
{
  const specOf = (id, extra) => ({
    id, name: 'x', dir: TMP, task: '', sessionId: 's-' + id,
    windowName: 'waifu-' + id, title: 'WaifuCode · x', ...extra,
  });
  const tm = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });

  // codex + 派了活 + 真起来过（有 pid）+ turns 0 → 留成「已完成」（「再来」靠它）
  tm.items.set('c1', tm._makeRecord(specOf('c1', { agent: 'codex', task: '修登录' }), { pid: process.pid }));
  tm._windowGone(tm.items.get('c1'), '测试');
  check(tm.items.has('c1') && tm.items.get('c1').status === 'closed',
        '**codex 派过活 → 转已完成留着**（它收不到 hook，turns 永远是 0）');

  // codex 派了活但 term-shell 从没报到过（pid 和心跳都空）→ 那是夭折不是干完，删
  tm.items.set('c0', tm._makeRecord(specOf('c0', { agent: 'codex', task: '修登录' })));
  tm._windowGone(tm.items.get('c0'), '测试');
  check(!tm.items.has('c0'),
        '**从没报到过的夭折线 → 删掉**，不许冒充「已完成」骗出「再来」（评审抓的）');

  // 只打过心跳没等到 pid（认回来的线）也算起来过
  tm.items.set('cb', tm._makeRecord(specOf('cb', { agent: 'codex', task: 'x' }), { lastBeat: Date.now() }));
  tm._windowGone(tm.items.get('cb'), '测试');
  check(tm.items.has('cb') && tm.items.get('cb').status === 'closed',
        '只有心跳没有 pid（重启认回来的线）→ 也算真起来过，留着');

  // codex 空终端（没派活）→ 照旧直接去掉
  tm.items.set('c2', tm._makeRecord(specOf('c2', { agent: 'codex', task: '' })));
  tm._windowGone(tm.items.get('c2'), '测试');
  check(!tm.items.has('c2'), 'codex 没派活的空终端 → 直接去掉');

  // claude 的老规矩一个字不许变：没聊过、没汇报过 → 去掉（哪怕带着任务）
  tm.items.set('c3', tm._makeRecord(specOf('c3', { task: '修登录' })));
  tm._windowGone(tm.items.get('c3'), '测试');
  check(!tm.items.has('c3'), 'claude 线 turns=0 没汇报 → 照旧去掉（老规矩没被这次改动碰着）');

  // list() 把 agent 带出来，面板靠它打小牌；老记录没这字段就是 claude
  tm.items.set('c4', tm._makeRecord(specOf('c4', { agent: 'codex', task: 'x' })));
  tm.items.set('c5', tm._makeRecord(specOf('c5', {})));
  const byId = Object.fromEntries(tm.list().map((t) => [t.id, t]));
  check(byId.c4.agent === 'codex' && byId.c5.agent === 'claude',
        'list() 带出 agent，没这字段的老记录当 claude');

  tm.dispose();
}

console.log('');
if (failed) {
  console.log('\x1b[31m✗ ' + failed + ' 条没过\x1b[0m');
  process.exitCode = 1;
} else {
  console.log('\x1b[32m✓ 全过\x1b[0m');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 临时目录留着也无妨 */ }
