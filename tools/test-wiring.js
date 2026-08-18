'use strict';

// 接线检查：主进程发的事件，渲染层到底收不收得到。
//
// 这个自检是被一次真实事故逼出来的。`preload.js` 里有个**频道白名单**，
// 不在名单上的频道 `on()` 会**静默返回一个空函数** —— 不报错、不警告、
// 日志里也没有。于是：
//
//   主进程 send('pet:tint') → 白名单里没有 → 渲染层压根收不到 → 换配色点了没反应
//
// 一次加了四个新频道（pet:tint / pet:atlas / pet:welcome / voice:pending），
// **一个都没往白名单里加**，四个功能全是死的，而 test-stage 全过 ——
// 因为它用的是 mock-preload（没有白名单），而且直接调 waifuStage 的函数，
// 整条 IPC 路径根本没走。
//
// 所以这里不跑代码，纯粹对着源码做交叉核对：
//   1. 渲染层 `window.waifu.on('X')` 监听的 X，白名单里必须有
//   2. 主进程 `send('X')` 发出去的 X，白名单里必须有
//   3. 渲染层调的 `window.waifu.foo()`，真 preload 和 mock-preload 都得有
//
// 不花钱、不开窗口、一瞬间跑完。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const preload = read('src/preload.js');
const mockPreload = read('tools/mock-preload.js');
const main = read('src/main.js');

// 渲染层有哪几个文件在监听事件
const RENDERERS = ['src/renderer/stage.js', 'src/renderer/chat.js', 'src/renderer/panel.js',
                   'src/renderer/settings.js'];

// --- 白名单 -----------------------------------------------------------------
const allowBlock = /const allowed = \[([\s\S]*?)\];/.exec(preload);
const ALLOWED = new Set(
  allowBlock ? [...allowBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []);

console.log('\n[1] 白名单本身');
check(ALLOWED.size > 10, '解析出 ' + ALLOWED.size + ' 个频道');

console.log('\n[2] 渲染层监听的频道，白名单里都得有');
{
  const listened = new Map(); // channel -> 哪个文件
  for (const f of RENDERERS) {
    let src;
    try { src = read(f); } catch (_) { continue; }
    for (const m of src.matchAll(/waifu\.on\(\s*'([^']+)'/g)) {
      if (!listened.has(m[1])) listened.set(m[1], f);
    }
  }
  console.log('    渲染层一共监听 ' + listened.size + ' 个频道');

  const missing = [...listened].filter(([c]) => !ALLOWED.has(c));
  check(missing.length === 0,
        missing.length
          ? '**这些监听收不到消息**（白名单里没有）：' +
            missing.map(([c, f]) => c + ' ← ' + path.basename(f)).join('、')
          : '一个不落，全在白名单里');
}

console.log('\n[3] 主进程发出去的频道，白名单里也得有');
{
  // send('x', …) 是主进程往桌宠窗口推事件的统一出口
  const sent = new Set([...main.matchAll(/\bsend\(\s*'([^']+)'/g)].map((m) => m[1]));
  console.log('    主进程一共发 ' + sent.size + ' 种事件');

  const missing = [...sent].filter((c) => !ALLOWED.has(c));
  check(missing.length === 0,
        missing.length
          ? '**这些事件发出去就没了**：' + missing.join('、')
          : '一个不落，全在白名单里');
}

console.log('\n[4] 白名单里有、但没人监听的（多半是改名之后留下的）');
{
  const listened = new Set();
  for (const f of RENDERERS) {
    try {
      for (const m of read(f).matchAll(/waifu\.on\(\s*'([^']+)'/g)) listened.add(m[1]);
    } catch (_) { /* 没这个文件 */ }
  }
  const dead = [...ALLOWED].filter((c) => !listened.has(c));
  // 这个只报，不算错 —— 多留一条不会造成故障，只是没用
  console.log(dead.length ? '    ' + dead.join('、') : '    （没有）');
  check(true, '（只是提个醒，不算错）');
}

console.log('\n[5] 渲染层调的 window.waifu.xxx()，preload 里得有');
{
  const callsIn = (f) => {
    const out = new Set();
    try {
      for (const m of read(f).matchAll(/window\.waifu\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/g)) out.add(m[1]);
    } catch (_) { /* 没这个文件 */ }
    out.delete('on'); // on 是白名单那条路，上面查过了
    return out;
  };

  const all = new Set();
  for (const f of RENDERERS) for (const n of callsIn(f)) all.add(n);

  const missReal = [...all].filter((n) => !new RegExp('\\b' + n + '\\s*:').test(preload));
  check(missReal.length === 0,
        missReal.length ? '**真 preload 里没有**：' + missReal.join('、')
                        : '真 preload 全都有（' + all.size + ' 个方法）');

  // mock-preload 只服务 stage.js —— 自检窗口只加载那一个页面，
  // 聊天和面板用的那些方法它本来就用不上，别在这儿要求它全带
  const stageCalls = callsIn('src/renderer/stage.js');
  const missMock = [...stageCalls].filter((n) => !new RegExp('\\b' + n + '\\s*:').test(mockPreload));
  check(missMock.length === 0,
        missMock.length
          ? '**stage.js 用到、但 mock-preload 里没有**：' + missMock.join('、') +
            ' —— 自检窗口一调到就当场抛错，而它常常是在 mousemove 里调的，' +
            '表现出来是「窗口好好的，鼠标一动整个渲染层就死了」'
          : 'stage.js 用到的 mock-preload 都有（' + stageCalls.size + ' 个）');
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
