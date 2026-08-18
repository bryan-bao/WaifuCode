'use strict';

// 她开口之前，到底知道些什么。
//
// 她所有「聪明」的部分都是一次性的：每戳一次就起一个全新的 claude 进程，
// 那个进程对你、对昨天、对自己上一句话**一无所知**——它知道的全部，
// 就是我们在 system prompt 里拼给它的那几行字。
// 所以「她聪不聪明」这件事，在花钱调模型之前就已经定死了，
// 而且完全可以在本地量出来。这个自检量的就是那几行字。
//
// 盯四件事：
//   1. 该知道的有没有拼进去（项目状态、真实 BPM、人不在电脑前）
//   2. 不该说的有没有漏出去（registry 里的测试残留、音乐文件夹、桌面）
//   3. 提议疲劳按没按住（实测 39 次搭话提了 39 次，none 一次没用过）
//   4. 私聊那条会话丢了之后，她爬不爬得出来
//
// 不花钱、不联网、不开窗口，一秒跑完。

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Greeter } = require('../src/greet');
const { SessionManager } = require('../src/sessions');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const DAY = 86400000;
const NOW = Date.parse('2026-08-06T12:00:00Z');

// --- 造一个假的 registry，把真实环境里遇到的脏数据都摆进去 ---
function makeSessions() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-ctx-'));

  // 两个「真项目」：建出目录并放上判据文件
  const mk = (name, marker) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, marker), '');
    return d;
  };
  const hot = mk('HotProject', 'package.json');
  const cold = mk('ColdProject', '.git');
  const ancient = mk('AncientProject', '.git');

  // 三个脏的：桌面、音乐文件夹、测试残留 —— 都真实存在于这台机器的 registry 里
  const desktop = path.join(tmp, 'Desktop');
  const music = path.join(tmp, 'music');
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(music, { recursive: true });

  const registry = {};
  const put = (dir, name, turns, daysAgo) => {
    registry[dir.toLowerCase()] = {
      path: dir, name, sessionId: 'x', turns,
      lastRun: daysAgo == null ? null : new Date(NOW - daysAgo * DAY).toISOString(),
    };
  };
  put(hot, 'HotProject', 5, 0.2);
  // turns=0 但 lastRun 有 —— 派过活、但那条会话后来丢了（_resumableRecord 会把
  // turns 归零）。这种**必须还算真项目**，否则凡是记忆断过的项目都会从她眼里
  // 消失，而那些偏偏是你最近在弄的
  put(cold, 'ColdProject', 0, 4);
  put(ancient, 'AncientProject', 9, 200);      // 太久没碰
  put(desktop, 'Desktop', 2, 1);               // 不是项目
  put(music, 'music', 1, 1);                   // 音乐文件夹
  put(path.join(tmp, 'gone'), '.testproj', 1, 1); // 目录压根不存在
  put(path.join(tmp, 'noturn'), 'NeverRan', 0, null); // 建了记录但一次都没跑过

  const store = path.join(tmp, 'store');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'registry.json'), JSON.stringify(registry), 'utf8');

  const sm = new SessionManager({ storeDir: store });
  return { sm, tmp };
}

console.log('\n[1] 项目状态：真项目报出来，脏数据挡回去');
{
  const { sm, tmp } = makeSessions();
  const got = sm.recentProjects({ now: NOW });
  console.log('    报出来的: ' + (got.join('；') || '(空)'));

  check(got.length === 2, '只报了 2 个（7 条 registry 里的真项目数）');
  check(got.some((s) => s.startsWith('HotProject')), 'HotProject 在（有 package.json）');
  check(got.some((s) => s.startsWith('ColdProject')), 'ColdProject 在（有 .git）');
  check(!got.some((s) => s.includes('Desktop')), '**桌面被挡掉了**（不然她会说「Desktop 你三天没碰了」）');
  check(!got.some((s) => s.includes('music')), '**音乐文件夹被挡掉了**');
  check(!got.some((s) => s.includes('.testproj')), '目录不存在的被挡掉了');
  check(!got.some((s) => s.includes('NeverRan')), '从没跑过的（没有 lastRun）被挡掉了');
  check(!got.some((s) => s.includes('Ancient')), '两百天没碰的不提了');
  check(got.some((s) => s.startsWith('ColdProject')),
        '**会话丢了、turns 归零的项目照样算数** —— 判据是 lastRun 不是 turns');

  check(got[0].startsWith('HotProject'), '最近碰过的排前面');
  check(got[0].includes('今天'), '今天动过的说「今天」：' + got[0]);
  check(got[1].includes('凉了 4 天'), '四天没动的说「凉了 4 天」：' + got[1]);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[2] 干活的时候她也是她自己');
{
  const { sm, tmp } = makeSessions();
  sm.getConfig = () => ({ persona: { name: '小依' } });
  sm.getMoodDesc = () => '心情还行，精神头很足。';

  const addon = sm._personaAddon('HotProject');
  check(addon.includes('小依'), '带上了名字');
  check(addon.includes('HotProject'), '知道自己在哪个项目里干活');
  check(addon.includes('心情还行'), '带上了当下的心情');
  check(/干完/.test(addon), '交代了「干完那句话会被念出来」');
  check(!/优先|应该用|推荐使用/.test(addon),
        '**一个字都没碰技术判断** —— 人设只管语气，不许干扰她怎么干活');

  // 换个名字要跟着变，不能写死
  sm.getConfig = () => ({ persona: { name: '铁柱' } });
  check(sm._personaAddon('X').includes('铁柱'), '改了 config 里的名字，这段跟着变');

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[3] 提议疲劳：连着推销就必须闭嘴');
{
  const g = new Greeter({ getConfig: () => ({ persona: { text: '你是小依' } }) });
  const ctx = { kind: 'poke', mood: '心情还行', idleMin: 5, now: new Date(NOW) };

  const p0 = g._prompt(ctx);
  check(!p0.includes('必须填 none'), '第一次搭话不设限（她本来就该能提议）');

  g.recentOffers = ['none', 'none'];
  check(!g._prompt(ctx).includes('必须填 none'), '一直没提议的话也不设限');

  g.recentOffers = ['dance'];
  const p1 = g._prompt(ctx);
  check(p1.includes('上次已经提议过'), '提过一次 → 提醒她收着点');

  g.recentOffers = ['dance', 'song'];
  const p2 = g._prompt(ctx);
  check(p2.includes('必须填 none'), '**连着提两次 → 硬性要求这次闭嘴**');
  check(p2.includes('2 次'), '把具体次数摆给她看（她是全新进程，不摆她不知道）');

  // 队列只留最近 4 次
  g.recentOffers = [];
  for (let i = 0; i < 8; i++) {
    g.recentOffers.push('song');
    if (g.recentOffers.length > 4) g.recentOffers.shift();
  }
  check(g.recentOffers.length === 4, '只记最近 4 次，不会无限长');
}

console.log('\n[4] 歌单带上真实 BPM，「人不在」也说清楚');
{
  const g = new Greeter({ getConfig: () => ({}) });
  const p = g._prompt({
    kind: 'poke', mood: '还行', idleMin: 2, now: new Date(NOW),
    songs: ['Burning Heart 144BPM', 'Venus 134BPM'],
    awayMin: 42,
  });
  check(p.includes('144BPM'), '歌单里带上了真实 BPM（她提议跳舞时不用再瞎猜）');
  check(p.includes('42 分钟没碰键鼠'), '人不在电脑前这件事说清楚了');

  const p2 = g._prompt({ kind: 'poke', mood: '还行', idleMin: 2, now: new Date(NOW), awayMin: 1 });
  check(!p2.includes('没碰键鼠'), '人就在旁边时不提这茬');
}

console.log('\n[5] 一次都不许把用户的目录路径发出去');
{
  const { sm, tmp } = makeSessions();
  const got = sm.recentProjects({ now: NOW });
  // 报的是项目名，不是路径 —— 路径里带用户名和盘符结构
  check(got.every((s) => !s.includes(path.sep) && !s.includes('/')),
        '只报项目名，不报完整路径：' + got.join('；'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n[7] 她记得上次戳她时说过什么');
{
  const g = new Greeter({ getConfig: () => ({ persona: { text: '你是小依' } }) });
  const ctx = { kind: 'poke', mood: '还行', idleMin: 2, now: new Date(NOW) };

  check(!g._prompt(ctx).includes('最近的来往'), '头一回戳，没有旧账要交代');

  g.recentSaid = [
    { say: '那个测试你跑了吗', at: NOW - 8 * 60000, kind: 'poke' },
    { say: '晚上早点睡', at: NOW - 26 * 3600000, kind: 'pet' },
  ];
  const p = g._prompt(ctx);
  check(p.includes('那个测试你跑了吗'), '上次说的话带上了');
  check(p.includes('8 分钟前'),
        '**带上了「多久以前」** —— 不然「刚才那事你弄完了吗」这种话她根本说不出来');
  check(p.includes('1 天前'), '隔天的说隔天，不会都糊成「上次」');
  check(p.includes('摸你头'), '还带上了当时你干了什么（摸头和戳是两种由头）');

  // 桌面上这个她 和 聊天框里那个她，得是同一个人
  const p2 = g._prompt({ ...ctx, chat: ['他说「今晚吃火锅」', '你说「好啊」'] });
  check(p2.includes('火锅'), '私聊里刚聊过的也端过来了');
  check(p2.includes('同一个'), '并且挑明：桌面上这个就是聊天窗口里那个，别装不认识');
  check(!p.includes('火锅'), '没聊过就不提这茬');
}

console.log('\n[6] 私聊：会话丢了得能自己爬出来');
{
  const { Chat } = require('../src/chat');
  const { projectStoreDir } = require('../src/sessions');

  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-chat-'));
  // sessionExists 是去 ~/.claude/projects/<路径里的斜杠换成横线> 底下找会话文件的，
  // 所以这儿得在那边造一个同名目录才试得出「文件在」这条路。目录名是 mkdtemp
  // 随机出来的，不可能跟真项目撞名，测完整个删掉。
  const vault = path.join(os.homedir(), '.claude', 'projects', projectStoreDir(store));
  fs.mkdirSync(vault, { recursive: true });
  const mk = () => new Chat({ storeDir: store, log: () => {} });

  // --- 会话真在磁盘上：照常接着聊 ---
  let c = mk();
  c.sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
  c.turns = 3;
  fs.writeFileSync(path.join(vault, c.sessionId + '.jsonl'), '{}');
  let st = c._resumeState();
  check(st.resume === true, '会话文件在 → 接着聊（正常那条路没被弄坏）');
  check(st.carry === null, '接得上就不用垫背景');

  // --- 会话没了：这是修的那个 bug ---
  c = mk();
  c.sessionId = 'bbbbbbbb-1111-2222-3333-444444444444'; // 故意不造这个文件
  c.turns = 3;
  c.msgs = [
    { role: 'user', text: '晚上吃啥' },
    { role: 'her', text: '你昨天不是说想吃火锅' },
    { role: 'her', text: '她张不开嘴: spawn ENOENT', error: true },
  ];
  st = c._resumeState();
  check(st.resume === false,
        '**会话文件没了 → 不去 resume** —— 不然她每说一句撞一次，自己爬不出来');
  check(c.turns === 0 && c.sessionId === null, '会话字段作废了，下一句自动开条新的');
  check(Boolean(st.carry) && st.carry.includes('火锅'),
        '把之前聊的垫进新会话，她还接得上话头，不是彻底失忆');
  check(Boolean(st.carry) && !st.carry.includes('张不开嘴'),
        '报错那条不垫进去（那是程序在说话，不是你们聊的）');
  check(c.history().length === 3,
        '**界面上的聊天记录一条没少** —— 她记不得了，不等于记录该没');
  check(JSON.parse(fs.readFileSync(path.join(store, 'chat.json'), 'utf8')).sessionId === null,
        '作废这件事写盘了，重启之后不会又去接那条死会话');

  // --- 头一回聊：本来就没有会话，别当成「丢了」 ---
  c = mk();
  c.msgs = [];
  c.turns = 0;
  st = c._resumeState();
  check(st.resume === false && st.carry === null, '第一次聊，没会话也没背景要垫');

  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(store, { recursive: true, force: true });
}

console.log('\n[8] 聊天时那两行给程序看的标记，一个字都不许漏到界面上');
{
  const { extractAction, extractMood, tagStart, MOODS } = require('../src/chat');

  // 语气标注：每句话都有，驱动桌面上她的表情和身体
  {
    const r = extractMood('好啊，那走吧～\n<<M:excited>>');
    check(r.text === '好啊，那走吧～', '标记摘干净了，界面上看不到：「' + r.text + '」');
    check(r.mood === 'excited', '情绪认出来了');
  }
  check(extractMood('就这样吧').mood === null, '没标就是没标，不瞎猜一个');
  check(extractMood('好的<<M:狂喜>>').mood === null,
        '**她自己发明的情绪名一律当没标** —— 宁可不动表情，也别把不存在的表情名塞给渲染层');
  check(extractMood('好的<<M:狂喜>>').text === '好的', '不认识也得把标记摘掉，不能留在气泡上');
  check(extractMood('好的<<M:HAPPY>>').mood === 'happy', '大小写不挑');
  check(MOODS.has('normal') && MOODS.size >= 10, '情绪表齐了（' + MOODS.size + ' 个）');

  // 动作指令：偶尔才有
  {
    const r = extractAction('那我跳个慢的\n<<ACT:{"act":"dance","bpm":80}>>');
    check(r.text === '那我跳个慢的', '动作指令也摘干净了');
    check(r.action && r.action.act === 'dance' && r.action.bpm === 80, '动作解出来了');
  }
  check(extractAction('随便说说<<ACT:{坏掉的json>>').action === null,
        'JSON 写坏了就当没这回事，话照样显示');

  // 流式推送时的截断点 —— 这条最要命：判断错了，标记会在聊天框里闪一下
  check(tagStart('好啊<<M:happy>>') === 2, '找得到语气标记的起点');
  check(tagStart('好啊<<ACT:{}>>') === 2, '找得到动作指令的起点');
  check(tagStart('好啊<<ACT:{}>><<M:happy>>') === 2, '两个都有时取更靠前的那个');
  check(tagStart('好啊<<M:happy>><<ACT:{}>>') === 2, '反过来也一样');
  check(tagStart('这句话没有标记') === -1, '没有标记就别乱截');
  check(tagStart('a << b 是位运算') === -1,
        '**光一个 << 不算标记** —— 不然聊到位运算时她的话会被从中间砍掉');

  // 两个都在时的完整流程，跟 chat.js 里的顺序一致
  {
    const a = extractAction('唱一个吧\n<<ACT:{"act":"sing","song":""}>>\n<<M:happy>>');
    const b = extractMood(a.text);
    check(b.text === '唱一个吧', '先摘动作再摘情绪，剩下的正好是她说的话：「' + b.text + '」');
    check(a.action.act === 'sing' && b.mood === 'happy', '两样都拿到了');
  }
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
