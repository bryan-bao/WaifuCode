'use strict';

// 记日子：认识满一个月、一起干完第一百个活、连着七天没落下。
//
// 这份自检守的三件事，每一件破了都很难被发现：
//   · **老存档不能被当成「今天刚认识」** —— 用户已经用了两个月，
//     firstMet 默认成现在的话，「认识 100 天」直接推迟三个月
//   · **判据必须是 >= 不是 ===** —— 累计量会一次跳好几，写 === 就永久错过
//   · **streak 不能靠 tick 涨** —— 电脑不关机的人出差一周，
//     「你连着七天来找我了」会在她根本没见到人的情况下响
//
// 不花钱、不起 claude、一瞬间跑完。

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-ms-'));
process.env.WAIFU_HOME = HOME;

const { Mood, MILESTONES, dayKey } = require('../src/mood');
const { profileFor } = require('../src/profiles');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

process.on('exit', () => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* 无所谓 */ }
});

const DAY = 86400000;
let n = 0;
function freshStore(save) {
  const d = path.join(HOME, 'store' + ++n);
  fs.mkdirSync(d, { recursive: true });
  if (save) fs.writeFileSync(path.join(d, 'mood.json'), JSON.stringify(save), 'utf8');
  return d;
}

// ---------------------------------------------------------------------------

console.log('\n[1] 老存档升级：处了两个月的人，不许被当成今天刚认识');
{
  // 这就是现在磁盘上那份的样子 —— 六个字段，一个记日子的都没有
  const old = {
    energy: 39, mood: 74, affection: 100,
    lastInteract: Date.now() - 40 * DAY,
    lastSeen: Date.now() - 40 * DAY,
    lastTick: Date.now() - 40 * DAY,
  };
  const m = new Mood({ storeDir: freshStore(old) });
  check(m.affection === 100 || m.affection < 100, '老存档能加载，没炸');
  check(m.firstMet <= old.lastInteract,
        '**firstMet 退到了「上次互动」那么早**，不是「现在」（差一个月就是三个月的里程碑推迟）');
  check(m.snapshot().days >= 39, '算出来认识了 ' + m.snapshot().days + ' 天');
  check(m.tasksDone === 0 && m.streak === 0, '没有的字段退回 0，不是 undefined');
  m.dispose();
}

console.log('\n[2] 存档要存得下来（save 是手写枚举字段的，最容易漏）');
{
  const dir = freshStore();
  const m = new Mood({ storeDir: dir });
  m.tasksDone = 42;
  m.streak = 5;
  m.hit.add('day7');
  m.save();
  m.dispose();

  const m2 = new Mood({ storeDir: dir });
  check(m2.tasksDone === 42, 'tasksDone 存下来了');
  check(m2.streak === 5, 'streak 存下来了');
  check(m2.hit.has('day7'), '**响过哪些也存下来了** —— 不存的话重启第二天全部重响一遍');
  m2.dispose();
}

console.log('\n[3] 到日子了会响，而且只响一次');
{
  const m = new Mood({ storeDir: freshStore() });
  m.firstMet = Date.now() - 8 * DAY;

  const hit = m._milestone();
  check(hit && hit.id === 'day7', '认识满一周 → 响了（' + (hit && hit.line) + '）');
  check(m.hit.has('day7'), '记下了');

  m.lastHitDay = ''; // 假装到了第二天
  check(m._milestone() === null, '**同一条不会响第二次**');
  m.dispose();
}

console.log('\n[4] 老存档头一回升级：一次对齐，别连着好几天翻旧账');
{
  const m = new Mood({ storeDir: freshStore() });
  m.firstMet = Date.now() - 200 * DAY;
  m.tasksDone = 500;
  m.streak = 99;
  m.affection = 100;

  const first = m._milestone();
  check(first && /^day(100|200)$/.test(first.id),
        '**说的是最有分量的那条**（' + (first && first.id) + '）—— 一个处了大半年的人，' +
        '第一句不该是「欸…我们认识一周了诶」');

  let got = 0;
  for (let i = 0; i < 50; i++) if (m._milestone()) got++;
  check(got === 0, '同一天不会再响（实得 ' + got + '）');

  m.lastHitDay = '';
  check(m._milestone() === null,
        '**第二天也不翻旧账** —— 够到的那些已经一次性记上了，' +
        '不然她会连着一周每天补一句早就过去的日子');
  m.dispose();
}

console.log('\n[5] 判据是 >= 不是 ===（跳过不等于永久错过）');
{
  const m = new Mood({ storeDir: freshStore() });
  m.hit.add('_used'); // 已经用过一阵了，不是头一回
  // 从 0 直接跳到 150 —— 重启补算、一轮干完俩，都会这样
  m.tasksDone = 150;
  const a = m._milestone();
  check(a && a.id === 'task10', '先补上 10 个那条');
  m.lastHitDay = '';
  const b = m._milestone();
  check(b && b.id === 'task100', '**第二天补上 100 个那条** —— 写 === 的话这条永久错过了');
  m.dispose();
}

console.log('\n[6] 连着几天：休眠跨日不许白涨');
{
  const m = new Mood({ storeDir: freshStore() });

  m.lastDay = dayKey(Date.now() - DAY);
  m.streak = 3;
  m._rollDay();
  check(m.streak === 4, '昨天见过 → 接上（3 → 4）');

  m.lastDay = dayKey(Date.now() - 3 * DAY);
  m.streak = 9;
  const seenBefore = m.daysSeen;
  m._rollDay();
  check(m.streak === 1, '**隔了三天 → 归 1**（断了就是断了）');
  check(m.daysSeen === seenBefore + 1,
        '**「一共见过几天」只 +1，不是 +3** —— 机器休眠会一次跳过好几天');

  const same = m.streak;
  m._rollDay();
  check(m.streak === same, '同一天再调也不重复涨');
  m.dispose();
}

console.log('\n[7] 一天从早上 5 点算起（跟流水那边同一条线）');
{
  const d = (y, mo, day, h) => +new Date(y, mo - 1, day, h, 0);
  check(dayKey(d(2026, 8, 10, 2)) === dayKey(d(2026, 8, 9, 23)),
        '凌晨两点还算前一天 —— 熬夜写代码的人，按零点切会天天把连击弄断');
  check(dayKey(d(2026, 8, 10, 6)) !== dayKey(d(2026, 8, 9, 23)), '过了 5 点才翻篇');
}

console.log('\n[8] 忙着、或者你正专注的时候，一律不响');
{
  const m = new Mood({ storeDir: freshStore() });
  m.firstMet = Date.now() - 400 * DAY;

  m.busy = true;
  check(m._milestone() === null, '手上有活在跑 → 不响（她正忙着呢）');
  m.busy = false;

  m.quiet = true;
  check(m._milestone() === null, '番茄钟/小游戏专注期间 → 不响');
  m.quiet = false;

  check(m._milestone() !== null, '都不忙了 → 才响');
  m.dispose();
}

console.log('\n[9] 每条的表情都得是真表情（乱造一个的话脸不会动，还污染状态）');
{
  const prof = profileFor('models/Hiyori/Hiyori.model3.json');
  for (const ms of MILESTONES) {
    const mapped = prof && prof.faces ? (prof.faces[ms.state] || ms.state) : ms.state;
    const id = typeof ms.id === 'function' ? '(循环)' : ms.id;
    check(Boolean(mapped), id + ' 的表情 ' + ms.state + ' 认得出来');
  }
  check(MILESTONES.some((m) => typeof m.id === 'function'),
        '**末尾有循环兜底** —— 九条固定的三个月就攒完了，攒完不能永久沉默');
  check(MILESTONES.every((m) => m.lines && m.lines.length >= 2),
        '每条至少两句轮着说，不当复读机');
}

console.log('\n[+] 账本里程碑：烧满一百刀、聊满一千轮，各说一句');
{
  const m = new Mood({ storeDir: freshStore(), getTotals: () => ({ costUsd: 120, turns: 1200 }) });
  const win = m._milestone();
  check(Boolean(win) && win.id === 'turns1000',
        '头一回对齐只说最有分量的：turns1000（拿到 ' + (win && win.id) + '）');
  check(m.hit.has('usd100'), 'usd100 一并记上，不再逐日补发');
  const m2 = new Mood({ storeDir: freshStore() });
  check(m2._milestone() === null, '没注入账本就一条不响 —— 里程碑绝不读真实数据目录');
;
}

console.log('');
console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
