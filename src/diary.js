'use strict';

// 她写的周记。每周一她用第一人称递你一页：这周干了啥、烧了多少、
// 哪天最累、印象最深的一件小事 —— 顺便就是你的 devlog 草稿。
//
// 数据全是本地的（journal 的七天流水），**唯一花钱的是让她用自己的口吻
// 写出来**（一周一次、一次几分钱、有预算上限）。数据不够一篇就不写 ——
// 「这周没干什么」不值得专门写页纸。

const { spawn } = require('child_process');
const os = require('os');
const agents = require('./agents');

const TIMEOUT_MS = 90 * 1000;

/**
 * 把七天流水捏成给她看的事实清单。纯函数：journal 的 read 注进来，测试才拿得住。
 * 返回 null = 这周没什么可写的。
 */
function weekFacts({ readDay, dayKeyOf, now = Date.now() }) {
  const days = [];
  for (let i = 7; i >= 1; i--) {
    const key = dayKeyOf(now - i * 86400000);
    const recs = readDay(key) || [];
    if (!recs.length) continue;
    let turns = 0, tasks = 0, errors = 0, cost = 0;
    const briefs = [];
    for (const r of recs) {
      if (r.type === 'turn') { turns++; errors += r.errors || 0; }
      if (r.type === 'task-done') tasks++;
      if (typeof r.costUsd === 'number' && isFinite(r.costUsd)) cost += r.costUsd;
      if (r.type === 'report' && r.brief) briefs.push(String(r.brief).slice(0, 60));
    }
    days.push({ day: key, turns, tasks, errors, cost, briefs });
  }
  const total = days.reduce((a, d) => ({
    turns: a.turns + d.turns, tasks: a.tasks + d.tasks,
    errors: a.errors + d.errors, cost: a.cost + d.cost,
  }), { turns: 0, tasks: 0, errors: 0, cost: 0 });
  // 三轮以下的一周不值得写 —— 硬写就是没话找话
  if (total.turns < 3) return null;

  const busiest = days.slice().sort((a, b) => b.turns - a.turns)[0];
  const roughest = days.filter((d) => d.errors > 0).sort((a, b) => b.errors - a.errors)[0];
  const briefs = days.flatMap((d) => d.briefs).slice(-5);

  return { days, total, busiest, roughest, briefs };
}

/** 提示词。事实摆给她，口吻让她自己来 */
function prompt(persona, facts, aboutBits) {
  const f = facts;
  const lines = f.days.map((d) =>
    d.day + '：' + d.turns + ' 轮' +
    (d.tasks ? '、收尾 ' + d.tasks + ' 个活' : '') +
    (d.errors ? '、报错 ' + d.errors + ' 次' : '') +
    (d.cost >= 0.01 ? '、花 $' + d.cost.toFixed(2) : ''));
  return [
    String(persona || '').trim(),
    '',
    '【任务】用**你自己的第一人称**写一篇这周的周记，是你递给他看的一页纸。',
    'markdown，150~300 字，别用列表堆数据 —— 要像日记，有你的情绪和你的话。',
    '写这几样：这周陪他干了什么（挑重要的说）、哪天最忙/最累、',
    '你印象最深的一件小事（从下面的汇报原话里挑，别编）、结尾一两句你想对他说的话。',
    '**只许写事实清单里有的事**：他的表情、房间里发生的画面、你没亲眼见过的场景，',
    '一概不许虚构 —— 编出来的温馨是假的，他一眼就看得出来。感想可以有，画面不许编。',
    '数字别罗列，挑一两个说到点上就行。',
    '',
    '【这周的流水（事实，别编造之外的）】',
    ...lines,
    '一共：' + f.total.turns + ' 轮、收尾 ' + f.total.tasks + ' 个活' +
      (f.total.cost >= 0.01 ? '、花了 $' + f.total.cost.toFixed(2) : '') + '。',
    f.roughest ? '最较劲的一天：' + f.roughest.day + '（报错 ' + f.roughest.errors + ' 次）。' : '',
    f.briefs.length ? '你汇报过的原话（可当素材）：\n' + f.briefs.map((b) => '· ' + b).join('\n') : '',
    aboutBits && aboutBits.length ? '你还记得关于他的：' + aboutBits.join('；') + '（合适就自然带一句）' : '',
    '',
    '直接输出周记正文，别加「好的」之类的开场白。',
  ].filter((x) => x !== '').join('\n');
}

/**
 * 让她写。claude / codex 两张嘴（跟「用谁来干」走）。
 * 出岔子返回 null —— 周记写不出来天塌不下来，下周一再试。
 */
function write({ claudeBin, getConfig, persona, facts, aboutBits, log = () => {} }) {
  const p = prompt(persona, facts, aboutBits);
  const useCodex = (getConfig().dispatch || {}).agent === 'codex';
  return useCodex ? _codex(p, log) : _claude(claudeBin, p, log);
}

function _claude(bin, p, log) {
  const useShell = /\.(cmd|bat)$/i.test(bin);
  const args = [
    '-p', '（写这周的周记）',
    '--tools', '',
    '--setting-sources', '',
    '--system-prompt', p,
    '--output-format', 'json',
    '--max-budget-usd', '0.30',
  ];
  const finalArgs = useShell ? args.map((a) => (a === '' ? '""' : a)) : args;
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(bin, finalArgs, { cwd: os.tmpdir(), windowsHide: true, shell: useShell });
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) { /* 已死 */ } }, TIMEOUT_MS);
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('error', (e) => { clearTimeout(timer); log('[diary] 起不来: ' + e.message); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        const text = String(j.result || '').trim();
        resolve(text ? { text, costUsd: j.total_cost_usd || 0 } : null);
      } catch (_) { resolve(null); }
    });
  });
}

function _codex(p, log) {
  const bin = agents.resolveCodexBin();
  if (!bin) return Promise.resolve(null);
  const useShell = /\.(cmd|bat)$/i.test(bin);
  const args = agents.codexChatArgs({});
  return new Promise((resolve) => {
    let reply = '';
    let buf = '';
    let usage = null;
    let model = '';
    const proc = spawn(bin, args, { cwd: os.tmpdir(), windowsHide: true, shell: useShell });
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) { /* 已死 */ } }, TIMEOUT_MS);
    proc.stdin.on('error', () => { /* EPIPE：codex 秒退时没人接会炸主进程 */ });
    try { proc.stdin.write(p, 'utf8'); proc.stdin.end(); } catch (_) { /* close 兜底 */ }
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          // 格式**照抄 chat.js 那套实测过的**（item.completed / agent_message）。
          // 第一版凭记忆写了旧格式（msg.msg.message），一个事件都对不上，
          // codex 机器上周记永远「没写出来」还不报错（评审抓的）
          if (msg.type === 'item.completed' && msg.item &&
              msg.item.type === 'agent_message' && msg.item.text) {
            reply += (reply ? '\n' : '') + String(msg.item.text);
          } else if (msg.type === 'turn.completed' && msg.usage) {
            usage = msg.usage;
            if (msg.usage.model) model = msg.usage.model;
          }
        } catch (_) { /* 不是 json 的行不管 */ }
      }
    });
    proc.on('error', (e) => { clearTimeout(timer); log('[diary] codex 起不来: ' + e.message); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      const text = reply.trim();
      resolve(text ? { text, costUsd: usage ? agents.codexPriceUsage(usage, model) : 0 } : null);
    });
  });
}

module.exports = { weekFacts, prompt, write };
