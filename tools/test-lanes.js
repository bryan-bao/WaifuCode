'use strict';

// 任务线：同一个目录同时开好几个终端，各问各的，**绝不串味**。
//
// 这个自检守两件事。
//
// 一、**开终端永远不接上次的记录。** 用户明确要的：每次点开都是干净的一条，
//     想接着上次聊他自己敲 /resume。只有在面板上点某条老线的「接着聊」
//     （给了 laneId）才准 --resume。
//
// 二、**任何两条同时活着的线，绝对不能拿到同一个 sessionId。**
//     以前同目录只准开一个终端，理由是硬的：两个进程同时 --resume 同一条会话，
//     记忆会被交错写坏 —— 而且是**事后根本查不出来**的坏，不报错，不崩，
//     只是她某天开始把两件事混着说。
//
// 不花钱、不起 claude、不开窗口，一瞬间跑完。

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionManager, projectStoreDir } = require('../src/sessions');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-lanes-store-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-lanes-proj-'));

// claude 会话落盘的地方。sessions.js 判断「这条会话还在不在」看的就是这儿，
// 所以要模拟「主会话真的存在」就得在这里放一个文件。
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects', projectStoreDir(PROJ));

const mkSession = (id) => {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_DIR, id + '.jsonl'), '{}\n');
};

function cleanup() {
  for (const d of [STORE, PROJ, CLAUDE_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 无所谓 */ }
  }
}

process.on('exit', cleanup);

const sm = () => new SessionManager({ storeDir: STORE, getConfig: () => ({}) });

// ---------------------------------------------------------------------------

console.log('\n[0] 地基：会话存放目录名必须跟 Claude Code 磁盘上的算法一致');
{
  // 【这条守的是一个正在造成失忆的真 bug。】
  //
  // 算错目录名 → sessionExists() 一口咬定「这条会话不在了」→ _resumableRecord
  // 换个新 id 重开 → 那个项目的记忆每次从头再来。而它一声不吭，日志里那句
  // 「上次那条会话已经不在了」看着完全像正常的自愈。
  //
  // 旧算法只折了冒号和斜杠，下划线和点没折。实地量过：本机 10 个项目错 2 个，
  // 其中 VR_Wukong 的 .jsonl 明明躺在磁盘上，却一直被判不在。
  const cases = [
    ['D:\\WaifuCode', 'D--WaifuCode'],
    ['E:\\chao-tool\\VideoTool', 'E--chao-tool-VideoTool'],
    ['D:\\UnityGame\\VR_Wukong', 'D--UnityGame-VR-Wukong'],   // 下划线也要折
    ['D:\\WaifuCode\\.testproj', 'D--WaifuCode--testproj'],   // 点也要折
  ];
  for (const [input, want] of cases) {
    const got = projectStoreDir(input);
    check(got === want, input + ' → ' + got + (got === want ? '' : '（该是 ' + want + '）'));
  }
  check(!/[^a-zA-Z0-9-]/.test(projectStoreDir('C:/a b/c.d_e')),
        '**任何非字母数字都得折成横线** —— 漏一种字符就是一个项目的记忆');
}

console.log('\n[1] 头一次开：干净的新会话');
let m = sm();
const main = m.prepareTerminal({ projectPath: PROJ });
check(Boolean(main.sessionId), '给出了会话 id');
check(main.resume === false, '不接旧记录');
check(Boolean(main.laneId), '记下了线 id（下次想回来靠它）');

console.log('\n[2] 再开一个：照样干净，绝不读上一条');
// 让上一条会话「真的落盘了」—— 以前正是这种情况会触发 --resume / --fork-session
mkSession(main.sessionId);
m = sm();
const a = m.prepareTerminal({ projectPath: PROJ, laneName: '登录页表单校验' });
check(a.sessionId !== main.sessionId,
      '**会话 id 跟上一条不是同一个** —— 这条破了就等于回到静默写坏记忆的老毛病');
check(a.resume === false,
      '**上一条明明就在磁盘上，也不接** —— 用户要的就是这个，他自己敲 /resume');
check(a.laneName === '登录页表单校验', '线名记下来了');
check(Boolean(a.laneId), '有线 id（下次靠它回到这条线）');

console.log('\n[3] 再开第三条：跟前两条都不撞');
const b = m.prepareTerminal({ projectPath: PROJ, laneName: '查支付回调' });
check(b.sessionId !== main.sessionId && b.sessionId !== a.sessionId,
      '**三条线三个会话 id，两两不同**');
check(b.laneId !== a.laneId, '线 id 也不撞');
check(b.resume === false, '还是干净的');

console.log('\n[4] 面板上点「接着聊」：这才是唯一准 --resume 的路');
mkSession(a.sessionId); // 那条线真的聊过了
const again = m.prepareTerminal({ projectPath: PROJ, laneId: a.laneId });
check(again.sessionId === a.sessionId, '**拿回的是那条线自己的会话**，不是别人的');
check(again.resume === true, '会话在磁盘上，所以是接着聊');
check(again.laneName === '登录页表单校验', '名字还是那个名字');

console.log('\n[5] 那条线的会话被删了，也不能瞎接');
const ghost = m.prepareTerminal({ projectPath: PROJ, laneId: b.laneId }); // b 从没落过盘
check(ghost.sessionId === b.sessionId, '还是用它自己的 id');
check(ghost.resume === false,
      '**接不上就别 --resume** —— 硬接会撞一行红字，活一点没干成');

console.log('\n[6] 全新的项目，第一次开也得开得出来');
const PROJ2 = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-lanes-fresh-'));
const m2 = new SessionManager({ storeDir: STORE, getConfig: () => ({}) });
const fresh = m2.prepareTerminal({ projectPath: PROJ2, laneName: '随便问问' });
check(fresh.resume === false, '没有旧记录，本来也不该接');
check(Boolean(fresh.sessionId), '给了个新会话 id，终端开得出来');
try { fs.rmSync(PROJ2, { recursive: true, force: true }); } catch (_) { /* 无所谓 */ }

console.log('\n[7] 不许无限攒线');
const m3 = sm();
const ids = [];
for (let i = 0; i < 9; i++) {
  ids.push(m3.prepareTerminal({ projectPath: PROJ, laneName: '线' + i }).laneId);
}
const kept = m3.lanes(PROJ);
console.log('    开了 9 条，留下 ' + kept.length + ' 条: ' + kept.map((l) => l.name).join('、'));
check(kept.length <= 5, '最多留 5 条（列表列不完，你也想不起来哪条是哪条）');
check(kept.some((l) => l.id === ids[ids.length - 1]), '**留下的是最近用过的**，不是最早的');

console.log('\n[8] 最要紧的一条：任何两条线都不共用会话');
const all = [main, a, b, fresh].concat(kept.map((l) => ({ sessionId: l.sessionId })));
const seen = new Set();
let dup = null;
for (const x of all) {
  if (seen.has(x.sessionId)) dup = x.sessionId;
  seen.add(x.sessionId);
}
console.log('    一共 ' + all.length + ' 条线，' + seen.size + ' 个不同的会话 id');
check(!dup, '**没有任何两条线共用一个会话 id**' + (dup ? '（撞的是 ' + dup + '）' : ''));

console.log('\n[9] 她在窗口里换了会话，这条线要跟过去');
{
  /**
   * 【这条守的是「接着聊」的命根子。】
   *
   * 我们开窗口时 `--session-id <自己发的>` 指一条新会话，但用户在窗口里敲
   * `/resume` 挑另一条（CLAUDE.md 里推荐的正是这个做法）、或者 `/clear` 一下，
   * claude 从此写的就是别的 jsonl —— 我们记的那个 id **一个字节都没落盘**。
   * 于是点「接着聊」时 sessionExists() 说那条不在，开出来的是条崭新的空会话。
   *
   * 实地翻过本机 registry：46 条线里 22 条的 jsonl 根本不存在，全是这个原因。
   * 真实 id 由 claude 的 hook 事件带上来（terminals.js 的 _rebindSession
   * → emit('claude-session') → main.js → 这儿）。
   */
  const m9 = sm();
  const lane = m9.prepareTerminal({ projectPath: PROJ, laneName: '查支付' });
  const REAL = 'ffffffff-ffff-ffff-ffff-ffffffffffff'; // 用户 /resume 挑中的那条
  mkSession(REAL);

  m9.rememberSession(PROJ, lane.laneId, REAL);
  const back = m9.prepareTerminal({ projectPath: PROJ, laneId: lane.laneId });
  check(back.sessionId === REAL, '**接着聊接的是她真正在写的那条**，不是我们发出去的空壳');
  check(back.resume === true, '那条真的在磁盘上，所以敢 --resume');
  check(back.laneName === '查支付', '线名没被冲掉');

  // 防呆：认不出来的一律不动，别把一条好线改瞎
  m9.rememberSession(PROJ, lane.laneId, '');
  check(m9.prepareTerminal({ projectPath: PROJ, laneId: lane.laneId }).sessionId === REAL,
        '空 id 不许覆盖（hook 事件缺字段时别把线改瞎）');
  m9.rememberSession(PROJ, 'L不存在的线', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
  check(m9.prepareTerminal({ projectPath: PROJ, laneId: lane.laneId }).sessionId === REAL,
        '线号对不上就当没发生（线可能已经被清掉了，这不是要紧事）');

  // 还是那条铁律：换完之后也不许跟别的线撞
  const other = m9.prepareTerminal({ projectPath: PROJ, laneName: '别的活' });
  check(other.sessionId !== REAL, '换过会话的线不许跟新开的线撞在一起');
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
