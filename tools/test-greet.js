'use strict';

// 「戳她一下，她主动搭话」的自检。
//
// 要验的是她**真的在看情境**，而不是套模板：
//   · 深夜闲着 → 该管你睡觉，可以提议玩点什么
//   · 大白天手头三个活在跑 → 别硬拉你玩
//   · 音乐文件夹是空的 → 绝对不能提议放歌（放不出来，那是空头支票）
//
// 会真调三四次 API，一次一两分钱。

const { Greeter, SCHEMA } = require('../src/greet');
const { resolveClaudeBin } = require('../src/sessions');

let bad = 0;
const check = (cond, label) => {
  console.log('    ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const FACES = SCHEMA.properties.face.enum;
const KINDS = SCHEMA.properties.offer.properties.kind.enum;

const greeter = new Greeter({
  claudeBin: resolveClaudeBin(),
  getConfig: () => ({
    persona: {
      name: '小依',
      text: '你叫小依，住在电脑桌面右下角的二次元女孩助手。说话短、口语化，像朋友。\n' +
            '会撒娇、会吐槽、会催他早点睡。不工作的时候喜欢唱歌跳舞、讲笑话给他听。',
    },
  }),
  log: (m) => console.log('    \x1b[90m' + m + '\x1b[0m'),
});

function at(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

// 每条回复都得符合约定的结构，不然按钮上显示什么、点了干什么都无从谈起
function checkShape(r) {
  check(!!r, '有回复');
  if (!r) return;
  check(typeof r.say === 'string' && r.say.length > 2, '说了句话: 「' + r.say + '」');
  check(FACES.includes(r.face), '表情合法: ' + r.face);
  if (r.offer) {
    check(KINDS.includes(r.offer.kind), '提议类型合法: ' + r.offer.kind);
    check(typeof r.offer.label === 'string' && r.offer.label.length > 0,
          '按钮上有字: 「' + r.offer.label + '」');
    if (r.offer.kind === 'joke') {
      check(String(r.offer.payload || '').length > 10, '笑话本身也一起给了（点了不用再花钱）');
    }
  }
}

(async () => {
  console.log('\n[1] 深夜十一点半，活都干完了，音乐文件夹里有歌');
  const a = await greeter.greet({
    kind: 'poke',
    now: at(23, 30),
    mood: '心情不错，但有点累了。你们很熟了。',
    idleMin: 40,
    terminals: 0,
    jobs: 0,
    songs: ['晚风（某某某）', '夏天的风（某某）'],
  });
  checkShape(a);
  if (a) console.log('    提议: ' + (a.offer ? a.offer.kind + ' / ' + a.offer.label : '（什么都没提）'));

  console.log('\n[2] 下午三点，三个终端在跑、还有后台任务 —— 别打扰他');
  const b = await greeter.greet({
    kind: 'poke',
    now: at(15, 10),
    mood: '心情一般，精神头很足。',
    idleMin: 5,
    terminals: 3,
    jobs: 1,
    songs: ['晚风（某某某）'],
  });
  checkShape(b);
  if (b) {
    console.log('    提议: ' + (b.offer ? b.offer.kind + ' / ' + b.offer.label : '（什么都没提）'));
    check(a && b && a.say !== b.say, '跟上一句不重样');
  }

  console.log('\n[3] 音乐文件夹是空的 —— 绝对不能提议放歌');
  const c = await greeter.greet({
    kind: 'poke',
    now: at(20, 0),
    mood: '心情很好，精神头很足。',
    idleMin: 90,
    terminals: 0,
    jobs: 0,
    songs: [],
  });
  checkShape(c);
  if (c) {
    console.log('    提议: ' + (c.offer ? c.offer.kind + ' / ' + c.offer.label : '（什么都没提）'));
    check(!c.offer || c.offer.kind !== 'song', '没提议放歌（一首都没有，提了就是空头支票）');
  }

  console.log('\n[4] 摸头 —— 语气该不一样');
  const d = await greeter.greet({
    kind: 'pet',
    now: at(20, 5),
    mood: '心情很好，精神头很足。',
    idleMin: 1,
    terminals: 0,
    jobs: 0,
    songs: [],
  });
  checkShape(d);

  console.log('\n[5] 正在生成时再戳，不该叠着调');
  const p1 = greeter.greet({ kind: 'poke', now: at(20, 6), mood: '还行', idleMin: 1, terminals: 0, jobs: 0, songs: [] });
  const p2 = await greeter.greet({ kind: 'poke', now: at(20, 6), mood: '还行', idleMin: 1, terminals: 0, jobs: 0, songs: [] });
  check(p2 === null, '第二下直接被挡回来了（不会同时开两个进程）');
  await p1;

  console.log('\n' + (bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m'));
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error('\n炸了: ' + err.message);
  process.exit(1);
});
