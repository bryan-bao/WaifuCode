'use strict';

// codex 那条线的自检（离线，几百毫秒跑完）。守五件事：
//
//   1. 权限映射：claude 的模式名 → codex 的 -a/-s 两个旋钮，宁紧勿松 ——
//      **永远不许**映射出 danger-full-access 或那个 --dangerously-bypass 开关
//   2. 小抄拼进开场 prompt 的规矩：有活才拼、没活一个 prompt 都不发（发了就是替
//      用户开跑一轮，花的是他 OpenAI 的钱）、小抄读不到就当没有
//   3. term-shell 里那几处分岔别被人顺手删了（跟 test-termlife 钉引号一个套路）
//   4. 关窗去留：codex 的线收不到 hook，turns 恒 0 —— 派过活的必须留成「已完成」
//      （不留「再来」永远不出现），而 claude 那边的老规矩一个字不许变
//   5. 「等你确认」那条 hook 的参数：事件名大小写、timeout 必须显式、一个反斜杠
//      都不许有（TOML 会当非法转义整段解析失败），以及永远不许产出 bypass 开关

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

  // 新鲜度闸：晚认领只认「还在写」的档案 —— 出列死线的旧档案 mtime 早停了，
  // 捡走它 = 汇报重播 + 已入账的钱二次入账（评审实测过整条路径）
  const idF = '019a0000-0000-7000-8000-000000000fff';
  const fDir = path.join(TMP, '死档案');
  const ff = path.join(dayDir(since), 'rollout-x-f.jsonl');
  fs.writeFileSync(ff, metaLine(idF, fDir) + '\n', 'utf8');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(ff, old, old); // mtime 拨回一分钟前 = 早就不写了
  check(agents.findCodexSession({ dir: fDir, sinceMs: since, root, freshWithinMs: 10000 }) === null,
        '**晚认领不捡死档案** —— mtime 一分钟没动的不认（防出列死线被二次入账）');
  check(agents.findCodexSession({ dir: fDir, sinceMs: since, root }) !== null,
        '不带新鲜度闸（开窗 90 秒内的正常认领）照常认得到');
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

    // **认领没有截止时间**。实机死过（w63）：不带任务的终端，codex 要等用户
    // 敲第一句话才落盘档案 —— 文件出生比开窗晚一分多钟，原来的 90 秒窗一过
    // 这条线的汇报/金额/接着聊全灭，还是静默的
    calls.length = 0;
    const rLate = tm._makeRecord(specOf('pk5'), { pid: 1, status: 'running' });
    rLate.startedAt = now - 10 * 60 * 1000;   // 开窗十分钟了
    tm.items.set('pk5', rLate);
    tm._codexPeek(rLate, now);
    check(calls.length === 1,
          '**开窗十分钟了照样在配** —— 空任务终端的档案要等第一句话才出生（评审+实机抓的）');

    // codex 退了还没认到 = 它压根没落过盘，别再认了（之后同目录出现的
    // 只可能是别人的会话）
    calls.length = 0;
    const rDone = tm._makeRecord(specOf('pk6'), { pid: 1, status: 'done' });
    rDone.startedAt = now - 5 * 60 * 1000;
    tm.items.set('pk6', rDone);
    tm._codexPeek(rDone, now);
    check(calls.length === 0, 'codex 退了还没认到 → 不再认（再出现的只会是别人的）');
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

  // codex 停下来问过你（waiting），你批准之后它动了工具 —— 档案里读到新动静
  // 就把「在等你确认」翻回「干着呢」。不翻的话 waiting 卡死到关窗：面板一直
  // 喊「等你确认」，她的姿态也被这条僵尸 waiting 占着（评审抓的）
  rec.status = 'waiting';
  fs.appendFileSync(rf, L('response_item', { type: 'function_call', name: 'shell', arguments: '{}' }) + '\n');
  tm._codexWatch(rec);
  check(rec.status === 'running',
        '**批准之后她不再喊「等你确认」** —— 档案里读到新工具动静就翻回干着呢');

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

console.log('\n[13] 陪聊的参数和定价（agents 那半边）');
{
  const uuid = '019a6175-e35e-7dc2-9c43-66285d92da22';
  const a = agents.codexChatArgs({});
  check(a[0] === 'exec' && a.includes('--json') && a.includes('read-only') && a[a.length - 1] === '-',
        '新开：exec --json 只读沙箱，prompt 走 stdin（最后那个 -）');
  const b = agents.codexChatArgs({ resumeId: uuid });
  check(b[0] === 'exec' && b[1] === 'resume' && b[2] === uuid && b[b.length - 1] === '-',
        '接着聊：exec resume <uuid>');
  check(!b.includes('-s') && b.join(' ').includes('sandbox_mode=read-only'),
        '**resume 不认 -s（实测 exit 2）**，沙箱走 -c sandbox_mode，且不带引号（cmd 会啃）');
  const g = agents.codexGreetArgs({ schemaFile: 'D:/x/schema.json' });
  check(g.includes('--output-schema') && g[g.length - 1] === '-', '搭话：--output-schema + stdin');
  check(!a.join(' ').includes('dangerous') && !b.join(' ').includes('dangerous'),
        '陪聊永远不碰 dangerous 开关');

  const usd = agents.codexPriceUsage(
    { input_tokens: 100000, cached_input_tokens: 40000, output_tokens: 2000 }, 'gpt-5.6-sol');
  check(Math.abs(usd - 0.38) < 1e-9, '定价跟派活同一张表（缓存一折）');
  check(agents.codexPriceUsage(null, '') === 0, '没用量就是 0');

  // findRolloutById / codexModelOf：造一棵假的 sessions 树
  const home = path.join(TMP, 'codexhome');
  const dd = path.join(home, 'sessions', '2026', '08', '19');
  fs.mkdirSync(dd, { recursive: true });
  const rid = '01a0aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
  const rf = path.join(dd, 'rollout-2026-08-19T10-00-00-' + rid + '.jsonl');
  // pad 垫到 64KB 开外：真档案里第一轮会把人设/技能说明整段回显，实测第一个
  // model 字段在 68KB 处 —— 64KB 的头刚好错过（踩过的坑，这条测试钉着窗口大小）
  fs.writeFileSync(rf,
    JSON.stringify({ type: 'session_meta', payload: { session_id: rid, cwd: 'C:/x', model_provider: 'OpenAI', pad: 'P'.repeat(70000) } }) + '\n' +
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 't', model: 'gpt-5.4' } }) + '\n', 'utf8');
  const root = path.join(home, 'sessions');
  check(agents.findRolloutById(rid, root) === rf, '按 uuid 找到档案（光看文件名，不读内容）');
  check(agents.findRolloutById('01a0aaaa-bbbb-7ccc-8ddd-eeeeffff9999', root) === null, '没有就是没有');
  check(agents.codexModelOf(rf) === 'gpt-5.4',
        '**model 在 68KB 开外也认得出**（64KB 的头踩过一次；session_meta 只有 model_provider，撞不上）');

  // 会话接不上时的真机报错文案：chat.js 的识别正则必须涵盖（评审拿真 codex 试出来的）
  const chatSrc = fs.readFileSync(path.join(ROOT, 'src', 'chat.js'), 'utf8');
  check(chatSrc.includes('failed to read thread'),
        '**resume 报错的识别对着真机文案**（"thread/resume failed: failed to read thread…"），不是猜的');
}

(async () => {
  const withTimeout = (p, ms, tag) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' 超时')), ms)),
  ]);

  console.log('\n[14] 陪聊走 codex：假 codex 全链路（两轮，含 resume）');
  {
    const { Chat } = require(path.join(ROOT, 'src', 'chat.js'));
    const home = path.join(TMP, 'codexhome');
    const capDir = path.join(TMP, 'fakechat');
    fs.mkdirSync(capDir, { recursive: true });

    // 假 codex：抓走 argv 和 stdin，回放 --json 事件流
    const fakeId = '01a0aaaa-bbbb-7ccc-8ddd-eeeeffff0001'; // 就用 [13] 那份档案的 id，resume 判定才过
    const fakeJs = path.join(capDir, 'fake-codex.js');
    fs.writeFileSync(fakeJs, [
      "const fs=require('fs');const path=require('path');",
      "const d=" + JSON.stringify(capDir) + ";",
      "let n=1;while(fs.existsSync(path.join(d,'args-'+n+'.txt')))n++;",
      "fs.writeFileSync(path.join(d,'args-'+n+'.txt'),JSON.stringify(process.argv.slice(2)));",
      "let inp='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',(c)=>{inp+=c;});",
      "process.stdin.on('end',()=>{",
      "fs.writeFileSync(path.join(d,'prompt-'+n+'.txt'),inp);",
      "const greet=inp.includes('只输出一个 JSON 对象');",
      "console.log(JSON.stringify({type:'thread.started',thread_id:'" + fakeId + "'}));",
      "const text=greet?JSON.stringify({say:'戳我干嘛呀',face:'happy',offer:{kind:'none',label:''}}):('回你第'+n+'句<<M:happy>>');",
      "console.log(JSON.stringify({type:'item.completed',item:{id:'i1',type:'agent_message',text}}));",
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10000,cached_input_tokens:0,output_tokens:100}}));",
      "process.exit(0);});",
    ].join('\n'), 'utf8');
    const fakeCmd = path.join(capDir, 'codex.cmd');
    fs.writeFileSync(fakeCmd, '@echo off\r\nnode "' + fakeJs + '" %*\r\n', 'utf8');

    const oldBin = process.env.WAIFU_CODEX_BIN;
    const oldHome = process.env.CODEX_HOME;
    process.env.WAIFU_CODEX_BIN = fakeCmd;
    process.env.CODEX_HOME = home;

    try {
      const chatDir = path.join(TMP, 'chatstore');
      fs.mkdirSync(chatDir, { recursive: true });
      const chat = new Chat({
        storeDir: chatDir,
        claudeBin: 'claude-不该被用到',
        getConfig: () => ({ persona: { text: '你是小依，说话要短。' }, dispatch: { agent: 'codex' } }),
        getMoodDesc: () => '心情很好。',
        log: () => {},
      });
      const say = (t) => withTimeout(new Promise((resolve, reject) => {
        const deltas = [];
        const onD = (e) => deltas.push(e.text);
        const done = (e) => { off(); resolve({ ...e, deltas }); };
        const fail = (e) => { off(); reject(new Error(e.error)); };
        const off = () => { chat.off('delta', onD); chat.off('done', done); chat.off('error', fail); };
        chat.on('delta', onD); chat.on('done', done); chat.on('error', fail);
        const r = chat.send(t);
        if (!r.ok) { off(); reject(new Error(r.error)); }
      }), 20000, '陪聊第一轮');

      const r1 = await say('你好呀');
      check(r1.text === '回你第1句', '整句回来了（<<M: 心情标记被摘掉）');
      check(r1.mood === 'happy', '心情标记解出来了（她的脸跟着变）');
      check(r1.deltas.join('') === '回你第1句', '界面上有字在出（delta）');
      // [13] 造的那份档案里写着 gpt-5.4 —— 她按 uuid 找到档案、认出模型、按它定价
      check(Math.abs(r1.costUsd - (10000 * 2.5 + 100 * 15) / 1e6) < 1e-9,
            '这轮的钱按**她档案里的真实模型**（gpt-5.4）定价，不是瞎按旗舰');
      const args1 = JSON.parse(fs.readFileSync(path.join(capDir, 'args-1.txt'), 'utf8'));
      check(args1[0] === 'exec' && args1.includes('--json') && !args1.includes('resume'),
            '第一轮：新开会话');
      const p1 = fs.readFileSync(path.join(capDir, 'prompt-1.txt'), 'utf8');
      check(p1.includes('你是小依') && p1.includes('绝不自称 Codex') && p1.includes('你好呀'),
            '**人设垫在开场白里**（codex 没有 --system-prompt 的口子，实测 -c 换底被静默无视）');
      check(p1.includes('心情很好'), '她此刻的心情每轮都带（跟 claude 侧一致）');

      const r2 = await say('第二句');
      check(r2.text === '回你第2句', '第二轮也通');
      const args2 = JSON.parse(fs.readFileSync(path.join(capDir, 'args-2.txt'), 'utf8'));
      check(args2[1] === 'resume' && args2[2] === fakeId,
            '**第二轮真的 resume 上一条**（thread_id 是从第一轮输出里白捡的）');
      const saved = JSON.parse(fs.readFileSync(path.join(chatDir, 'chat.json'), 'utf8'));
      check(saved.codex && saved.codex.threadId === fakeId && saved.codex.turns === 2,
            'codex 的会话状态落了盘（跟 claude 的 sessionId 各管各）');
      chat.dispose();
    } finally {
      if (oldBin === undefined) delete process.env.WAIFU_CODEX_BIN; else process.env.WAIFU_CODEX_BIN = oldBin;
      if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    }
  }

  console.log('\n[15] 搭话走 codex：假 codex 单发结构化输出');
  {
    const { Greeter } = require(path.join(ROOT, 'src', 'greet.js'));
    const capDir = path.join(TMP, 'fakechat');
    const oldBin = process.env.WAIFU_CODEX_BIN;
    process.env.WAIFU_CODEX_BIN = path.join(capDir, 'codex.cmd');
    try {
      const greeter = new Greeter({
        claudeBin: 'claude-不该被用到',
        getConfig: () => ({ persona: { text: '你是小依' }, dispatch: { agent: 'codex' } }),
        log: () => {},
      });
      const r = await withTimeout(greeter.greet({ kind: 'poke' }), 20000, '搭话');
      check(r && r.say === '戳我干嘛呀', '搭话的 JSON 解出来了');
      check(r && r.offer === null, 'offer 是 none → 归一成 null（跟 claude 侧一致）');
      check(r && r.costUsd > 0, '这次花的钱也带出来了（进当天流水）');
      const argsG = JSON.parse(fs.readFileSync(path.join(capDir, 'args-3.txt'), 'utf8'));
      check(!argsG.includes('--output-schema'),
            '**不带 --output-schema** —— 走中转的 codex 对它一律 502（实机 55 秒全灭），提示词要 JSON 就够');
      const pG = fs.readFileSync(path.join(capDir, 'prompt-3.txt'), 'utf8');
      check(pG.includes('他戳了戳你') && pG.includes('绝不自称 Codex'), '情境和人设都在开场白里');
      check(pG.includes('只输出一个 JSON 对象') && pG.includes('"say"'),
            'JSON 的样子直接写进提示词（比 schema 更通用）');
    } finally {
      if (oldBin === undefined) delete process.env.WAIFU_CODEX_BIN; else process.env.WAIFU_CODEX_BIN = oldBin;
    }
  }

  console.log('');
console.log('\n[16] codex 停下来问你时她要能知道（hook 参数）');
{
  const NOTIFY = 'D:/WaifuCode/hooks/notify.js';
  const NODE = 'C:/n/node.exe';
  const w = agents.codexWatchArgs(NOTIFY, NODE);
  const line = w.join(' ');

  check(w.filter((x) => x === '-c').length === 6,
        '六条 -c：四个 hook + 两条让 Windows Terminal 也弹通知');
  for (const ev of ['PermissionRequest', 'UserPromptSubmit', 'Stop', 'PreCompact']) {
    check(line.includes('hooks.' + ev + '='), '挂上了 ' + ev);
  }
  for (const tag of ['CodexAttention', 'CodexPrompt', 'CodexStop', 'CodexCompact']) {
    check(line.includes(' ' + tag), '事件名传给了 notify.js：' + tag);
  }
  check(!/hooks\.(PreToolUse|PostToolUse)=/.test(line),
        '**不挂 per-tool 的那两个** —— 每次工具调用起一个进程会明显拖慢 codex（护栏单独议）');
  check(/hooks\.PermissionRequest=/.test(line),
        '事件名是 **PascalCase**（写成 permissionRequest 的话 hooks/list 返回空，' +
        '而且零告警零错误）');
  check(/timeout=5/.test(line),
        '**timeout 必须显式给** —— 默认 600 秒，而 hook 是阻塞的，' +
        '桌宠没开着时能把 codex 卡十分钟');
  check(!/\\/.test(line),
        '**一个反斜杠都不许有** —— TOML 会把 \\W 当非法转义，整段解析失败');
  check(line.includes(NOTIFY) && line.includes(NODE),
        'node 和 notify.js 都写绝对路径（hook 的执行环境未必有 node 在 PATH 上）');

  // 宁紧勿松那条铁律，在这儿同样成立
  check(!/dangerously|danger-full-access|bypass/i.test(line),
        '**绝不产出 --dangerously-bypass-hook-trust** —— 它会对这次调用里' +
        '所有 hook 放行，包括派活目录里可能躺着的 .codex/hooks.json');

  // 路径拼不安全就宁可不挂（单引号是 TOML 字面串的定界符，没法转义）
  check(agents.codexWatchArgs("C:/o'brien/notify.js", NODE).length === 0,
        '路径里有单引号 → 宁可不挂，也不拼一个会解析失败的串');
  check(agents.codexWatchArgs('', NODE).length === 0, '没给路径就不挂');

  // 只有开终端那条路带，陪聊那两条不带
  const BS = String.fromCharCode(92);
  const termSpec = { permissionMode: 'auto', task: '干活', notifyFile: NOTIFY, nodeBin: NODE };
  const term = agents.codexArgs(termSpec, false);
  check(term.join(' ').includes('hooks.PermissionRequest'), '开终端那条带上了');
  const bare = agents.codexArgs({ permissionMode: 'auto', task: '干活' }, false);
  check(!bare.join(' ').includes('hooks.'), '没给 notifyFile 就不带（老行为原样）');
  check(!agents.codexChatArgs({}).join(' ').includes('hooks.'),
        '陪聊那条不带 —— 那是我们自己调的进程，直接读输出');

  // ── 信任那一半：不带信任的 hook 是**静默不跑**的 ──────────────────
  const H = 'sha256:' + 'a'.repeat(64);
  const t = agents.codexTrustArgs(H);
  check(t.length === 2 && t[0] === '-c', '信任是一条独立的 -c');
  check(t[1].includes("{'C:" + BS + "<session-flags>" + BS + "config.toml:permission_request:0:0'}".slice(0, -1)),
        '**key 用单引号（TOML 字面串）**，反斜杠才活得下来');
  check(t[1].includes('trusted_hash="' + H + '"'),
        '**hash 必须用双引号** —— 换成单引号整个 hooks 段会消失，而且零报错（实测）');
  check(t[1].indexOf(BS) > 0, 'key 里得有真的反斜杠（JS 串里 ' + BS + '< 会被吞掉，必须转义）');
  check(agents.codexTrustArgs('').length === 0 && agents.codexTrustArgs('abc').length === 0 &&
        agents.codexTrustArgs('sha256:xyz').length === 0,
        '哈希不像样就不带 —— 宁可这次没提醒，也不拼个会把配置搞坏的串');

  const withTrust = agents.codexArgs({ ...termSpec, codexHookHash: H }, false);
  check(withTrust.some((x) => String(x).startsWith('hooks.state')), '存过哈希就带上信任');
  check(!term.some((x) => String(x).startsWith('hooks.state')), '没存过就不带（老行为原样）');
  check(typeof agents.probeCodexHookHash === 'function', '问哈希的探针导出来了（main.js 启动时用）');
}

console.log('\n[16b] codex 也该有的那几样：信任给齐、说得出在等什么、干完翻闲着');
{
  // ── 信任：多条塞进**同一个** hooks.state（分成几个 -c 会互相顶掉）──
  const H = 'sha256:' + '0'.repeat(64);
  const t = agents.codexTrustArgs({ 'C:\\<session-flags>\\config.toml:stop:0:0': H,
                                    'C:\\<session-flags>\\config.toml:pre_compact:0:0': H });
  check(t.length === 2 && t[0] === '-c' && (t[1].match(/trusted_hash/g) || []).length === 2,
        '两条信任 → **一条 hooks.state 里两项**（分开给的话后一条把前一条整表顶掉）');
  check(t[1].startsWith('hooks.state={') && t[1].includes("'C:") && t[1].includes('"sha256:'),
        "key 走 TOML 字面串（单引号，里面有反斜杠）、hash 走双引号串 —— 反过来静默失效");
  check(agents.codexTrustArgs({ k: 'sha256:xx' }).length === 0, '哈希形状不对 → 不给（宁可不带）');
  check(agents.codexTrustArgs({ "o'brien": H }).length === 0, 'key 里有单引号 → 跳过，不拼出会解析失败的串');
  check(agents.codexTrustArgs(null).length === 0 && agents.codexTrustArgs({}).length === 0, '没有就不给');
  check(agents.codexTrustArgs(H).length === 2, '老存档里那个单串也认（当成 permission_request 那条）');

  // ── 在等什么：载荷翻成一句人话，拿不到就闭嘴 ──
  const ask = agents.codexAskText;
  check(ask({ tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'npm test'] } }) === 'npm test',
        "shell 只念真正要跑的那截（['bash','-lc',…] 前两个是壳）");
  check(ask({ tool_name: 'shell', tool_input: { command: 'git push' } }) === 'git push', '字符串形态的命令也认');
  const patch = ask({ tool_name: 'apply_patch', tool_input: {
    input: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** End Patch' } });
  check(patch.includes('a.js') && !patch.includes('+y') && !patch.includes('@@'),
        '**改文件只报文件名** —— 补丁原文绝不外传（手机上那条同款规矩）');
  check(ask({ tool_name: 'web_search' }) === 'web_search', '别的工具至少报个工具名');
  check(ask({}) === '' && ask(null) === '',
        '**载荷没喂过来就是空串** —— 上游照旧只说「那边在等你确认」，不瞎编在等什么');

  // ── 状态灯 / 时间线：hook 没送到时，盯档案也得把这两件事补上 ──
  const L = (type, payload) => JSON.stringify({ timestamp: 'x', type, payload });
  const rf2 = path.join(TMP, 'status.jsonl');
  const tm2 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
  const sp = { id: 'st', name: 'x', dir: TMP, task: '', sessionId: 's-st', windowName: 'w-st',
               title: 'WaifuCode · x', agent: 'codex', codexFile: rf2, codexSessionId: 'id-st',
               codexClaimed: true, codexOffset: 0 };
  fs.writeFileSync(path.join(TMP, 'terminals', 'st.json'), JSON.stringify(sp), 'utf8');
  fs.writeFileSync(rf2, '', 'utf8');
  const r = tm2._makeRecord(sp, { pid: 1, status: 'idle' });
  tm2.items.set('st', r);

  // ① 空窗口：你敲了第一句 → 该认得出在干活
  fs.appendFileSync(rf2, L('event_msg', { type: 'user_message', message: '看一下这个报错' }) + '\n');
  tm2._codexWatch(r);
  check(r.status === 'running',
        '**空窗口敲第一句就认得出在干活** —— 原来一直显示「闲着」，你在里面敲半天她也不知道');

  // ② 报错：留一句原文，进时间线
  fs.appendFileSync(rf2, L('event_msg', { type: 'error', message: '连不上服务器' }) + '\n');
  tm2._codexWatch(r);
  check(r.lastError === '连不上服务器' &&
        (r.timeline || []).some((e) => e.kind === 'error' && e.text === '连不上服务器'),
        '报错留原文并进时间线（原来 codex 线只有个数字）');

  // ③ 一轮干完：灯翻「闲着」，她说的话进时间线
  fs.appendFileSync(rf2, L('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: '查完了' }) + '\n');
  tm2._codexWatch(r);
  check(r.status === 'idle',
        '**一轮干完 → 翻「闲着」** —— 原来 codex 线一路「干着呢」到关窗，干完也不熄');
  check((r.timeline || []).some((e) => e.kind === 'her' && e.text === '查完了'),
        '她的汇报进时间线（手机上点进任务原来只看得到自己说的话）');

  // ④ 等确认时她在等什么：hook 那条路
  tm2.onHookEvent({ waifuEvent: 'CodexAttention', waifuTermId: 'st',
                tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'rm -rf build'] } });
  check(r.status === 'waiting' && r.waitDetail === 'rm -rf build',
        '**说得出在等什么**（原来只有干巴巴一句「那边在等你确认」）');
  check((r.timeline || []).some((e) => e.kind === 'wait' && e.text.includes('rm -rf build')),
        '在等什么也进时间线');

  // ⑤ 上下文满了：codex 那条走 claude 同一个出口
  const before = r.compactions || 0;
  tm2.onHookEvent({ waifuEvent: 'CodexCompact', waifuTermId: 'st' });
  check((r.compactions || 0) === before + 1,
        '**上下文满了也喊你了** —— 原来这个信号 codex 线完全没有（面板上压缩次数永远是 0）');

  // ⑥ Stop hook：直接翻闲着；但不许把「等你确认」踩掉
  r.status = 'running';
  tm2.onHookEvent({ waifuEvent: 'CodexStop', waifuTermId: 'st' });
  check(r.status === 'idle', 'Stop 送到了就立刻翻闲着（不用等 3 秒那一拍）');
  r.status = 'waiting';
  tm2.onHookEvent({ waifuEvent: 'CodexPrompt', waifuTermId: 'st', prompt: '接着改' });
  check(r.status === 'waiting',
        '**等你确认时不许被这些事件踩回 running** —— 那条线是真停着的');
}

console.log('\n[17] 这次给了什么权限，要说得出人话');
{
  for (const m of ['auto', 'acceptEdits', 'plan', 'dontAsk']) {
    const w = agents.codexPermWords(m);
    check(w.includes('-a ') && w.includes('-s '), m + '：把真参数也带出来（' + w + '）');
  }
  check(agents.codexPermWords('plan').includes('一个字都不许写'),
        'plan 在 codex 上是「只读」，不是「先出方案」—— codex 没有 plan 模式');
  check(agents.codexPermWords('乱写的') === agents.codexPermWords('auto'),
        '认不出来的一律按 auto 说（跟 PERM 的兜底一致）');
}

console.log('\n[18] 「帮我装」装的必须是官方那两个包，一个字都不能错');
{
  // 包名打错一个字 = 把用户的机器交给 npm 上的同名钓鱼包，这里逐字钉死
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check(main.includes("claude: '@anthropic-ai/claude-code'"), 'claude 装 @anthropic-ai/claude-code');
  check(main.includes("codex: '@openai/codex'"), 'codex 装 @openai/codex');
  const inst = main.slice(main.indexOf('function installAgent'), main.indexOf('function installAgent') + 4000);
  check(inst.length > 100, 'installAgent 得在 main.js 里');
  check(!inst.includes('--force') && !inst.includes('sudo'), '装的时候不许 --force / sudo');
  check(inst.includes('shell: true'), 'npm 是 .cmd，不带 shell 直接 spawn 会 EINVAL（别退回去）');
}

  if (failed) {
    console.log('\x1b[31m✗ ' + failed + ' 条没过\x1b[0m');
    process.exitCode = 1;
  } else {
    console.log('[完整对话] codex 线的 turnsOf 同款契约');
{
  const r = agents.codexTurns('根本没有这条线');
  check(r.ok === false && r.why && Array.isArray(r.turns),
        '找不到档案时说得清、turns 仍是数组（前端不用防空）');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agents.js'), 'utf8');
  const body = src.slice(src.indexOf('function codexTurns'), src.indexOf('function pickPrompt'));
  check(body.includes('pickPrompt'),
        '切轮用同一个 pickPrompt（环境注入/IDE 那坨不算人说的话）');
  check(body.includes('cur.out[cur.out.length - 1] !== t'),
        'agent_message 和 message:assistant 是同一句的两种记法 —— 连着重复的不许收两遍');
  check(body.includes('slice(0, 80)') && !/arguments[^]{0,200}push(raw)/.test(body),
        '工具只留名字+短提要（arguments 里动辄整份补丁，不许上手机）');
  check(body.includes('lines.shift()'), '只读尾巴时掐掉可能被切断的头一行');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check(main.includes('agents.codexTurns(rec.sessionId)') && main.includes('cost.turnsOf(rec.sessionId)'),
        'main 按 agent 分岔，两张嘴吐同一个形状（手机那头零改动）');
  check(!main.includes('这版还没接进来'), 'codex 那句「还没接进来」该拿掉了');
}

console.log('\x1b[32m✓ 全过\x1b[0m');
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 临时目录留着也无妨 */ }
})();
