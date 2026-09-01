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

console.log("\n[7] 标题栏拖拽区里的可点元素必须豁免 no-drag");
{
  // header 整条是 -webkit-app-region: drag，落在里面的元素点击会被窗口拖拽
  // **静默吃掉** ——「点我更新」死点没反应就是栽在这儿（实机反馈，2026-08-24）
  const phtml = read('src/renderer/panel.html');
  const verBlock = phtml.slice(phtml.indexOf('#ver {'), phtml.indexOf('#ver {') + 400);
  check(verBlock.includes('no-drag'), '#ver（版本号/点我更新）豁免了拖拽');
}

console.log('\n[6] 拖动她不许用 setPosition / 现读现写尺寸');
{
  // 显示缩放不是 100% 的机器上，setPosition（以及 getSize 读回再写）每趟
  // 都被 DIP↔物理像素的四舍五入撑大 1px，拖动高频调用 = 拖着拖着她变大。
  // 发给别人的机器上实测撞过（2026-08-22）。只许 setBounds + 写死的 petWinSize
  const dragBody = main.slice(main.indexOf("ipcMain.on('pet:drag'"), main.indexOf("ipcMain.on('pet:drag'") + 1600);
  check(dragBody.length > 100, "pet:drag 的处理还得在 main.js 里");
  check(!dragBody.includes('setPosition'), '拖动不许用 setPosition（缩放屏上会把窗口撑大）');
  check(!dragBody.includes('getSize'), '拖动不许现读窗口尺寸（读回的是被撑大的值，形成回路）');
  check(dragBody.includes('petWinSize') && dragBody.includes('setBounds'),
        '拖动用 setBounds + 建窗时定死的 petWinSize');
}

console.log('\n[8] 跨作用域调用：定义在 A 函数里、却在 B 函数里被调的，一律红');
{
  // 踩过一次（2026-08-25）：registerHotkey 定义在 createTray() 内部，而设置
  // 保存那条路在 wireIpc() 里调它 —— ReferenceError 被 handler 的 try/catch
  // 吞掉，用户看到的是「保存成功了但快捷键按了没反应」。**node --check 查不出**
  // 这种事（语法完全合法），只能靠这条断言。
  const src = read('src/main.js');
  const lines = src.split('\n');
  // 顶层函数（顶格 function）不管；只盯缩进的嵌套函数
  const nested = [];   // { name, from, to, owner }
  let topFn = null, topFrom = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = /^function (\w+)/.exec(lines[i]);
    if (t) { topFn = t[1]; topFrom = i; continue; }
    const n = /^  function (\w+)\s*\(/.exec(lines[i]);
    if (n && topFn) nested.push({ name: n[1], owner: topFn, line: i + 1 });
  }
  // 每个嵌套函数：看它在**别的顶层函数**里有没有被调用
  const bad = [];
  for (const fn of nested) {
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const t = /^function (\w+)/.exec(lines[i]);
      if (t) { cur = t[1]; continue; }
      if (cur && cur !== fn.owner && new RegExp('(?:^|[^\\w.])' + fn.name + '\\s*\\(').test(lines[i])) {
        // 定义那行本身不算
        if (i + 1 === fn.line) continue;
        bad.push(fn.name + '（定义在 ' + fn.owner + '，却在 ' + cur + ' 第 ' + (i + 1) + ' 行被调）');
        break;
      }
    }
  }
  check(bad.length === 0, '没有跨作用域调用' + (bad.length ? '：' + bad.join('；') : ''));
}
console.log('\n[9] 留着的线那排 chip：不许裂、不许没头没脑');
{
  // 实拍反馈：线名是从任务原话自动取的，一长就在 chip 内部断行 ——
  // 一个圆角块裂成上下两半，看着像浮在别的东西上面
  const html = read('src/renderer/panel.html');
  const lanesCss = html.slice(html.indexOf('#lanes {'), html.indexOf('#lanes {') + 400);
  check(lanesCss.includes('display: flex'), '#lanes 是 flex 容器（普通 block 会让 chip 内部断行）');
  check(lanesCss.includes('white-space: nowrap') && lanesCss.includes('text-overflow: ellipsis'),
        'chip 一行到底 + 省略号（一条线永远是一个完整的小块）');
  const js = read('src/renderer/panel.js');
  check(js.includes('lanes-label') && js.includes('接着聊：'),
        '这排有小标题说明它是什么（没有的话用户问「这些怎么会在上面」）');
  check(js.includes('raw.slice(0, 8)') && js.includes('c.title = raw'),
        '线名截短显示、全文进 title（chip 不是拿来读任务的）');
}
console.log('\n[10] 派活那一栏：一屏装得下');
{
  const html = read('src/renderer/panel.html');
  const js = read('src/renderer/panel.js');
  const css = html.slice(html.indexOf('.col-form {'), html.indexOf('.col-form {') + 700);

  check(css.includes('flex-direction: column'),
        '左栏是 flex 列 —— 原来是「一列 + overflow-y」，实测 780×700 下溢出 143px，两个按钮永远在屏幕外');
  { const t = html.slice(html.indexOf('#task { flex'), html.indexOf('#task { flex') + 80);
    check(t.includes('flex: 1 1 auto') && t.includes('min-height'),
          '任务框吃掉剩下的高度（窗口拉多高它就多高），但有下限兜着'); }

  check(html.includes('<details class="setup" id="setup">') &&
        html.includes('id="setup-sum"') && html.includes('id="setup-lane"'),
        '四个旋钮收进折叠横条（用谁来干 / 模型 / 放她多开 / 线名）');
  // 四个 id 一个都不能丢：panel.js 到处按 id 取它们
  for (const id of ['agent', 'model', 'perm', 'lane']) {
    check(html.includes('id="' + id + '"'), '收起来之后 #' + id + ' 还在（panel.js 按 id 取它）');
  }
  check(js.includes('function syncSetupSummary'),
        '**横条上要写着当前值** —— 只写「设置」两个字的话，每次派活前都得点开确认一遍，那还不如不折叠');
  { const fn = js.slice(js.indexOf('function syncSetupSummary'), js.indexOf('function syncSetupSummary') + 1200);
    check(fn.includes('dataset.short'),
          '摘要走 data-short：选项本身要写清楚，摘要要短，两个诉求不是一回事');
    check(fn.includes('模型跟它自己的设置'),
          'codex 的模型在它自己的配置里选 —— 摘要里报一个模型名是骗人'); }
  check(js.includes("for (const id of ['agent', 'model', 'perm'])") && js.includes("addEventListener('change', syncSetupSummary)"),
        '三个下拉任意一个动了摘要就跟着改（不跟的话它会一直说着上一次的配置，而且是静默的）');
  check(js.includes('syncSetupSummary();   // 线名是横条上那个小紫块'),
        '线名自动取的那条路也要刷摘要');
  check(js.includes("localStorage.getItem('waifu.setupOpen')"),
        '展开还是收着记在这台机器上');
  { const ag = js.slice(js.indexOf('function syncAgentUi'), js.indexOf('function syncAgentUi') + 2800);
    check(ag.includes('syncSetupSummary();'),
          'syncAgentUi 末尾也要刷 —— 它会改写选项文字，摘要得跟着重算'); }
  check(js.includes("'claude-sonnet-5': ['Sonnet 5', 'Sonnet 5 · 省一半']") && html.includes('data-short="跟设置走"'),
        '选项文字要短：格子只有 ~150px 宽，长句子会被浏览器生切在半截（实拍「Claude Code ——」）');
  // 窄面板下的两桩「压扁就竖排」（用户实拍）
  check(html.includes('#lanes .chip, #recent .chip { flex: none; white-space: nowrap; }'),
        '那两排 chip 不许被压扁 —— 面板一窄，每个 chip 会被压成一列竖着的字，整排炸成一百多像素高');
  { const hd = html.slice(html.indexOf('  header {'), html.indexOf('  header {') + 400);
    check(hd.includes('white-space: nowrap'),
          '顶栏也不许折行（不然标题变成「给她派 / 个活」、按钮变成「说 / 明 / 书」）'); }
  check(html.includes('header button, header select#skin { flex: none; }'),
        '顶栏那几个按钮也要 flex:none —— nowrap 只管字，不管它自己被压扁');
  // 「别滚动了，往下自适应排一下」—— 十个项目换行排下去，一个都不藏
  check(html.includes('#lanes, #recent { flex-wrap: wrap; }'),
        '那两排装不下就**往下排**（横着滚那版被否了：右边那几个既看不见也够不着）');
  check(!html.includes("classList.toggle('more'") && !js.includes('function hscroll'),
        '横滚那套（滚轮劫持 + 边缘淡出）已经拆干净，别留着两套并存');
  check(js.includes('.slice(0, 10)'), '最近项目留 10 个');
  check(html.includes('.col-form:has(#setup[open]) #recent { display: none; }'),
        '**设置展开时把那排先收起来** —— 10 个项目是 109px，不收的话 640×560 那档溢出 110px、按钮又被顶出屏幕（实测）');
  check(html.includes('#lanes:empty, #recent:empty { display: none; margin: 0; }'),
        '一个项目都没有时那排连边距都不占（空 div 的 margin 照样占地方）');
  { const body = html.slice(html.indexOf('<div class="setup-body">'), html.indexOf('</details>'));
    check(!body.includes('class="sub"'),
          '**展开那四格的标签一律一行** —— 标签后面挂小字的话，格子只有 ~150px 宽，' +
          '左边那个挤成两行、右边那个一行，左右两列的控件就错开一截（用户实拍）');
    check((body.match(/title="/g) || []).length >= 4,
          '说明文字全挪进了控件的 title，一个字没少'); }
  { const lab = html.slice(html.indexOf('.setup-body label {'), html.indexOf('.setup-body label {') + 160);
    check(lab.includes('white-space: nowrap'), '标签写死不折行（双保险：以后再塞小字也不会错开）'); }
  check(html.includes('.setup-body { align-items: start; }'),
        '四个格子从顶上对齐 —— 行高再有差别控件也在同一条线上');

  check(html.includes('@media (max-height: 640px) { #task { min-height: 56px; } }'),
        '窗口压矮时任务框的下限也让一让 —— 它是唯一能长回去的那个');

  check(html.includes('.col-form:has(#setup[open]) #task'),
        '设置展开时任务框下限放宽 —— 不放的话 640×560 那档会溢出 43px，按钮又被顶出屏幕（实测）');
  check(js.includes('PERM_CLAUDE_FULL') && js.includes('PERM_CODEX_FULL'),
        '完整说法挪进 title，一个字都没少');
}

console.log('\n[11] 拖文件进面板');
{
  const js = read('src/renderer/panel.js');
  const pre = read('src/preload.js');
  const main = read('src/main.js');
  const drop = js.slice(js.indexOf('function dropZone'), js.indexOf('function dropZone') + 2600);

  check(/addEventListener\('dragover'/.test(drop) && /addEventListener\('drop'/.test(drop),
        '两个事件都接了（dragover 不接的话浏览器根本不让你放）');
  check((drop.match(/stop\(e\)/g) || []).length >= 4,
        '**每一个都 preventDefault** —— 不拦的话 Electron 会直接把面板窗口导航到那个文件，回不来');
  check(drop.includes('[...files]'),
        'FileList 要摊成数组 —— 过了 contextBridge 就不可迭代了（实测炸过）');
  check(drop.includes("kind === 'dir'") && drop.includes("$('dir').value = dirs[0].path"),
        '文件夹 → 填进项目目录');
  check(drop.includes("$('task').value") && /\/\\s\/\.test\(x\.path\)/.test(drop),
        '别的文件 → 路径填进任务框，带空格的包引号（不包的话那条线拿到的是两段）');
  check(!drop.includes("dispatchEvent(new Event('input'))"),
        '**别派 input** —— 线名跟着任务描述走，这会儿框里只有路径，取出来是「"D:/shots/图 1.」这种鬼东西');

  check(pre.includes('classifyDrop') && pre.includes('webUtils.getPathForFile'),
        '真路径只能在 preload 里取（Electron 32 起 File.path 没了）');
  check(!/classifyDrop[^]{0,300}for \(const/.test(pre),
        'preload 里按下标遍历，不用 for…of（FileList 过桥后不可迭代）');
  check(main.includes("ipcMain.handle('panel:drop'") && main.includes('desk.kindOf'),
        '认类型走 desk.kindOf —— 跟拖到她身上是**同一套判据**，别另造一份');
  check(!/function classifyDrop[^]{0,700}readFileSync/.test(main),
        '只认类型，**不读内容** —— 读不读是那条线自己的事（也是省钱）');
}

console.log('\n[12] 模型下拉：刷多少遍都不许长出空组');
{
  // 点开下拉那一下面板窗口会失焦再回焦 → focus 里的 fillModelSelect 又跑一遍。
  // 只 remove(option) 会把空壳的 <optgroup> 留在原地，每点一次多一行「官方」（实测截图见 08-31）
  const js = read('src/renderer/panel.js');
  const mob = read('src/renderer/mobile.html');
  const fill = js.slice(js.indexOf('async function fillModelSelect'), js.indexOf('let modelBeforeCodex'));
  check(fill.includes("querySelectorAll('optgroup')") && fill.includes(') g.remove()'),
        'panel：清下拉要连 <optgroup> 一起删');
  check(!fill.includes('sel.remove(1)'), 'panel：不许再用 remove(1) 那种只删 option 的清法');
  check(fill.includes('dataset.sig') && fill.includes('if (sel.dataset.sig === sig) return'),
        'panel：名单没变就不重画（重画会把正选着的冲掉）');
  const mfill = mob.slice(mob.indexOf('模型下拉：按接入点分组'), mob.indexOf('模型下拉：按接入点分组') + 1200);
  check(mfill.includes("querySelectorAll('optgroup')") && mfill.includes(') g.remove()') && !mfill.includes('sel.remove(1)'),
        '手机端：同一处同一个坑，也得连组一起删');
}

console.log('\n[13] 任务列表的时间：面板按状态换说法');
{
  const js = read('src/renderer/panel.js');
  check(js.includes('function fmtAgo'), '有「啥时候完的」格式化（几分钟前 / 钟点 / 跨天带日期）');
  check(js.includes("t.status === 'waiting'") && js.includes('waitedMs'),
        '等确认那条用的是「等了多久」，不是「干了多久」');
  check(js.includes('endedAt'), '完事的那条显示「啥时候完的」');
  check(js.includes('t.exitCode != null'),
        'exitCode 用宽松比较 —— undefined 不许被当成「异常退出」');
}

console.log('');
console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
