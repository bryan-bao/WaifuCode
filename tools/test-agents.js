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

console.log('\n[7] 接着聊：resume 是子命令、排最前，而且只在认领过会话时才接');
{
  const uuid = '019a6175-e35e-7dc2-9c43-66285d92da22';
  const spec = { permissionMode: 'auto', task: '继续干', codexSessionId: uuid };
  const a = agents.codexArgs(spec, true);
  check(a[0] === 'resume' && a[1] === uuid, 'resume <uuid> 排在最前（子命令的位置）');
  check(!agents.codexArgs(spec, false).includes('resume'), '不是接着聊就不带 resume');
  check(!agents.codexArgs({ permissionMode: 'auto', task: 'x' }, true).includes('resume'),
        '没认领过会话（没 codexSessionId）→ 就算要 resume 也不带，老实开新的');

  const memoFile = path.join(TMP, 'memo2.md');
  fs.writeFileSync(memoFile, '- 上次的进度', 'utf8');
  const b = agents.codexArgs({ permissionMode: 'auto', task: '继续', codexSessionId: uuid, notesFile: memoFile }, true);
  check(!b.join(' ').includes('上次的进度'),
        '**接着聊不拼小抄** —— 会话里上下文本来就在，再塞一遍是白花钱');
}

console.log('\n[8] 捞会话：cwd + 启动时间配对，别人认领过的不抢');
{
  const PROJ = path.join(TMP, 'MyProj');
  fs.mkdirSync(PROJ, { recursive: true });
  const root = path.join(TMP, 'codex-sessions');
  const p2 = (n) => String(n).padStart(2, '0');
  const dayDir = (ms) => {
    const d = new Date(ms);
    return path.join(root, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  };
  const metaLine = (id, cwd, pad) => JSON.stringify({
    timestamp: 'x', ordinal: 0, type: 'session_meta',
    payload: { session_id: id, id, cwd, originator: 'codex-tui', pad: pad || '' },
  });
  const now = Date.now();
  const since = now - 1000;

  // 今天目录里一份，cwd 大小写还故意不一样
  const idA = '019a0000-0000-7000-8000-000000000aaa';
  fs.mkdirSync(dayDir(since), { recursive: true });
  fs.writeFileSync(path.join(dayDir(since), 'rollout-x-a.jsonl'),
    metaLine(idA, PROJ.toUpperCase()) + '\n', 'utf8');

  const hit = agents.findCodexSession({ dir: PROJ.toLowerCase(), sinceMs: since, root });
  check(hit && hit.sessionId === idA, '按 cwd 配上了（大小写不敏感）');

  check(agents.findCodexSession({ dir: PROJ, sinceMs: since, root, claimed: new Set([idA]) }) === null,
        '**被别的线认领过的 id 不抢**（同目录并行开两条不会共用一个会话）');
  check(agents.findCodexSession({ dir: PROJ, sinceMs: now + 60000, root }) === null,
        '文件比启动时间还早 → 不认（用户自己以前开的翻不出来）');
  check(agents.findCodexSession({ dir: path.join(TMP, '别的项目'), sinceMs: since, root }) === null,
        'cwd 对不上 → 不认');

  // 跨零点：文件躺在「昨天」的日期目录里（会话按开始那天归档）
  const idB = '019a0000-0000-7000-8000-000000000bbb';
  const yest = dayDir(since - 86400000);
  fs.mkdirSync(yest, { recursive: true });
  fs.writeFileSync(path.join(yest, 'rollout-x-b.jsonl'),
    metaLine(idB, path.join(TMP, '跨零点')) + '\n', 'utf8');
  const hitB = agents.findCodexSession({ dir: path.join(TMP, '跨零点'), sinceMs: since, root });
  check(hitB && hitB.sessionId === idB, '跨零点：昨天的日期目录也翻（半夜开的窗口配得上）');

  // 第一行动辄二三十 KB（整份系统提示词嵌在里面）—— 关键字段在头 8KB 就够
  const idC = '019a0000-0000-7000-8000-000000000ccc';
  fs.writeFileSync(path.join(dayDir(since), 'rollout-x-c.jsonl'),
    metaLine(idC, path.join(TMP, '大头'), 'X'.repeat(30000)) + '\n', 'utf8');
  const hitC = agents.findCodexSession({ dir: path.join(TMP, '大头'), sinceMs: since, root });
  check(hitC && hitC.sessionId === idC, '第一行超长（30KB 系统提示词）也认得出 —— 只抠头 8KB');

  // 正向跨零点：23:59 派活、codex 零点后落盘 → 文件进「明天」的目录（评审抓的）
  const idD = '019a0000-0000-7000-8000-000000000ddd';
  const tomorrow = dayDir(since + 86400000);
  fs.mkdirSync(tomorrow, { recursive: true });
  fs.writeFileSync(path.join(tomorrow, 'rollout-x-d.jsonl'),
    metaLine(idD, path.join(TMP, '贴零点')) + '\n', 'utf8');
  const hitD = agents.findCodexSession({ dir: path.join(TMP, '贴零点'), sinceMs: since, root });
  check(hitD && hitD.sessionId === idD,
        '**「明天」的目录也翻** —— 23:59 派活零点后落盘，不翻就永远认领不到');

  // expectId：接着聊的窗口只认自己那条，别人的（哪怕更早）一概不碰
  const idE1 = '019a0000-0000-7000-8000-000000000ee1';
  const idE2 = '019a0000-0000-7000-8000-000000000ee2';
  const eDir = path.join(TMP, '只认自己');
  fs.writeFileSync(path.join(dayDir(since), 'rollout-x-e1.jsonl'), metaLine(idE1, eDir) + '\n', 'utf8');
  fs.writeFileSync(path.join(dayDir(since), 'rollout-x-e2.jsonl'), metaLine(idE2, eDir) + '\n', 'utf8');
  const hitE = agents.findCodexSession({ dir: eDir, sinceMs: since, root, expectId: idE2 });
  check(hitE && hitE.sessionId === idE2,
        '**expectId 只认那一条** —— 接着聊的窗口不许抢同目录新线刚落盘的会话');
  check(agents.findCodexSession({ dir: eDir, sinceMs: since, root, expectId: '019a0000-0000-7000-8000-00000000none' }) === null,
        'expectId 对不上任何文件 → 空手而归，不拿别人的凑数');
}

console.log('\n[9] 算钱：只认最后一条累计值，半行不上账，认不出的模型宁可报高');
{
  const tc = (input, cached, output) => JSON.stringify({
    timestamp: 'x', type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
      output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
    } } },
  });
  const ctx = (model) => JSON.stringify({
    timestamp: 'x', type: 'turn_context', payload: { turn_id: 'x', model },
  });

  const f1 = path.join(TMP, 'roll1.jsonl');
  // 两条 token_count：钱 = 只按**最后一条**（累计值），不是两条相加
  fs.writeFileSync(f1, [ctx('gpt-5.6-sol'), tc(1000, 0, 100), tc(100000, 40000, 2000)].join('\n') + '\n', 'utf8');
  const u1 = agents.codexUsage(f1);
  // (60000×$5 + 40000×$0.5 + 2000×$30) / 1e6 = 0.38
  check(Math.abs(u1.usd - 0.38) < 1e-9, 'gpt-5.6-sol：$' + u1.usd.toFixed(2) + '（缓存命中一折，只认最后一条累计）');
  check(u1.model === 'gpt-5.6-sol', '模型名从 turn_context 里拿');

  // 结尾一条正写到一半的（半行）：不上账，用上一条完整的
  fs.appendFileSync(f1, '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":999999999');
  check(Math.abs(agents.codexUsage(f1).usd - 0.38) < 1e-9, '**半行不上账** —— 接着往上找上一条完整的');

  const f2 = path.join(TMP, 'roll2.jsonl');
  fs.writeFileSync(f2, [ctx('gpt-9-mystery'), tc(1000000, 0, 0)].join('\n') + '\n', 'utf8');
  check(Math.abs(agents.codexUsage(f2).usd - 5) < 1e-9, '认不出的模型按旗舰 $5/$30 算 —— 宁可报高');

  const f3 = path.join(TMP, 'roll3.jsonl');
  fs.writeFileSync(f3, [ctx('gpt-5.4-mini'), tc(1000000, 0, 0)].join('\n') + '\n', 'utf8');
  check(Math.abs(agents.codexUsage(f3).usd - 0.5) < 1e-9, 'mini 不按主号价冤枉（宽松上限 $0.5/$4）');

  check(agents.codexUsage(path.join(TMP, '没有.jsonl')) === null,
        '**文件读不出来 → null**，跟「真没花钱」分开（读失败那下不许把算好的抹成 0）');
  check(agents.codexPriceFor('gpt-5.1-codex').in === 1.25, 'gpt-5.1-codex 走 gpt-5.1 的价（前缀）');
  check(agents.codexPriceFor('gpt-5.6-luna').out === 1.2, 'gpt-5.6-luna 有自己那档小价');

  // 基线按 token 记：接着聊续写同一份文件、中途换过模型 → 差值按**当前**模型定价。
  // 基线记美元的话（旧模型贵、新模型便宜），差值会被价目差压成 0 —— 报低，不许
  const f4 = path.join(TMP, 'roll4.jsonl');
  fs.writeFileSync(f4, [ctx('gpt-5.4'), tc(2000000, 0, 0)].join('\n') + '\n', 'utf8');
  const u4 = agents.codexUsage(f4, { input_tokens: 1000000, cached_input_tokens: 0, output_tokens: 0 });
  check(Math.abs(u4.usd - 2.5) < 1e-9,
        '**基线按 token 相减、差值按当前模型定价**：多烧的 100 万 token × gpt-5.4 = $2.50');
  check(u4.totals && u4.totals.input_tokens === 2000000, 'totals 一起带出来（开窗时拿它当基线）');

  // 8MB 尾读那条路（评审抓的零覆盖）：垫 8MB 的废行，token_count 在最后
  const f5 = path.join(TMP, 'roll5.jsonl');
  const pad = JSON.stringify({ type: 'event_msg', payload: { type: 'noise', x: 'P'.repeat(4000) } });
  const w = fs.openSync(f5, 'w');
  fs.writeSync(w, ctx('gpt-5.6-sol') + '\n');
  for (let i = 0; i < 2200; i++) fs.writeSync(w, pad + '\n'); // ≈ 8.8MB
  fs.writeSync(w, tc(100000, 40000, 2000) + '\n');
  fs.closeSync(w);
  check(fs.statSync(f5).size > 8 * 1024 * 1024, '（构造出的文件确实超过 8MB）');
  const u5 = agents.codexUsage(f5);
  check(u5 && Math.abs(u5.usd - 0.38) < 1e-9, '**超大文件走尾读那条路**，掐头半行后照样算对');
}

console.log('\n[10] 认领的规矩（_codexPeek 那一层）');
{
  const specOf = (id, extra) => ({
    id, name: 'x', dir: TMP, task: '干活', sessionId: 's-' + id,
    windowName: 'waifu-' + id, title: 'WaifuCode · x', agent: 'codex', ...extra,
  });
  const tm = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
  const realFind = agents.findCodexSession;
  const calls = [];
  agents.findCodexSession = (opts) => { calls.push(opts); return null; };

  try {
    // 接着聊的窗口：只带着自己的 id 去找（expectId），不许摸别人的
    const rA = tm._makeRecord(specOf('pk1', { codexSessionId: 'old-id', codexFile: 'x' }), { pid: 1 });
    tm.items.set('pk1', rA);
    tm._codexPeek(rA, Date.now());
    check(calls.length === 1 && calls[0].expectId === 'old-id',
          '接着聊的窗口带 expectId 去找 —— 只认自己那条');

    // 认领过的（spec 里 codexClaimed:true，重启认回来）：一次都不再找
    calls.length = 0;
    const rB = tm._makeRecord(specOf('pk2', { codexSessionId: 'done-id', codexFile: 'x', codexClaimed: true }), { pid: 1 });
    tm.items.set('pk2', rB);
    tm._codexPeek(rB, Date.now());
    check(calls.length === 0,
          '**认领状态落了盘就不再开抢** —— 重启认回来的窗口不许把对的绑定改成别人的');

    // 同目录让先：晚开的新线要等早开的先认（配对按开窗顺序，别倒挂）
    calls.length = 0;
    const now = Date.now();
    const rOld = tm._makeRecord(specOf('pk3'), { pid: 1 });
    rOld.startedAt = now - 10000;
    const rNew = tm._makeRecord(specOf('pk4'), { pid: 1 });
    rNew.startedAt = now - 5000;
    tm.items.set('pk3', rOld);
    tm.items.set('pk4', rNew);
    tm._codexPeek(rNew, now);
    check(calls.length === 0, '**晚开的让早开的先认** —— 两条新线不许倒挂着配对');
    tm._codexPeek(rOld, now);
    check(calls.length === 1, '早开的照常去找');
  } finally {
    agents.findCodexSession = realFind;
    tm.dispose();
  }
}

console.log('\n[11] 读档案（增量）：她靠这个知道 codex 这一段干了什么');
{
  const L = (type, payload) => JSON.stringify({ timestamp: 'x', type, payload });
  const rf = path.join(TMP, 'glance.jsonl');
  const half = '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"半行'; // 没写完，没换行
  fs.writeFileSync(rf, [
    L('event_msg', { type: 'user_message', message: '把校验修好' }),
    L('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["rg","x"]}' }),
    // 工具的**输出**不算一次工具（字符串粗筛必须靠右引号区分 function_call 和 …_output）
    L('response_item', { type: 'function_call_output', call_id: 'c', output: '{"type":"task_complete"}' }),
    L('response_item', { type: 'custom_tool_call', name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: src/b.js\n*** End Patch' }),
    // function_call 形态的 apply_patch：arguments 是没解码的内层 JSON —— 得先 parse 再抠
    L('response_item', { type: 'function_call', name: 'apply_patch',
      arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/c.js\n*** End Patch' }) }),
    L('event_msg', { type: 'error', message: '断了一下' }),
    L('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: '修好了，跑过自检' }),
    L('event_msg', { type: 'task_complete', turn_id: 't2', last_agent_message: null }),
  ].join('\n') + '\n' + half, 'utf8');

  const g = agents.codexGlance(rf, 0);
  check(g.turns === 2, '两轮（task_complete ×2，半行那条不算）');
  check(g.toolCount === 3, '三次工具（shell + 两种形态的 apply_patch；工具输出不算）');
  check(g.errors === 1, '一次报错');
  check(g.lastSaid === '修好了，跑过自检', '她要念的原话（出错那轮是 null，不覆盖）');
  check(g.lastPrompt === '把校验修好', '这轮用户要的是什么（老版 user_message 形状）');
  check(g.files['src/a.js'] === 1 && g.files['src/b.js'] === 1, '补丁里抠出动过的文件');
  check(g.files['src/c.js'] === 1 && !Object.keys(g.files).some((k) => k.includes('@@')),
        '**function_call 形态先解码再抠** —— 不在带转义的原文上跑正则（评审抓的）');
  check(g.nextOffset === fs.statSync(rf).size - Buffer.byteLength(half, 'utf8'),
        '**偏移停在半行前面** —— 正写到一半的那行留给下一拍');

  // 把半行补完，从上次的偏移接着读：只看到新完成的这一轮
  fs.appendFileSync(rf, '"}}\n' +
    L('response_item', { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>machine stuff</environment_context>' }] }) + '\n' +
    L('response_item', { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '再把样式改改' }] }) + '\n' +
    L('event_msg', { type: 'task_complete', turn_id: 't3', last_agent_message: '样式改好了' }) + '\n');
  const g2 = agents.codexGlance(rf, g.nextOffset);
  check(g2.turns === 2 && g2.lastSaid === '样式改好了',
        '**增量接着读**：半行补完算一轮，新一轮也算，前面读过的不重算');
  check(g2.lastPrompt === '再把样式改改',
        '新版用户输入（response_item/message role=user）也认，<environment_context> 那坨跳过');
  check(agents.codexGlance(rf, fs.statSync(rf).size).turns === 0, '偏移在末尾 → 这一段什么都没有');
  check(agents.codexGlance(rf, 99999999).nextOffset === fs.statSync(rf).size,
        '档案变短（偏移比文件还大）→ 跳到末尾重新跟，不重放');
  check(agents.codexGlance(path.join(TMP, '没有.jsonl'), 0) === null, '读不出来 → null');
}

console.log('\n[12] 盯档案 → 汇报：跟 claude 同一个下游，一个字段都不差');
{
  const L = (type, payload) => JSON.stringify({ timestamp: 'x', type, payload });
  const rf = path.join(TMP, 'watch.jsonl');
  const tm = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
  const reports = [];
  const turns = [];
  tm.on('report', (e) => reports.push(e));
  tm.on('turn', (e) => turns.push(e));
  const specOf = (id, extra) => ({
    id, name: 'x', dir: TMP, task: '修校验', sessionId: 's-' + id,
    windowName: 'waifu-' + id, title: 'WaifuCode · x', agent: 'codex',
    codexFile: rf, codexSessionId: 'id-' + id, codexClaimed: true, codexOffset: 0, ...extra,
  });
  // _codexPersist 要往 spec 文件里写进度，先落一份
  const specFileOf = (id) => path.join(TMP, 'terminals', id + '.json');
  fs.writeFileSync(specFileOf('wa'), JSON.stringify(specOf('wa')), 'utf8');

  fs.writeFileSync(rf, L('response_item', { type: 'function_call', name: 'shell', arguments: '{}' }) + '\n', 'utf8');
  const rec = tm._makeRecord(specOf('wa'), { pid: 1, status: 'running' });
  tm.items.set('wa', rec);
  tm._codexWatch(rec);
  check(reports.length === 0 && turns.length === 0, '只动了工具、一轮没干完 → 先攒着不报');

  fs.appendFileSync(rf,
    L('event_msg', { type: 'user_message', message: '把校验修好' }) + '\n' +
    L('response_item', { type: 'custom_tool_call', name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: src/x.js\n*** End Patch' }) + '\n' +
    L('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: '搞定了' }) + '\n');
  tm._codexWatch(rec);
  check(reports.length === 1, '**一轮干完 → 汇报来了**（跟 claude 的 Stop 一个待遇）');
  const r1 = reports[0] || {};
  check(r1.text === '搞定了' && r1.quiet === false && r1.speak === true,
        '原话、开口、要念 —— 形状跟 claude 的 report 一致');
  check((r1.files || []).includes('x.js') && r1.toolCount === 2,
        '攒的工具和文件跟着这一轮一起报（面板和气泡都要用）');
  check(r1.task === '把校验修好', 'task 是这轮用户要的（小抄按它记）');
  check(turns.length === 1 && turns[0].tools === 2,
        '**turn 事件也发**（流水的按轮统计原来永远数不到 codex，评审抓的）');

  tm._codexWatch(rec);
  check(reports.length === 1, '文件没长 → 不重读不重报');

  fs.appendFileSync(rf, L('event_msg', { type: 'task_complete', turn_id: 't2', last_agent_message: '又一段' }) + '\n');
  tm._codexWatch(rec);
  check(reports.length === 2 && reports[1].quiet === true,
        '20 秒内第二轮 → 照记账但**闭嘴**（quiet，跟 claude 的碎碎念闸一样）');
  check(reports[1].toolCount === 0,
        '**报的是「这一段」的量**不是开线以来累计 —— 这一轮没动工具就是 0（评审抓的）');

  // 出错的轮：last_agent_message 是 null → 概要兜底，别一声不吭
  fs.appendFileSync(rf,
    L('event_msg', { type: 'error', message: 'x' }) + '\n' +
    L('event_msg', { type: 'task_complete', turn_id: 't3', last_agent_message: null }) + '\n');
  rec.lastReportAt = 0;
  tm._codexWatch(rec);
  check(reports.length === 3 && /报了 1 次错/.test(reports[2].text),
        '出错的轮没有原话 → 概要兜底（这一段没动工具就只说报错，不说「动了 0 次」）');

  // 桌宠重启认回来：进度从 spec 里的 codexSeen 恢复 —— 刚报过的那轮不许重播
  const seenSpec = JSON.parse(fs.readFileSync(specFileOf('wa'), 'utf8'));
  check(seenSpec.codexSeen && seenSpec.codexSeen.turns === 3 && seenSpec.codexSeen.offset > 0,
        '**进度落了盘**（codexSeen：偏移 + 报到第几轮 + 最后那句）');
  const rec2 = tm._makeRecord(seenSpec, { pid: 1, status: 'running' });
  tm.items.set('wa2', rec2);
  tm._codexWatch(rec2);
  check(reports.length === 3 && rec2.turns === 3,
        '**重启认回来不重播** —— 评审抓的 high：原来气泡+语音+小抄+流水各重一份');
  check(rec2.lastReport !== '' && rec2.costPaid === (seenSpec.costPaid || 0),
        '最后那句和已入账的钱也一起回来了（钱不落盘会在流水里翻倍）');

  // 接着聊续写同一份文件：从文件末尾跟起，旧轮次不重报
  const rec3 = tm._makeRecord(specOf('wb', { codexOffset: fs.statSync(rf).size }), { pid: 1, status: 'running' });
  tm.items.set('wb', rec3);
  tm._codexWatch(rec3);
  check(reports.length === 3, '**偏移挡住了历史** —— 上一窗干的三轮不会在新窗口再报一遍');
  fs.appendFileSync(rf, L('event_msg', { type: 'task_complete', turn_id: 't4', last_agent_message: '新窗口的活' }) + '\n');
  tm._codexWatch(rec3);
  check(reports.length === 4 && reports[3].text === '新窗口的活', '新窗口只报自己干的');

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
