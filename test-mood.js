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
console.log('精力跟着**她的活**走，不跟你的键鼠走（重构后的核心语义）：');
{
  // 上一版的病根：你的键鼠在动 = 她在耗精力。可键鼠动的是你 ——
  // 机器上总有动静，她永远没有休息窗口，真实存档量到 energy 死在 0。
  // 现在：自己干活最费、盯你的终端小费、都没有就回血（跟你在不在无关）。
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-day-'));
  const d = new Mood({ storeDir: tmp2 });
  d.energy = 90; d.affection = 60; d.mood = 70;
  d.removeAllListeners();

  // 你在电脑前敲了四小时代码，但她手上没活：她该歇着，不该累
  for (let min = 1; min <= 4 * 60; min++) {
    d.lastSeen = Date.now(); d.lastInteract = Date.now();
    d.tick();
  }
  console.log('       你敲四小时代码（她没活）→ 精力 ' + Math.round(d.energy));
  check('你忙你的，她没活就不累（键鼠不再扣她精力）', d.energy >= 90, true);

  // 她自己闷头干活四小时：明显累
  d.energy = 90; d.busy = true;
  for (let min = 1; min <= 4 * 60; min++) { d.tick(); }
  d.busy = false;
  console.log('       她自己干四小时活 → 精力 ' + Math.round(d.energy));
  check('自己干活会真累', d.energy < 25, true);

  // 盯着你开的终端八小时：也累，但慢得多
  d.energy = 90; d.watching = 2;
  for (let min = 1; min <= 8 * 60; min++) { d.tick(); }
  d.watching = 0;
  console.log('       盯你终端八小时 → 精力 ' + Math.round(d.energy));
  check('盯梢费神但远小于自己干', d.energy > 5 && d.energy < 60, true);
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

  // 反过来的守则改了：满格不再是毛病 —— 只要她**手上有活**就会耗。
  // 「永远满格」的旧病根（+2/分无脑回血）靠「干活必扣」堵住
  d.energy = 100; d.busy = true;
  for (let min = 1; min <= 3 * 60; min++) { d.tick(); }
  d.busy = false;
  console.log('       满格接一个三小时的活: 精力 ' + Math.round(d.energy));
  check('有活干就绝不可能焊死在满格', d.energy < 30, true);

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
    // 从「还算热络」起步（重构后 100 是要维护的高位，不是常态）
    d.energy = 80; d.affection = 55; d.mood = 60;
    d.removeAllListeners();
    return { d, t };
  };

  const ignored = mk();   // 你就在电脑前，只是不理她
  const gone = mk();      // 你人不在
  const long = Date.now() - 6 * 3600 * 1000;

  for (let min = 1; min <= 6 * 60; min++) {
    ignored.d.lastSeen = Date.now();  // 键鼠一直在动
    ignored.d.lastInteract = long;    // 但三小时没碰过她
    ignored.d.tick();

    gone.d.lastSeen = long;           // 人早走了
    gone.d.lastInteract = long;
    gone.d.tick();
  }

  console.log('       晾着她六小时 → 亲近 ' + Math.round(ignored.d.affection) +
              '，她' + (ignored.d.computeState() === 'lonely' ? '闹脾气了' : '还好'));
  console.log('       你不在六小时 → 亲近 ' + Math.round(gone.d.affection) +
              '，她' + (gone.d.computeState() === 'lonely' ? '闹脾气了' : '还好'));

  // 重构后放缓了（专注写两小时代码不算冷落）：晾一下午才看得出委屈
  check('被晾一下午掉得明显', ignored.d.affection < 35, true);
  check('人不在的时候她基本能理解', gone.d.affection > 45, true);
  check('晾久了真的会闹脾气（README 吹了很久的功能）',
        ignored.d.computeState() === 'lonely', true);

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

console.log('');
console.log('【重构新增】精力是日周期：睡醒重置，永远不会死在 0：');
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-roll-'));
  const d = new Mood({ storeDir: t });
  d.removeAllListeners();
  d.energy = 3;                       // 昨晚干到只剩 3
  d.lastDay = '2020-01-01';           // 假装上次见面是很久以前
  d._rollDay();
  console.log('       昨晚剩 3 → 新的一天精力 ' + Math.round(d.energy));
  check('睡醒重置到高位（日周期的保证书）', d.energy >= 86, true);
  d.energy = 95; d.lastDay = '2020-01-02'; d._rollDay();
  check('本来就更高就不动（不当回血外挂）', d.energy >= 95, true);
  fs.rmSync(t, { recursive: true, force: true });
}

console.log('');
console.log('【重构新增】亲密拆两层：亲近会回落、羁绊只进不退：');
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-bond-'));
  const d = new Mood({ storeDir: t, getTotals: () => ({ turns: 500, tasks: 80, costUsd: 0 }) });
  d.removeAllListeners();

  // 处了很久的人：见过 60 天、干成 40 个活、熬过 5 个夜
  d.daysSeen = 60; d.tasksDone = 40; d.nights = 5; d._bondCache = null;
  const b = d.bond();
  console.log('       60 天/40 活/5 夜/500 轮 → 羁绊「' + b.title + '」（' + b.xp + ' 经验，LV' + b.level + '）');
  check('羁绊等级算得出来', b.level >= 3, true);
  check('羁绊给亲近撑地板（处得深就回不到陌生）', b.floor > 20, true);

  // 亲近每天回落，但落不穿羁绊的地板
  d.affection = b.floor + 1;
  d.lastDay = '2020-01-01'; d._rollDay();
  check('每日回落不穿地板', d.affection >= b.floor, true);

  // 羁绊升级要道喜
  const events = [];
  d.on('milestone', (e) => events.push(e));
  d.lastBondLevel = 0; d._bondCache = null;
  d._bondCheck();
  check('升级道喜（只有好事的那个口）', events.length === 1 && /羁绊/.test(events[0].text), true);
  d._bondCheck();
  check('同级不重复道喜', events.length, 1);
  fs.rmSync(t, { recursive: true, force: true });
}

console.log('');
console.log('【重构新增】老存档迁移：焊死的 100 压一档迁入，死 0 的精力救活：');
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-mig-'));
  fs.writeFileSync(path.join(t, 'mood.json'), JSON.stringify({
    energy: 0, mood: 84, affection: 100,   // 用户真实存档就长这样
    lastInteract: Date.now(), lastSeen: Date.now(), lastTick: Date.now(),
  }));
  const d = new Mood({ storeDir: t });
  d.removeAllListeners();
  console.log('       旧 {精力0 亲密100} → 新 {精力' + Math.round(d.energy) + ' 亲近' + Math.round(d.closeness) + '}');
  check('焊死的 100 迁成有上涨空间的高位', d.closeness > 60 && d.closeness < 75, true);
  check('死 0 的精力救活（迁移完第一天不能还是困脸）', d.energy >= 60, true);
  // 新存档写盘后再读，不再走迁移
  d.closeness = 80; d.save();
  const d2 = new Mood({ storeDir: t });
  d2.removeAllListeners();
  check('新字段落盘后原样读回（不重复迁移）', Math.round(d2.closeness), 80);
  // 老名字也还写着 —— 万一降回旧版本，不失忆
  const raw = JSON.parse(fs.readFileSync(path.join(t, 'mood.json'), 'utf8'));
  check('存档里保留老名字 affection（降级回旧版不失忆）', Math.round(raw.affection), 80);
  // 评审抓过的三条，钉死：
  // ① 地板永远压在 lonely 阈值（25）之下 —— 顶穿的话老用户永不闹脾气
  d.daysSeen=999;d.tasksDone=999;d.nights=99;d._bondCache=null;
  check('满级羁绊的地板也顶不穿 lonely 阈值', d.bond().floor < 25, true);
  // ② 低于地板的不许被冷落分支反向抬回地板
  d.closeness=10;d._coolDown(1);
  check('低于地板时冷落不涨好感', d.closeness, 10);
  // ③ 道喜必须排在 tick 的 _sync 之后（同拍冲掉那个坑）
  const src=fs.readFileSync(require('path').join(__dirname,'src','mood.js'),'utf8');
  const tickBody=src.slice(src.indexOf('tick()'));
  check('羁绊道喜排在常规 _sync 之后（不被同拍冲掉）',
        tickBody.indexOf('_bondCheck') > tickBody.indexOf('_sync(tick'), true);
  fs.rmSync(t, { recursive: true, force: true });
}

console.log(fail === 0 ? '全部通过' : (fail + ' 项没过'));
process.exit(fail === 0 ? 0 : 1);
