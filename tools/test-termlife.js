'use strict';

// 终端在列表里的生死：窗口关掉了，那一条就该从「开着的终端」里消失。
//
// 不开真窗口、不花钱、也不去动你机器上任何进程 —— 唯一起的那个子进程
// 是 `cmd /c exit`，它自己立刻就退了，我们只是借它的 pid 用一下。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const {
  TerminalManager, pidAlive, spokenReport,
  checkDanger, isInside, filePathOf,
} = require('../src/terminals');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-termlife-'));

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

// 借一个刚退出的进程的 pid：比硬编码一个「应该不存在」的号码靠谱
function deadPid() {
  return new Promise((resolve) => {
    const p = spawn('cmd.exe', ['/c', 'exit'], { windowsHide: true });
    p.on('exit', () => setTimeout(() => resolve(p.pid), 300));
  });
}

const specOf = (id, name) => ({
  id, name, dir: TMP, task: '', sessionId: 'sess-' + id,
  windowName: 'waifu-' + id, title: 'WaifuCode · ' + name,
});

(async () => {
  const tm = new TerminalManager({
    storeDir: TMP,
    getConfig: () => ({}),
    log: (m) => console.log('    \x1b[90m' + m + '\x1b[0m'),
  });

  const gone = await deadPid();

  console.log('\n[1] pid 探测（signal 0，只问在不在，不发任何信号）');
  check(pidAlive(process.pid) === true, '当前进程判定为活着');
  check(pidAlive(gone) === false, '已经退出的进程判定为没了（pid ' + gone + '）');
  check(pidAlive(null) === null, 'pid 还没报上来时返回 null，不瞎猜');

  console.log('\n[2] 窗口关掉的从列表里消失，还开着的留下');
  tm.items.set('w901', tm._makeRecord(specOf('w901', '还开着'), { pid: process.pid }));
  tm.items.set('w902', tm._makeRecord(specOf('w902', '被叉掉了'), { pid: gone }));
  check(tm.list().length === 2, '先摆两条进去');

  let changed = 0;
  tm.on('change', () => { changed++; });
  tm._sweep();

  check(tm.items.has('w901'), '窗口还开着的 —— 留下了');
  check(!tm.items.has('w902'), '窗口被叉掉的 —— 清掉了');
  check(changed === 1, '通知了面板去刷新');

  console.log('\n[3] 活干完但窗口还开着的，不能清掉');
  // claude 退出会报一次 close，但那会儿 term-shell 还停在「按回车关掉」等你看结果
  tm.onShellEvent({ termId: 'w901', phase: 'close', code: 0 });
  check(tm.list()[0].status === 'done', '状态变成干完了');
  tm._sweep();
  check(tm.items.has('w901'), '窗口还开着，所以还留在列表里（你还能点它去看结果）');

  console.log('\n[4] 桌宠重启后，把还开着的终端认回来');
  fs.mkdirSync(path.join(TMP, 'terminals'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, 'terminals', 'w903.json'),
    JSON.stringify(specOf('w903', '重启前就开着的')),
    'utf8'
  );
  check(!tm.items.has('w903'), '内存里本来没有这条');
  tm.onShellEvent({ termId: 'w903', phase: 'beat', pid: process.pid });
  check(tm.items.has('w903'), '收到心跳后把它认回来了');
  check(tm.items.get('w903').name === '重启前就开着的', '名字是从参数文件里读回来的');

  console.log('\n[5] 重启后编号接着往下发，不跟老的撞号');
  const tm2 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
  check(tm2.seq >= 903, '新实例的编号从 903 往后（实际 ' + tm2.seq + '）');

  console.log('\n[6] 认不出来的就别乱认');
  tm.onShellEvent({ termId: 'w999', phase: 'beat', pid: process.pid });
  check(!tm.items.has('w999'), '没有参数文件的，不往列表里塞');

  console.log('\n[7] 干完一段汇报时，必须带上「是哪个终端」');
  {
    // 这是「点她汇报的气泡 → 跳到对应终端」那条链的第一环。
    // 断了不会报任何错，只是那个气泡点下去没反应 —— 所以必须钉住
    const tm3 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
    fs.writeFileSync(path.join(TMP, 'terminals', 'w910.json'),
      JSON.stringify(specOf('w910', 'MyProject')), 'utf8');

    const reports = [];
    tm3.on('report', (e) => reports.push(e));

    // 窗口生死走 onShellEvent，claude 的 hook 事件走 onHookEvent —— 两条不同的路
    tm3.onShellEvent({ termId: 'w910', phase: 'beat', pid: process.pid });
    tm3.onHookEvent({ termId: 'w910', waifuEvent: 'UserPromptSubmit', prompt: '把测试补上' });
    tm3.onHookEvent({
      termId: 'w910', waifuEvent: 'PostToolUse',
      tool_name: 'Edit', tool_input: { file_path: 'D:/x/foo.js' },
    });
    tm3.onHookEvent({
      termId: 'w910', waifuEvent: 'Stop',
      last_assistant_message: '测试补好了，九项全过。',
    });

    check(reports.length === 1, '干完一段报了一次（' + reports.length + ' 次）');
    check(reports[0] && reports[0].id === 'w910',
          '**带上了终端 id** —— 少了它，那个气泡点下去就是没反应');
    check(reports[0] && reports[0].name === 'MyProject', '也带上了是哪个项目');
    check(reports[0] && /九项全过/.test(reports[0].text), '带上了她说的话');
    check(reports[0] && reports[0].files && reports[0].files.includes('foo.js'),
          '带上了她动过的文件');

    // 窗口关掉之后那条记录还在（状态变 done），不然你就没法回头看现场了
    tm3.onHookEvent({ termId: 'w910', waifuEvent: 'SessionEnd' });
    check(tm3.items.get('w910').status === 'done', '会话结束后状态变 done，记录还在');

    tm3.dispose();
  }

  console.log('\n[8] 念出来的那句只挑关键的（听是线性的，长了就变噪音）');
  {
    const say = (o) => spokenReport({ pick: 0, ...o });

    const clean = say({ name: 'WaifuCode', files: ['a.js', 'b.js', 'c.js'] });
    console.log('    ' + clean);
    check(clean.includes('WaifuCode'), '说了是哪个项目');
    check(clean.includes('3 个文件'), '说了动了多大范围');
    check(!/a\.js|b\.js/.test(clean),
          '**不念文件名** —— 一串文件名念出来纯粹是噪音，看气泡就行');
    check(/点我/.test(clean), '**告诉你这个可以点开看** —— 不说没人知道气泡能点');
    // 量的是**去掉项目名之后的固定开销** —— 项目名长度是变量，算进去这条断言就没意义了。
    // 老版本是「项目名 + 一串文件名 + 原话前 40 字」，上限给到 90
    const fixed = clean.length - '「WaifuCode」'.length;
    check(fixed <= 28, '除掉项目名只剩 ' + fixed + ' 个字（老版本上限是 90）');

    const bad2 = say({ name: 'X', errorCount: 2, files: ['a.js'] });
    console.log('    ' + bad2);
    check(bad2.includes('报了错'), '报错了要说');
    check(bad2.includes('一个文件'), '只动一个文件时说「一个」不说「1 个」');

    const nothing = say({ name: 'Y' });
    console.log('    ' + nothing);
    check(!nothing.includes('文件'), '没动文件就不提文件');
    check(/点我/.test(nothing), '照样告诉你能点开看');

    // 收尾那句得轮着换 —— 每二十秒听一遍一模一样的话比不说还烦
    const tails = new Set([0, 0.5, 0.99].map((p) => spokenReport({ name: 'Z', pick: p })));
    check(tails.size === 3, '收尾那句有 ' + tails.size + ' 种说法，不会一直重复');
    check(spokenReport({ name: 'Z', pick: 1 }).length > 0, 'pick 取到边界值也不炸');

    // 原来那版会把她汇报的原话截 40 个字念进去，听完反而不知道干了啥
    check(!say({ name: 'W' }).includes('undefined'), '没有把 undefined 念出来');
  }

  console.log('\n[9] 按标题找不到窗口，**绝对不能**顺手把任务删了');
  {
    // 这条守的是一个真出过的破坏性 bug。上一版写的是「按标题找不到 = 窗口没了 =
    // 顺手清掉」，而 **Claude Code 跑起来会改控制台标题** —— 标题一变查找就落空，
    // 于是你点一下「看看她在干嘛」，一个**还在干活**的任务被当场删了。
    //
    // 判断死活只有一个权威依据：pid 探测（真系统调用）。查找失败有一堆无害的
    // 原因（标题被改、在别的虚拟桌面、PowerShell 起不来），
    // **一个查找失败的信号永远不该触发删除**。
    const tm4 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
    const rec = tm4._makeRecord(specOf('w920', '还在干活'), { pid: process.pid });
    rec.status = 'running';
    tm4.items.set('w920', rec);
    tm4.wt = null; // 跳过 wt 那条快路，直接走 user32 核实
    tm4._focusByTitle = async () => ({ ok: false, gone: true, error: '那个窗口已经不在了' });

    const r = await tm4.focus('w920');
    check(!r.ok, '找不到窗口时如实报失败');
    check(tm4.items.has('w920'),
          '**但那条任务还在！** —— 进程还活着（pid 探测说了算），' +
          '标题找不到只说明「找不到」，不说明「没了」');
    check(tm4.items.get('w920').status === 'running', '状态也没被动过，还是在干活');
    check(!/去掉|删/.test(r.error), '提示里也别说「我把它去掉了」，那是撒谎：' + r.error);

    // 真的死了，那是 _sweep 靠 pid 探测的活儿
    tm4.items.get('w920').pid = await deadPid();
    tm4.items.get('w920').turns = 0;
    tm4._sweep();
    check(!tm4.items.has('w920'), '进程真的没了，才由 _sweep 清掉（这才是权威判据）');
    tm4.dispose();
  }

  console.log('\n[10] 干活时她身上什么状态（这条是「派出去那几分钟你是瞎的」的解药）');
  {
    const tm5 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
    fs.writeFileSync(path.join(TMP, 'terminals', 'w930.json'),
      JSON.stringify(specOf('w930', '甲项目')), 'utf8');
    const beats = [];
    tm5.on('pulse', (e) => beats.push(e));

    const rec = tm5._makeRecord(specOf('w930', '甲项目'), { pid: process.pid });
    tm5.items.set('w930', rec);

    const now = Date.now();
    const pulse = (t) => { tm5._pulse(t || Date.now()); };

    rec.status = 'running'; rec.lastSeen = now; rec.errorCount = 0;
    pulse(now);
    check(beats.at(-1).state === 'working', '正常干着 → working');

    // 同一个状态别重复吐 —— 不然渲染层每三秒被打断一次，姿态永远在重新淡入
    const n = beats.length;
    rec.toolCount = 12; pulse(now);
    check(beats.length === n, '状态没变就不吐（工具数一直在涨，跟着吐会把姿态打断成结巴）');

    rec.errorCount = 3; pulse(now);
    check(beats.at(-1).state === 'struggling', '报错到三次 → struggling');

    rec.errorCount = 0; rec.lastSeen = now - 60000; pulse(now);
    check(beats.at(-1).state === 'stuck', '还是 running 但一分钟没动静 → stuck');

    rec.status = 'waiting'; pulse(now);
    check(beats.at(-1).state === 'waiting', '在等你确认 → waiting');
    check(beats.at(-1).id === 'w930', '带上是哪个终端（点她一下要跳过去）');

    // 两个一起跑时，让位给最该被看见的那个
    const rec2 = tm5._makeRecord(specOf('w931', '乙项目'), { pid: process.pid });
    tm5.items.set('w931', rec2);
    rec2.status = 'running'; rec2.lastSeen = now; rec2.errorCount = 0;
    rec.status = 'running'; rec.errorCount = 5; rec.lastSeen = now;
    pulse(now);
    check(beats.at(-1).state === 'struggling' && beats.at(-1).name === '甲项目',
          '**两个一起跑时挑最要紧的那个** —— 她只有一个身体');

    rec.status = 'waiting'; pulse(now);
    check(beats.at(-1).state === 'waiting', '等你确认压过一直报错（那个走不下去了）');

    rec.status = 'idle'; rec2.status = 'idle'; pulse(now);
    check(beats.at(-1).state === 'none', '都干完了 → none，身体交还给心情');

    tm5.dispose();
  }

  console.log('\n[11] 干完了要留痕，不能连同结果一起消失');
  {
    const tm6 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
    // 监听要挂在 _sweep 之前 —— sweep 自己会吐一次 pulse，挂晚了就漏掉
    const beats = [];
    tm6.on('pulse', (e) => beats.push(e));
    const done = tm6._makeRecord(specOf('w940', '干过活的'), { pid: await deadPid() });
    done.turns = 2;
    done.lastReport = '测试补好了，九项全过。';
    done.toolCount = 14;
    tm6.items.set('w940', done);

    // 一次都没干过就关了的（开了就叉、或者压根没起来），那种留着纯粹是噪音
    const empty = tm6._makeRecord(specOf('w941', '开了就关'), { pid: done.pid });
    tm6.items.set('w941', empty);

    tm6._sweep();

    check(tm6.items.has('w940'),
          '**干过活的留下来了** —— 窗口都关了，这条是「干成什么样」唯一的痕迹');
    check(tm6.items.get('w940').status === 'closed', '标成了已完成');
    check(tm6.list().find((t) => t.id === 'w940').lastReport === '测试补好了，九项全过。',
          '结果也还在，回头点开还看得到');
    check(!tm6.items.has('w941'), '一次都没干过的就直接去掉了（留着是噪音）');

    // 已完成的不算「在跑」，也不该让她身上一直挂着干活的姿态
    check(tm6.liveCount() === 0, '已完成的不算在跑（角标不该还亮着）');
    check(beats.length > 0 && beats.at(-1).state === 'none', '身体也不再挂着干活状态');

    // 同目录并行：上层靠 livesFor 判断「这是第几条线」，第二条起要在标题上缀线名
    check(tm6.livesFor(TMP).length === 0, '已完成的不占坑，同目录照样能派新活');

    const live = tm6._makeRecord(specOf('w942', '还在跑'), { pid: process.pid });
    live.status = 'running';
    tm6.items.set('w942', live);
    check(tm6.livesFor(TMP).length === 1, '有一条在跑就认出来一条');

    const live2 = tm6._makeRecord(specOf('w943', '另一条'), { pid: process.pid });
    live2.status = 'running';
    tm6.items.set('w943', live2);
    check(tm6.livesFor(TMP).length === 2,
          '**同目录两条并行都认得出** —— 上层据此给第二条起个线名，不再是拦下来');
    check(tm6.liveFor(TMP) !== null, 'liveFor 仍然给得出「有没有」（老调用点没被弄坏）');

    tm6.dispose();
  }

  // -------------------------------------------------------------------------
  // 同目录多条线：标题绝对不能撞
  // -------------------------------------------------------------------------
  //
  // 这一节守的就是用户那句「同一个目录几个终端任务都不一样，你不能搞混了」。
  // 标题是任务栏里认窗口的唯一依据，也是 focus-window.ps1 找窗口的依据 ——
  // 撞了就是点 A 跳出 B、收 A 收掉 B。
  {
    console.log('\n[12] 同目录开好几条线，窗口标题不许撞');
    const tm7 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });

    const titles = [];
    for (const lane of ['登录页表单校验', '查支付回调', '']) {
      const t = tm7._uniqueTitle('WaifuCode · proj' + (lane ? ' · ' + lane : ''));
      // 塞回去占坑，模拟窗口真的开着
      const rec = tm7._makeRecord({
        id: 'x' + titles.length, dir: TMP, name: 'proj', title: t, sessionId: 's',
      });
      rec.status = 'running';
      tm7.items.set(rec.id, rec);
      titles.push(t);
    }
    console.log('    ' + titles.join('  |  '));
    check(new Set(titles).size === 3, '三条线三个不同标题');

    // 再来一条跟第一条**一模一样**的：必须被自动错开
    const dup = tm7._uniqueTitle('WaifuCode · proj · 登录页表单校验');
    console.log('    重名的那条拿到: ' + dup);
    check(dup !== titles[0], '**重名自动错开** —— 不错开的话任务栏里两个窗口长得一模一样');
    check(!titles.includes(dup), '错开之后跟已有的谁都不撞');

    // closed 的要把标题让出来，done 的不让（窗口还在任务栏上杵着）
    tm7.items.get('x0').status = 'closed';
    check(tm7._uniqueTitle(titles[0]) === titles[0],
          '窗口关了，标题让出来给后来的用');
    tm7.items.get('x1').status = 'done';
    check(tm7._uniqueTitle(titles[1]) !== titles[1],
          '**干完但窗口还开着的，标题照样占坑** —— 那个窗口还在任务栏上');

    tm7.dispose();
  }

  // -------------------------------------------------------------------------
  // 她干的事对不对
  // -------------------------------------------------------------------------
  //
  // 这一节的第一组（A）是整个功能的生死线：**误报比漏报致命得多**。
  // 一天响八回，用户第二天就把它关了，那还不如没有。所以这组里每一条
  // 都是天天在跑的正经命令，必须一声不吭。改规则之后这一组要重新过一遍。
  {
    console.log('\n[13] 她干的事对不对（跑偏了要喊你）');
    const D = path.join(TMP, 'proj');
    fs.mkdirSync(D, { recursive: true });
    const danger = (command, tool = 'Bash') =>
      checkDanger({ toolName: tool, toolInput: { command }, dir: D });

    console.log('    A. 这些天天在跑，一声都不许吭：');
    const QUIET = [
      ['rm -rf node_modules', '天天跑，而且就在项目里'],
      ['rm -rf dist && npm run build', '同上，还带个 &&'],
      ['Remove-Item -Recurse -Force .\\dist', 'PowerShell 写法'],
      ['Remove-Item -Recurse -Force "' + path.join(D, '有 空格 的目录') + '"',
       '**带空格的引号路径** —— 按空白硬切会碎掉，前半截判成目录外就误报'],
      ['del /s /q build', 'cmd 的 /s /q 是开关，不是路径'],
      ['git rm -r --cached .', 'rm 不在命令头，这是 git 的子命令'],
      ['npm rm lodash', '同上，卸个包而已'],
      ['git clean -n', '-n 是预演，什么都不删'],
      ['git push --force-with-lease origin main', '**这个是安全的那个**，不能跟 --force 一起误伤'],
      ['npm run format', '不能被「格式化磁盘」那条撞上'],
      ['node graceful-shutdown.js', '不能被「关机」那条撞上'],
      ['git reset --soft HEAD~1', '--soft 不丢东西'],
      ['rm ' + path.join(os.tmpdir(), 'x.log'), '临时目录放行'],
    ];
    for (const [cmd, why] of QUIET) {
      check(danger(cmd) === null, cmd.slice(0, 46) + ' —— ' + why);
    }

    console.log('    B. 这些回不来，必须喊：');
    const LOUD = [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf .',                       // 删的就是整个派活目录
      'rm -rf ..',
      'rm -rf D:\\OtherProject',
      'rm -rf $HOME/x',                 // 变量展不开，偏保守
      'rmdir /s /q C:\\Windows',
      'npm test; rm -rf /tmp2',         // 分号后面那半段也要看
      'git reset --hard',
      'git push -f origin main',
      'git clean -fdx',
      'DROP DATABASE prod',
      'format C: /fs:ntfs',
      'shutdown /r /t 0',
    ];
    for (const cmd of LOUD) {
      const hit = danger(cmd);
      check(Boolean(hit && hit.why), cmd);
    }

    console.log('    C. 文件路径这条线');
    check(checkDanger({ toolName: 'Edit', toolInput: { file_path: 'D:\\别的项目\\a.js' }, dir: D }),
          '改目录外面的文件 → 喊');
    check(checkDanger({ toolName: 'Read', toolInput: { file_path: 'D:\\别的项目\\a.js' }, dir: D }) === null,
          '**读目录外面的一声不吭** —— 翻 node_modules、翻隔壁仓库是家常便饭，报了这功能第一天就废');
    check(checkDanger({ toolName: 'Write', toolInput: { file_path: path.join(os.tmpdir(), 'a.js') }, dir: D }) === null,
          '往临时目录写 → 放行');
    check(checkDanger({ toolName: 'Edit', toolInput: { file_path: path.join(D, 'src', 'a.js') }, dir: D }) === null,
          '改自己项目里的 → 放行');
    check(filePathOf('NotebookEdit', { notebook_path: 'D:\\x\\a.ipynb' }) === 'D:\\x\\a.ipynb',
          'NotebookEdit 用的是 notebook_path（老代码读 file_path，永远是 undefined）');
    check(isInside('D:\\WaifuCode\\x', 'D:\\Waifu') === false,
          '**前缀陷阱**：D:\\WaifuCode\\x 不在 D:\\Waifu 里（不补分隔符这条就挂）');
    check(isInside('D:\\WaifuCode\\x', 'D:\\WaifuCode') === true, '真在里面的照样认');
    check(isInside('D:\\WaifuCode', 'D:\\WaifuCode') === false,
          '目录自己不算「在里面」—— 这样 rm -rf . 才喊得出来');

    console.log('    D. 接线：喊得出来、而且不刷屏');
    const alerts = [];
    const beats8 = [];
    const tm8 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
    tm8.on('attention', (e) => alerts.push(e));
    // pulse 只在**变了**的时候发，所以监听必须挂在报警之前 ——
    // 挂晚了就只能看到「已经是 alarm」之后的沉默，验不出「立刻转身」这件事
    tm8.on('pulse', (e) => beats8.push(e));
    const rec8 = tm8._makeRecord({ id: 'w950', dir: D, name: 'proj', title: 't', sessionId: 's' });
    tm8.items.set('w950', rec8);

    const pre = (command) => tm8.onHookEvent({
      termId: 'w950', waifuEvent: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
    });

    pre('rm -rf D:\\别的项目');
    check(alerts.length === 1, '喊了一次');
    check(alerts[0] && alerts[0].id === 'w950',
          '**带上了终端 id** —— 少了它那个气泡点下去就是没反应');
    check(/proj/.test(alerts[0].text) && /你看一眼/.test(alerts[0].text),
          '话是拼好的中文成句（main.js 直接拿去念）：' + alerts[0].text);

    pre('rm -rf D:\\又一个别的项目');
    check(alerts.length === 1, '**同一轮同一类只喊一次** —— 她连删二十个文件不能响二十声');

    tm8.onHookEvent({ termId: 'w950', waifuEvent: 'UserPromptSubmit', prompt: '接着干' });
    pre('rm -rf D:\\第三个');
    check(alerts.length === 2, '换了一轮，重新算');

    check(rec8.alarmUntil > Date.now(), '报警之后转过来看着你');
    check(beats8.length > 0 && beats8.at(-1).state === 'alarm',
          '**当场就转身了** —— 不等三秒一拍的巡检（这条消息的价值全在「立刻」）');
    rec8.alarmUntil = Date.now() - 1;
    tm8._pulse();
    check(beats8.at(-1).state === 'working',
          '**到点自己转回去接着干** —— 靠时间戳失效，不用写清理代码');

    // 她只有一个身体：报警压过「在等你确认」
    const rec9 = tm8._makeRecord({ id: 'w951', dir: D, name: 'proj2', title: 't2', sessionId: 's2' });
    rec9.status = 'waiting';
    tm8.items.set('w951', rec9);
    rec8.alarmUntil = Date.now() + 10000;
    tm8._pulse();
    check(beats8.at(-1).state === 'alarm' && beats8.at(-1).id === 'w950',
          '两个一起响时，报警压过「等你确认」');
    tm8.dispose();

    const off = new TerminalManager({
      storeDir: TMP, getConfig: () => ({ supervise: { guard: false } }), log: () => {},
    });
    let offAlerts = 0;
    off.on('attention', () => { offAlerts++; });
    off.items.set('w960', off._makeRecord({ id: 'w960', dir: D, name: 'p', title: 't', sessionId: 's' }));
    off.onHookEvent({
      termId: 'w960', waifuEvent: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rm -rf D:\\别的项目' },
    });
    check(offAlerts === 0, '设置里关掉「跑偏了喊我」就一条都不报');
    off.dispose();

    console.log('    E. 多行命令不许误报（Bash 工具天天传多行）');
    const MULTI_QUIET = [
      ['rm -rf dist\ngit add .\ngit commit -m build', '第二行那个 . 不是「要删的东西」'],
      ['rm -rf dist\ncd ..\nnpm i', '第二行那个 .. 也不是'],
      ['Remove-Item -Recurse -Force .\\dist\n$env:NODE_ENV = "production"\nnpm run build', '下一行的 $env: 更不是'],
      ['git push -u origin feat\ngh pr create -f --base main', '下一行的 -f 是 gh 的，不是 git push 的'],
      ['git push origin main\ndocker build -f Dockerfile .', '同上'],
      ['git commit -am wip\ngit push\nrm -f note.txt', '推完顺手删个临时文件，最常见的收尾'],
      ['git clean -nd', '**预演**（-n 不列目录，所以真实写法都带 d）'],
      ['git clean -ndx', '同上'],
      ['git clean --dry-run -d', '同上'],
      ['Remove-Item -Recurse -Force .\\dist -WhatIf', 'PowerShell 的预演'],
      ['dotnet format ' + path.join(D, 'src'), '不能被「格式化磁盘」撞上'],
      ['git commit -m "先 git reset --hard 再说"', '**引号里的字不算数** —— 那是提交说明，不是命令'],
    ];
    for (const [cmd, why] of MULTI_QUIET) {
      check(danger(cmd) === null, cmd.replace(/\n/g, ' ⏎ ').slice(0, 44) + ' —— ' + why);
    }

    console.log('    F. 多行里真动手的那条要抓得住');
    check(Boolean(danger('npm ci\nrm -rf D:\\别的项目')),
          '**第二行才动手的也要抓到** —— 只认整串开头的话这条完全静默');
    check(Boolean(danger('rm -rf /usr')),
          '**/usr 不是命令开关** —— 只放过一两个字母的（/s /q），不然 /usr /etc 全被静默放过');
    check(Boolean(danger('rm -rf /etc')), '/etc 同上');
    check(danger('del /s /q build') === null, '但 cmd 的 /s /q 照样是开关');
    check(danger('rm ' + require('path').posix.join('/tmp', 'x.log')) === null,
          'Git Bash 的 /tmp 放行（她的 Bash 工具就是 Git Bash）');

    // 引号那条修完了，也不能反过来把「引号里的删除目标」漏掉
    check(Boolean(danger('rm -rf "D:\\别的项目\\子 目录"')),
          '引号里的**删除目标**照样要看（挖引号只用在「回不来的命令」那一组）');
  }

  console.log('\n[14] 起 claude 时带空格的参数不许碎掉');
  {
    // npm 装出来的是 claude.cmd → spawn 走 shell:true，而**那条路是零转义的**：
    // Node 只是拿空格把 args 拼成一条命令行。实测 '-n WaifuCode · 我的 项目'
    // 会碎成 5 个参数。开发机是 claude.exe（shell:false），所以自检走不到那条路，
    // 这里退而求其次：钉住 term-shell 里那段引号处理别被人顺手删了。
    const src = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'term-shell.js'), 'utf8');
    check(/isBatch\s*\?\s*args\.map\(quoteArg\)/.test(src),
          '**isBatch 时每个参数都要各自加引号** —— 删了它，npm 装 claude 的人' +
          '会话名一直是坏的，数据目录带空格时小抄路径还会断成两截');
    check(/function quoteArg/.test(src), 'quoteArg 还在');
  }

  console.log('\n[15] 活干完了要报一声（这是她脸上那一下的来源）');
  {
    // 这个时刻以前是个哑巴：状态变灰、列表沉底，她本人一点反应都没有。
    // 「干完一个活什么反应」写在 mood.onTaskDone 里，可它只挂在无头模式的
    // sessions 上，而默认早就换成真终端了 —— 那段代码在正常使用里从来没跑过
    const seen = [];
    const tm3 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });
    tm3.on('finish', (e) => seen.push(e));

    // 派出去的活（minimized）跟你自己开的终端，反应不一样，所以这个标记要传下来
    tm3.items.set('w910', tm3._makeRecord(
      { ...specOf('w910', '派出去的'), minimized: true }, { pid: process.pid }));
    tm3.items.set('w911', tm3._makeRecord(specOf('w911', '你自己开的'), { pid: process.pid }));

    tm3.onShellEvent({ termId: 'w910', phase: 'close', code: 0 });
    check(seen.length === 1 && seen[0].id === 'w910', '活干完了报了一声');
    check(seen[0].ok === true && seen[0].dispatched === true,
          '**带着「成没成」和「是不是她被派出去的」** —— 上层靠这两个决定反应有多大');

    // close（claude 自己退了）和 SessionEnd（hook 报的）可能都会来。
    // 不挡住的话心情结算跑两遍：能量扣两次、「干完几个活」多算一个
    tm3.onShellEvent({ termId: 'w910', phase: 'close', code: 0 });
    tm3.onHookEvent({ termId: 'w910', waifuEvent: 'SessionEnd' });
    check(seen.length === 1, '**同一条线只报一次** —— close 和 SessionEnd 谁先到算谁的');

    tm3.onHookEvent({ termId: 'w911', waifuEvent: 'SessionEnd' });
    check(seen.length === 2 && seen[1].dispatched === false,
          '你自己开的那条也报，但标着「不是派出去的」');
    check(seen[1].ok === true,
          '拿不到退出码时当成功 —— **宁可少沮丧一次**，误判成砸了她会没来由地低落');

    tm3.dispose();
  }

  console.log('\n[16] 窗口关了要立刻从列表上暗下去（不能等好几分钟）');
  {
    // 三条探测路：gone（term-shell 死前亲口报，亚秒级）、pid 探测（3 秒）、
    // 心跳断了（pid 被 Windows 复用、探测一直误报「活着」时唯一的出路）
    const tm4 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });

    // gone：干过活的转「已完成」，没干过的直接消失
    tm4.items.set('w920', tm4._makeRecord(specOf('w920', '干过活的'), { pid: process.pid, turns: 2 }));
    tm4.items.set('w921', tm4._makeRecord(specOf('w921', '啥都没干的'), { pid: process.pid }));
    let changes = 0;
    tm4.on('change', () => changes++);

    tm4.onShellEvent({ termId: 'w920', phase: 'gone' });
    check(tm4.items.get('w920').status === 'closed', '**亲口报 gone → 立刻转已完成**（不等 3 秒一拍的探测）');
    check(changes >= 1, '而且立刻通知了面板');

    tm4.onShellEvent({ termId: 'w921', phase: 'gone' });
    check(!tm4.items.has('w921'), '啥都没干过的，gone 一到直接消失');

    // 心跳断了的兜底：pid「活着」（被复用了），但心跳停了很久
    const rec = tm4._makeRecord(specOf('w922', 'pid被顶号的'), {
      pid: process.pid,   // 这个 pid 真活着 —— 模拟的就是「号码被别的进程接盘」
      turns: 1,
      lastBeat: Date.now() - 60000,
    });
    tm4.items.set('w922', rec);
    tm4._sweep();
    check(tm4.items.get('w922').status !== 'closed', '心跳断了第一拍：先记一笔，不动手（给睡眠唤醒留余量）');
    tm4._sweep();
    tm4._sweep();
    check(tm4.items.get('w922').status === 'closed',
          '**连着三拍心跳都断着 → 判窗口没了**，不用等接盘的进程退出');

    // 反例：心跳一直新鲜的，pid 活着就是真活着
    tm4.items.set('w923', tm4._makeRecord(specOf('w923', '真活着的'), {
      pid: process.pid, turns: 1, lastBeat: Date.now(),
    }));
    tm4._sweep(); tm4._sweep(); tm4._sweep();
    check(tm4.items.get('w923').status !== 'closed', '心跳新鲜的谁也动不了它');

    tm4.dispose();
  }

  console.log('\n[17] 心跳兜底不能误杀（评审抓出来的三条反例）');
  {
    const tm5 = new TerminalManager({ storeDir: TMP, getConfig: () => ({}), log: () => {} });

    // ① claude 退了、窗口还开着（「按回车关掉」那一步）：status=done，
    //    老版 term-shell 这期间不打心跳 —— 心跳兜底必须对 done 免检，
    //    不然人还在看输出，面板就把这条判死了
    tm5.items.set('w930', tm5._makeRecord(specOf('w930', '看着输出呢'), {
      pid: process.pid, turns: 3, status: 'done', lastBeat: Date.now() - 60000,
    }));
    tm5._sweep(); tm5._sweep(); tm5._sweep(); tm5._sweep();
    check(tm5.items.get('w930').status === 'done',
          '**「干完了窗口还开着」不许被心跳兜底判死** —— 那期间 pid 探测是准的');

    // ② 认回来但一直没拿到 pid 的记录断联：干过活的要留成「已完成」，
    //    不能走老的硬删除把结果和最后一笔钱一起丢掉
    tm5.items.set('w931', tm5._makeRecord(specOf('w931', '认回来的'), {
      pid: null, turns: 4, lastReport: '改了两个文件',
    }));
    tm5.items.get('w931').lastSeen = Date.now() - 60000; // DEAD_MS 早过了
    tm5._sweep();
    check(tm5.items.has('w931') && tm5.items.get('w931').status === 'closed',
          '**没 pid 的记录断联 → 转已完成留着**（原来是整条硬删，痕迹全丢）');

    // ③ gone 先到、close 后到（窗口被叉时两发 HTTP 的真实顺序）：
    //    close 不许把 closed 翻回 done
    tm5.items.set('w932', tm5._makeRecord(specOf('w932', '被叉的'), { pid: process.pid, turns: 1 }));
    tm5.onShellEvent({ termId: 'w932', phase: 'gone' });
    tm5.onShellEvent({ termId: 'w932', phase: 'close', code: 1 });
    check(tm5.items.get('w932').status === 'closed',
          '**close 后到不许把「已关」翻回「干完了」** —— 窗口都没了');

    tm5.dispose();
  }

  tm.dispose();
  tm2.dispose();
  console.log('\n' + (bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m'));
  process.exit(bad ? 1 : 0);
})();
