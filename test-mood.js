'use strict';

// 验证心情状态机：情绪变化是不是真的跟着「她干了什么」走。
// 用临时目录当存档，别污染真实的 mood.json。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Mood } = require('./src/mood');
const { profileFor } = require('./src/profiles');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-mood-'));
const m = new Mood({ storeDir: tmp });

let fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + label + ' -> ' + actual + (ok ? '' : ' (期望 ' + expected + ')'));
}

const seen = [];
m.on('change', (e) => seen.push(e));
function last() { return seen[seen.length - 1]; }

console.log('初始:', JSON.stringify(m.snapshot()));
console.log('');

console.log('派了个活给她：');
m.onTaskStart();
check('状态应为干活中', last().state, 'working');
check('该说句应答的话', typeof last().line === 'string' && last().line.length > 0, true);

console.log('');
console.log('连着撞墙三次：');
m.onTrouble(1);
check('错一次还撑得住', last().state, 'working');
m.onTrouble(2);
m.onTrouble(3);
check('错到第三次该烦了', last().state, 'frustrated');
console.log('       她说:', last().line);
const moodAfterErrors = m.snapshot().mood;

console.log('');
console.log('最后干成了：');
m.onTaskDone({ ok: true, elapsedMs: 90 * 1000, errorCount: 3 });
check('心情该回升', m.snapshot().mood > moodAfterErrors, true);
check('不再是忙碌状态', m.snapshot().busy, false);
console.log('       她说:', last().line);

console.log('');
console.log('一遍就过的情况（新的一轮）：');
m.mood = 70;
m.onTaskStart();
m.onTaskDone({ ok: true, elapsedMs: 20 * 1000, errorCount: 0 });
check('干净利落该开心', ['happy', 'proud', 'normal'].includes(last().state), true);
console.log('       她说:', last().line);

console.log('');
console.log('摸摸头：');
m.onInteract('pet');
check('该害羞', last().state, 'shy');
console.log('       她说:', last().line);

console.log('');
console.log('把精力抽干：');
m.energy = 10;
m.busy = false;
check('该犯困', m.computeState(), 'sleepy');

console.log('');
console.log('晾着她很久：');
m.energy = 80;
m.affection = 20;
check('该闹脾气', m.computeState(), 'lonely');

console.log('');
console.log('哪张脸是 profiles 的事，心情系统只吐状态：');
// 心情系统刻意不碰表情名 —— 每个模型的命名都不一样，混进来换个模型就得改状态机
check('haru 的害羞脸', profileFor('models/haru/haru_greeter_t03.model3.json').faceMap.shy, 'f06');
check('Hiyori 恒等映射（表情名就是状态名）', profileFor('models/Hiyori/Hiyori.model3.json').faceMap, null);

// Mao 的 8 个表情曾经因为「没核实过含义」而整张表空着 —— 那等于她一辈子只有一张脸。
// 现在是解 exp3.json 按参数认出来的：exp_08 改 MouthAngry 就是生气，
// exp_06 改 Cheek 就是脸红。每一条都必须指向真实存在的表情文件。
{
  const mao = profileFor('models/Mao/Mao.model3.json').faceMap;
  const names = new Set(Object.values(mao));
  check('Mao 的情绪映射补上了', Object.keys(mao).length >= 10, true);
  check('烦躁用的是那张生气脸', mao.frustrated, 'exp_08');
  check('害羞用的是那张脸红的', mao.shy, 'exp_06');
  check('指向的表情文件都真的存在', [...names].every(
    (n) => fs.existsSync(path.join(__dirname, 'models', 'Mao', 'expressions', n + '.exp3.json'))), true);
}

// 每个模型的造型切换里列的部件，命名一眼要能看出是哪个模型的 ——
// 抄错模型的部件 id 是不会报错的，只会静静地什么都不发生
{
  const hi = profileFor('models/Hiyori/Hiyori.model3.json').hairStyles;
  const mao = profileFor('models/Mao/Mao.model3.json').hairStyles;
  check('Hiyori 有备用造型', Boolean(hi && hi.down && hi.down.hide.length > 0), true);
  check('Mao 能脱外套（她是唯一真能换装的）',
        Boolean(mao && mao.casual && mao.casual.hide.includes('PartRobe')), true);
  check('每套造型第一项都是「原样」（hide 为空）',
        [hi, mao].every((s) => Object.values(s)[0].hide.length === 0), true);
}

console.log('');
console.log('聊天要用的那句状态描述：');
const desc = m.describe();
console.log('       「' + desc + '」');
check('说得出话来', desc.length > 8, true);

console.log('');
console.log('终端那边干完一段（只轻轻拨一下，不该翻脸也不该进入忙碌）：');
const before = m.snapshot();
m.busy = false;
m.onPhaseDone({ errorCount: 0 });
check('心情往上走了一点', m.snapshot().mood >= before.mood, true);
check('没被带成忙碌状态', m.busy, false);

console.log('');
console.log('陪你坐一整天，她该越来越累（以前这条从没发生过：精力每分钟 +2，永远顶在 100）：');
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-day-'));
  const d = new Mood({ storeDir: tmp2 });
  d.energy = 100; d.affection = 100; d.mood = 70;
  d.removeAllListeners();

  const marks = {};
  for (let min = 1; min <= 10 * 60; min++) {
    d.lastSeen = Date.now();     // 你一直在电脑前
    d.lastInteract = Date.now(); // 而且时不时理她一下（这条单独测）
    d.tick();
    if (min % 60 === 0) marks[min / 60] = { e: Math.round(d.energy), s: d.computeState() };
  }
  const row = (h) => h + 'h 精力' + String(marks[h].e).padStart(3) + ' → ' + marks[h].s;
  console.log('       ' + [2, 4, 6, 8, 10].map(row).join('   '));

  check('坐两小时还精神', marks[2].e > 70, true);
  check('六小时后该喊累了', ['tired', 'sleepy'].includes(marks[6].s), true);
  check('十小时后撑不住了', marks[10].e < 20, true);
  fs.rmSync(tmp2, { recursive: true, force: true });
}

console.log('');
console.log('**电脑不关机，人走开，她也得能歇过来**（这条以前是死的）：');
{
  // 用户实测撞出来的：「我让她休息一周，说了电脑不关机，她精神还是没回来」。
  // 存档里量到 energy: 0 —— 一点没冤枉。
  //
  // 根子是把「关机」当成了「休息」：回血只在桌宠**启动时**算一次，
  // 而且按 lastSeen（你上次碰键鼠）算。于是电脑常年开着的人，
  // 那段代码永远不再执行 → 精力是一条单向下坡路，终点 0，
  // 然后 computeState() 永远返回 sleepy。
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-rest-'));
  const d = new Mood({ storeDir: tmp3 });
  d.energy = 0;                 // 就从用户存档里那个真实数字开始
  d.affection = 90; d.mood = 60;
  d.removeAllListeners();

  const gone = Date.now() - 12 * 3600 * 1000; // 人走开十二小时了
  const marks = {};
  for (let min = 1; min <= 12 * 60; min++) {
    d.lastSeen = gone;          // 桌宠一直开着，但你人不在
    d.lastInteract = gone;
    d.tick();
    if (min % 180 === 0) marks[min / 60] = Math.round(d.energy);
  }
  console.log('       ' + [3, 6, 9, 12].map((h) => h + 'h 精力 ' + marks[h]).join('   '));

  check('歇三小时就明显回血了（以前是接着往下掉）', marks[3] > 25, true);
  check('**一夜不碰电脑就该回满**', marks[9] >= 99, true);
  check('回满了就不再是困的', d.computeState() !== 'sleepy', true);

  // 反过来也得守住：人回来了就该接着耗，不能变成永远满格
  d.energy = 100;
  for (let min = 1; min <= 6 * 60; min++) {
    d.lastSeen = Date.now();    // 你回来了，一直在电脑前
    d.lastInteract = Date.now();
    d.tick();
  }
  console.log('       人回来陪坐六小时后: 精力 ' + Math.round(d.energy));
  check('人一回来照样会累（没退回「永远顶在 100」那个老毛病）', d.energy < 50, true);

  fs.rmSync(tmp3, { recursive: true, force: true });
}

console.log('');
console.log('桌宠关掉的那段时间也要补上（而且不能跟上面那条重复补）：');
{
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-down-'));
  const file = path.join(tmp4, 'mood.json');
  const eightHAgo = Date.now() - 8 * 3600 * 1000;

  // 桌宠八小时前被关掉，关掉那一刻她精力只剩 10
  fs.writeFileSync(file, JSON.stringify({
    energy: 10, mood: 60, affection: 80,
    lastInteract: eightHAgo, lastSeen: eightHAgo, lastTick: eightHAgo,
  }));
  const d = new Mood({ storeDir: tmp4 });
  d.removeAllListeners();
  console.log('       关了八小时再开: 精力 10 → ' + Math.round(d.energy));
  check('关机那段时间补上了', d.energy > 80, true);

  // 老存档没有 lastTick，得退回 lastSeen，不能炸
  fs.writeFileSync(file, JSON.stringify({
    energy: 10, mood: 60, affection: 80,
    lastInteract: eightHAgo, lastSeen: eightHAgo,
  }));
  const d2 = new Mood({ storeDir: tmp4 });
  d2.removeAllListeners();
  check('老存档（没有 lastTick）照样能用', d2.energy > 80, true);

  // 【关键】人就坐在电脑前时重启桌宠，不该凭空补一大截 ——
  // 那段时间 tick 一直在算，补了就是重复计算
  fs.writeFileSync(file, JSON.stringify({
    energy: 30, mood: 60, affection: 80,
    lastInteract: Date.now(), lastSeen: Date.now(), lastTick: Date.now(),
  }));
  const d3 = new Mood({ storeDir: tmp4 });
  d3.removeAllListeners();
  check('**刚关了又开，不许凭空回血**（否则重启就是回血外挂）',
        Math.round(d3.energy) === 30, true);

  fs.rmSync(tmp4, { recursive: true, force: true });
}

console.log('');
console.log('人在旁边却晾着她 vs 人压根不在 —— 这两件事不该一样：');
{
  const mk = () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-away-'));
    const d = new Mood({ storeDir: t });
    d.energy = 80; d.affection = 100; d.mood = 60;
    d.removeAllListeners();
    return { d, t };
  };

  const ignored = mk();   // 你就在电脑前，只是不理她
  const gone = mk();      // 你人不在
  const long = Date.now() - 3 * 3600 * 1000;

  for (let min = 1; min <= 3 * 60; min++) {
    ignored.d.lastSeen = Date.now();  // 键鼠一直在动
    ignored.d.lastInteract = long;    // 但三小时没碰过她
    ignored.d.tick();

    gone.d.lastSeen = long;           // 人早走了
    gone.d.lastInteract = long;
    gone.d.tick();
  }

  console.log('       晾着她三小时 → 亲密度 ' + Math.round(ignored.d.affection) +
              '，她' + (ignored.d.computeState() === 'lonely' ? '闹脾气了' : '还好'));
  console.log('       你不在三小时 → 亲密度 ' + Math.round(gone.d.affection) +
              '，她' + (gone.d.computeState() === 'lonely' ? '闹脾气了' : '还好'));

  check('被晾着掉得明显', ignored.d.affection < 70, true);
  // 人不在时也会掉一点点（她毕竟一个人待着），但要慢一个数量级。
  // 这里 lastSeen 是钉死在三小时前的，所以每一拍都按「已经走了三小时」算，
  // 比真实情况扣得还多一些 —— 真跑起来只会更温和
  check('人不在的时候她基本能理解', gone.d.affection > 85, true);
  check('晾久了真的会闹脾气（README 吹了很久的功能）',
        ignored.d.affection < gone.d.affection - 20, true);

  fs.rmSync(ignored.t, { recursive: true, force: true });
  fs.rmSync(gone.t, { recursive: true, force: true });
}

console.log('');
console.log('亲密度涨得越高越难涨（以前每次固定 +3，跑几天就焊死在 100）：');
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-warm-'));
  const d = new Mood({ storeDir: t });
  d.removeAllListeners();
  d.affection = 20; d._warmUp(3);
  const lowGain = d.affection - 20;
  d.affection = 95; d._warmUp(3);
  const highGain = d.affection - 95;
  console.log('       刚认识时摸一下 +' + lowGain.toFixed(2) +
              '，很熟了之后再摸 +' + highGain.toFixed(2));
  check('生疏时涨得快', lowGain > 2, true);
  check('熟了之后涨得慢', highGain < 0.7, true);
  fs.rmSync(t, { recursive: true, force: true });
}

console.log('');
console.log('摸着不放 / 摸太久 / 你走开又回来：');
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-touch-'));
  const d = new Mood({ storeDir: t });
  d.removeAllListeners();

  // 这个 d 是新实例，上面那个全局 last() 抓的是 m 的事件，在这儿会读到陈旧数据。
  // 单独接一份
  const got = [];
  d.on('change', (e) => got.push(e));
  const lastOf = () => got[got.length - 1] || {};
  const said = () => got.filter((e) => e.line).length;

  // 按住不放：数值动一点，但**不说话** —— 身体那层已经在演了，再说就抢戏
  d.affection = 50; d.mood = 50;
  d.onPetHold();
  console.log('       按住不放：好感 50 → ' + d.affection.toFixed(2));
  check('按住会涨一点好感', d.affection > 50, true);
  // 松手那下会正常走 onInteract('pet') 拿它那一档的加分，
  // 两边都给满就成了「按住三秒等于摸了两次」
  check('但涨得比一次完整摸头少', d.affection - 50 < 1.5, true);
  check('按住的时候不说话（身体已经把话说完了）', said() === 0, true);

  // 摸太久：这个反倒**必须**说话，不然你不知道自己干了什么让她躲
  d.onPetLong();
  console.log('       摸太久：好感掉到 ' + d.affection.toFixed(2) + '，她说「' + lastOf().line + '」');
  check('摸太久要扣好感', d.affection < 50.9, true);
  check('而且会抗议一声', Boolean(lastOf().line), true);
  check('躲开时是烦躁的脸', lastOf().state === 'frustrated', true);

  // 走开又回来
  d.affection = 40; d.mood = 40;
  d.onReturn(30);
  console.log('       走开 30 分钟回来：她说「' + lastOf().line + '」（' + lastOf().state + '）');
  check('回来了好感涨一点', d.affection > 40, true);
  check('见到你心情也好一点', d.mood > 40, true);
  check('走开半小时 → 高兴', lastOf().state === 'happy', true);

  d.onReturn(200);
  console.log('       走开三小时回来：她说「' + lastOf().line + '」（' + lastOf().state + '）');
  check('走开太久 → 是闹脾气不是高兴', lastOf().state === 'lonely', true);

  d.dispose();
  fs.rmSync(t, { recursive: true, force: true });
}

console.log('');
console.log('存档验证：');
m.save();
const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'mood.json'), 'utf8'));
check('数值落盘了', typeof saved.mood === 'number' && typeof saved.affection === 'number', true);

m.dispose();
console.log('');
console.log(fail === 0 ? '全部通过' : (fail + ' 项没过'));
process.exit(fail === 0 ? 0 : 1);
