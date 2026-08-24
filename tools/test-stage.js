'use strict';

// 桌面上那些「你碰她、她有反应」的事，走一遍看真不真。
//
// 这些全是鼠标事件驱动的，读代码看不出问题 —— 得真的让鼠标走一趟。
// 盯的是这几件容易静默失效的事：
//
//   · 视线得跟着鼠标转，而且**鼠标不在她身上时也要跟**（这才是能看出来的场合）
//   · 你不动了，她的视线该自己飘走，不能一直瞪着一个不动的鼠标
//   · 拖动只该「欸」一声，不能每帧喊一次，更**不能走那条会起 claude 进程的路**
//   · 气泡说着话的时候点得到（点了跳私聊），三个点转着的时候点不到
//   · 藏部件换造型真的藏得掉
//
// 用的是 tools/mock-preload.js 那份假 window.waifu，不连主进程、不花钱。
// 会开一个可见窗口（透明窗口没法用肉眼验，开着也方便你自己看一眼），跑完自己关。

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 渲染层通过 mock-preload 报回来的动静
const seen = {
  react: [], interact: [], chatWith: [], chose: [], focusTerm: [], drag: 0, through: true,
};
ipcMain.on('mock-focus-term', (_e, id) => seen.focusTerm.push(id));
ipcMain.on('mock-react', (_e, k) => seen.react.push(k));
ipcMain.on('mock-interact', (_e, k) => seen.interact.push(k));
ipcMain.on('mock-chat-with', (_e, t) => seen.chatWith.push(t));
ipcMain.on('mock-choose', (_e, id) => seen.chose.push(id));
ipcMain.on('mock-drag', () => { seen.drag++; });
ipcMain.on('mock-through', (_e, v) => { seen.through = v; });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 700, show: true, frame: false, transparent: false,
    backgroundColor: '#141824',
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      // 必须关掉后台节流。窗口一旦失焦或者被别的窗口盖住，Chromium 会把 rAF
      // 掐到近乎停止 —— 实测隐藏窗口 800 毫秒只跑 1 帧。而这个自检量的全是
      // **逐帧才发生的事**（动作演完没、部件透明度写没写进去、帧内采样），
      // 于是就成了「每次跑挂的项目都不一样」。主进程那个桌宠窗口早就关了这个。
      backgroundThrottling: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, m) => {
    // level 3 = error。渲染层里任何一处抛异常都会把后面的逻辑整段带走，
    // 而窗口是透明的，肉眼根本看不出来
    if (level >= 3) errors.push(m.split('\n')[0]);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  const ok = await win.webContents.executeJavaScript(`
    new Promise((r) => {
      const t = setInterval(() => { if (window.waifuStage) { clearInterval(t); r(true); } }, 120);
      setTimeout(() => { clearInterval(t); r(false); }, 25000);
    })`);
  if (!ok) { console.error('模型没加载出来'); win.destroy(); app.exit(1); return; }
  await wait(900);

  // 页面里的小工具
  await win.webContents.executeJavaScript(`
    window.__ev = (type, x, y, extra) => window.dispatchEvent(
      new MouseEvent(type, Object.assign({ clientX: x, clientY: y, screenX: x, screenY: y,
                                           button: 0, bubbles: true }, extra || {})));
    window.__evOn = (el, type, x, y) => document.getElementById(el).dispatchEvent(
      new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    window.__bubbleRect = () => {
      const r = document.getElementById('bubble').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    };
    window.__bubbleClickable = () =>
      getComputedStyle(document.getElementById('bubble')).pointerEvents;
    window.__partOpacity = (id) => {
      const core = window.waifuStage.model().internalModel.coreModel;
      const ids = Array.from(core._model.parts.ids);
      const i = ids.indexOf(id);
      return i < 0 ? null : core.getPartOpacityByIndex(i);
    };
    window.__gaze = () => {
      const f = window.waifuStage.model().internalModel.focusController;
      return f ? { x: +f.targetX.toFixed(3), y: +f.targetY.toFixed(3) } : null;
    };
    /**
     * 帧内采样。
     *
     * **参数不能在帧外读。** 一帧的最后一步是 loadParameters，它会把
     * beforeModelUpdate 里写的值统统还原回 saveParameters 那一刻的快照 ——
     * 所以你在帧外 getParameterValueById 读到的永远是「没人动过」的值，
     * 眼皮压没压下来完全看不出来。得挂个自己的钩子在帧内抄一份。
     * 这个钩子注册得比 look.js 晚，所以跑得也比它晚，读到的是它写完的结果。
     */
    window.__sample = {};
    window.__watch = (ids) => {
      const im = window.waifuStage.model().internalModel;
      /**
       * **只采这个模型真有的参数。**
       *
       * getParameterValueById 遇到不认识的 id **不抛错，返回 0** —— 于是采一个
       * 不存在的名字会得到一个「看着挺正常」的 0，而调用方那句
       * __sample.A ?? __sample.B 根本救不了（0 不是 null，?? 不会往后取）。
       * 表现就是「精力 95 时眼睛开到 0，精力 5 时也 0」，像眼皮坏了，
       * 其实是读了个根本不存在的参数名。
       *
       * 传两种命名进来是必须的（老模型是 PARAM_EYE_L_OPEN，新的是 ParamEyeLOpen），
       * 所以这道过滤也是必须的。
       *
       * 注意：这整段活在一个模板字符串里，**注释里一个反引号都不能有** ——
       * 写了就当场截断字符串，报的是 test-stage.js 第 75 行 SyntaxError，
       * 离真凶两百行远。（刚踩过。）
       */
      const real = new Set(Array.from(im.coreModel._model.parameters.ids));
      const use = ids.filter((id) => real.has(id));
      im.on('beforeModelUpdate', () => {
        const core = im.coreModel;
        for (const id of use) {
          try { window.__sample[id] = +core.getParameterValueById(id).toFixed(3); } catch (_) {}
        }
      });
      return use;
    };
    true;  // executeJavaScript 会把最后一个表达式的值搬回主进程 ——
           // 上面最后一句是给函数赋值，函数不可克隆，不补这一行整个调用当场抛
           // 「An object could not be cloned」，而且报的位置离真凶十万八千里
  `);

  console.log('\n[1] 渲染层起得来');
  check(errors.length === 0, '加载过程没有报错' + (errors.length ? '：' + errors[0] : ''));
  check(await win.webContents.executeJavaScript('!!window.waifuStage'), 'waifuStage 接口挂出来了');

  console.log('\n[2] 视线：鼠标不在她身上也要跟');
  await win.webContents.executeJavaScript('window.__ev("mousemove", 20, 40)');
  await wait(200);
  const errAfterMove = errors.length;
  check(errAfterMove === 0, '鼠标扫过窗口空白处不报错（以前这里只有压在她身上才 focus）');

  await win.webContents.executeJavaScript('window.__ev("mousemove", 400, 660)');
  await wait(200);
  check(errors.length === errAfterMove, '扫到另一个角落也不报错');

  console.log('\n[3] 气泡：说话时点得到，想事情时点不到');
  await win.webContents.executeJavaScript('window.waifuStage.say("测试一句话", 60000)');
  await wait(400);
  const clickable = await win.webContents.executeJavaScript('window.__bubbleClickable()');
  check(clickable === 'auto', '说着话的时候气泡收事件（pointer-events: ' + clickable + '）');

  const r = await win.webContents.executeJavaScript('window.__bubbleRect()');
  await win.webContents.executeJavaScript(
    'window.__evOn("bubble", "mouseup", ' + Math.round(r.x) + ', ' + Math.round(r.y) + ')');
  await wait(300);
  check(seen.chatWith.length === 1, '点一下气泡 → 要求打开私聊（收到 ' + seen.chatWith.length + ' 次）');
  check(seen.chatWith[0] === '测试一句话', '把她刚说的那句原样带过去了：「' + (seen.chatWith[0] || '') + '」');

  console.log('\n[3b] 出题气泡：四个选项要摆得开，点了要报回去');
  {
    const opts = [
      { id: 'happy', label: '开心' }, { id: 'proud', label: '得意' },
      { id: 'shy', label: '害羞' }, { id: 'frustrated', label: '烦躁' },
    ];
    win.webContents.send('mock', {
      channel: 'greet:say',
      payload: { say: '我现在是什么心情？', offer: opts, hold: 0 },
    });
    await wait(500);

    const layout = await win.webContents.executeJavaScript(`
      (() => {
        const box = document.getElementById('bubble-offer');
        const bs = Array.from(box.querySelectorAll('button'));
        const wrap = getComputedStyle(box).flexWrap;
        // 每个按钮的字有没有被挤到竖排：宽度还没一个字宽就是挤爆了
        const narrow = bs.filter((b) => b.getBoundingClientRect().width < 40).length;
        return { n: bs.length, wrap, narrow,
                 rows: new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size };
      })()`);

    check(layout.n === 4, '四个按钮都渲染出来了');
    check(layout.wrap === 'wrap', '允许换行（不加这条四个中文选项会被挤成竖条）');
    check(layout.narrow === 0, '没有哪个按钮被挤扁');
    console.log('    四个选项排成了 ' + layout.rows + ' 行');

    // 题目不能自己消失 —— hold=0
    await wait(700);
    const still = await win.webContents.executeJavaScript(
      'document.getElementById("bubble").classList.contains("show")');
    check(still === true, '题目挂着不自动收（hold=0 生效）');

    // 点第三个
    await win.webContents.executeJavaScript(`
      document.querySelectorAll('#bubble-offer button')[2].click(); true`);
    await wait(300);
    check(seen.chose.length === 1 && seen.chose[0] === 'shy',
          '点哪个就报哪个（收到 ' + JSON.stringify(seen.chose) + '）');

    await win.webContents.executeJavaScript(
      'window.waifuStage.say("", 1); true'); // 收掉，别挡住后面的用例
    await wait(300);
  }

  console.log('\n[4] 拖动：喊一声就够，而且不许走花钱那条路');
  seen.react.length = 0;
  seen.interact.length = 0;
  const before = { drag: seen.drag };
  // 按在她身上（窗口中间偏下就是她），然后拖一段
  await win.webContents.executeJavaScript('window.__ev("mousedown", 210, 450)');
  for (let i = 0; i < 12; i++) {
    await win.webContents.executeJavaScript('window.__ev("mousemove", ' + (210 + i * 6) + ', 450)');
    await wait(30);
  }
  await win.webContents.executeJavaScript('window.__ev("mouseup", 276, 450)');
  await wait(300);

  check(seen.drag > before.drag, '拖动确实在挪窗口（发了 ' + (seen.drag - before.drag) + ' 次位移）');
  check(seen.react.length === 1,
        '整段拖动只「欸」了一声（' + seen.react.length + ' 次），不是每帧喊');
  check(seen.react[0] === 'drag', '喊的是 react(drag)');
  check(!seen.interact.includes('drag'),
        '**没有**走 interact —— 那条会起 claude 进程，拖个窗口一两分钱');

  console.log('\n[5] 藏部件换造型');
  // WAIFU_MODEL 在时以它为准 —— 页面加载的是那个模型，这儿要是还读 config
  // 就成了「拿 A 模型的造型名去 B 模型上试」，必然全挂
  const CURRENT_MODEL = process.env.WAIFU_MODEL ||
    require(path.join(ROOT, 'src', 'config')).load().modelPath;
  const styles = require(path.join(ROOT, 'src', 'profiles'))
    .profileFor(CURRENT_MODEL).hairStyles;

  if (!styles) {
    console.log('    当前模型没配 hairStyles，跳过');
  } else {
    const alt = Object.entries(styles).find(([, s]) => (s.hide || []).length > 0);
    const target = alt[1].hide[0];
    const applied = await win.webContents.executeJavaScript(
      'window.waifuStage.setHairStyle("' + alt[0] + '")');
    check(applied === true, 'setHairStyle("' + alt[0] + '") 认得这套造型');
    await wait(500);
    const hidden = await win.webContents.executeJavaScript('window.__partOpacity("' + target + '")');
    check(hidden === 0, '切到「' + (alt[1].label || alt[0]) + '」之后 ' + target +
          ' 藏起来了（透明度 ' + hidden + '）');

    const first = Object.keys(styles)[0];
    await win.webContents.executeJavaScript('window.waifuStage.setHairStyle("' + first + '")');
    await wait(500);
    const back = await win.webContents.executeJavaScript('window.__partOpacity("' + target + '")');
    check(back === 1, '切回「' + (styles[first].label || first) + '」又露出来了');
  }

  console.log('\n[6] 情绪推过来时不炸（表情 + 眼皮 + 呼吸一起动）');
  const n0 = errors.length;
  // mock-preload 的 on() 把回调存着，主进程发 'mock' 就能触发对应频道
  const energies = { happy: 80, sleepy: 8, frustrated: 45, proud: 90, lonely: 30, normal: 60 };
  for (const [st, energy] of Object.entries(energies)) {
    win.webContents.send('mock', {
      channel: 'mood:change',
      payload: { state: st, changed: true, line: null, stats: { energy, mood: 60, affection: 50 } },
    });
    await wait(150);
  }
  check(errors.length === n0, '连推六种情绪没有报错');

  // 眼皮该跟着精力走。挂上帧内采样再推两种精力，对比着看。
  //
  // **两种命名都得采**：Cubism 2.1 时代的模型（两只猫、汪子、千岁、泉、春伞积木）
  // 叫 PARAM_EYE_L_OPEN，4.0 之后才是 ParamEyeLOpen。原来只采驼峰那个，
  // 于是 config 指着一只猫的时候这条恒红，而且报的是「精力 95 时眼睛开到 0，
  // 精力 5 时 0」—— 看着像眼皮坏了，其实是**采样根本没读到东西**。
  await win.webContents.executeJavaScript(
    'window.__watch(["ParamEyeLOpen", "PARAM_EYE_L_OPEN"]); true');
  // 挂上之后得等它真的跑过一帧再读 —— 直接读会偶发 undefined
  await win.webContents.executeJavaScript(`
    new Promise((r) => { const t = setInterval(() => {
      if (window.__sample.ParamEyeLOpen !== undefined ||
          window.__sample.PARAM_EYE_L_OPEN !== undefined) { clearInterval(t); r(true); }
    }, 60); setTimeout(() => { clearInterval(t); r(false); }, 4000); })`);

  win.webContents.send('mock', {
    channel: 'mood:change',
    payload: { state: 'normal', changed: true, stats: { energy: 95, mood: 60, affection: 50 } },
  });
  // **等眼皮真的抬完再量清醒基线。** 上面那圈情绪连推里有 sleepy(8)，droop 被
  // 压满过；它现在是慢速跟随的（0.5 秒半衰期，防「啪」一下），不等它落回 0，
  // 清醒时量到的就是半路上的值 —— 这条断言因此红过
  await wait(2600);
  // **取一段时间里的最大值**，不能单点采。眨眼时 ParamEyeLOpen 会掉到 0.1，
  // 正好撞上就会量到「精神时眼睛比困时还小」，这个测试因此偶发过
  const peek = async () => {
    let m = 0;
    for (let i = 0; i < 16; i++) {
      const v = await win.webContents.executeJavaScript(
        'window.__sample.ParamEyeLOpen ?? window.__sample.PARAM_EYE_L_OPEN');
      if (typeof v === 'number' && v > m) m = v;
      await wait(90);
    }
    return +m.toFixed(3);
  };
  const awake = await peek();

  win.webContents.send('mock', {
    channel: 'mood:change',
    payload: { state: 'sleepy', changed: true, stats: { energy: 5, mood: 40, affection: 50 } },
  });
  // **等眼皮沉完再量。** 它不是一步到位的：0.5 秒走完差距的一半（不这么做的话，
  // 心情一变眼皮就「啪」地砸下来一半，看着像掉帧）。5 个半衰期 ≈ 97%，
  // 而 peek 取的是一段窗口里的**最大值**（躲眨眼），没沉完就量会量到沉之前的那个数
  await wait(2600);
  const tired = await peek();

  console.log('    精力 95 时眼睛开到 ' + awake + '，精力 5 时 ' + tired);
  /**
   * 判据是「**困的时候 droop 真的写进去了**」，不是「困时比清醒时小」。
   *
   * 原来拿两个状态相减，隐含假设是「清醒时那个值就是模型的睁眼基线」。
   * 这个假设在有些模型上不成立：droop 为 0 时 look.js **压根不写**这个参数，
   * 读到的是别的层留下的值 —— 实测两只猫上清醒时读到 0、困时反而读到 0.3，
   * 相减直接判负，而眼皮功能其实好好的。
   *
   * 0.3 是 look.js 里那条公式的定值（`open - droop * (open - 0.3)`，droop 满时
   * 恒等于 0.3），所以直接对着它判 —— 这才是「精力见底 → 眼皮压到一条缝」
   * 这件事本身，跟模型的基线取值无关。
   */
  /**
   * 两条一起看：**清醒时睁得开（> 0.35）**，**困时压下去（< 0.35）**。
   *
   * 这条断言红过三种写法，每种的教训都记这儿：
   *   · 「tired < awake - 0.2」—— 清醒基线不稳（当时没等 droop 落完就量）
   *   · 「tired ≈ 0.3 那条缝」—— 生成的「困」表情又 Add 了一道，把值推穿了缝
   *   · 「tired > 0.02 下限」—— droop 满格 + 困表情叠加可以到整 0，
   *     那是**真闭眼了**（猫睡觉本来就闭眼），不是坏
   * awake > 0.35 同时守住了那个老雷：采样读了不存在的参数会恒 0，在这条上炸。
   */
  check(typeof awake === 'number' && awake > 0.35,
        '清醒时眼睛真的睁着（' + awake + '）—— 恒 0 就是采样读了不存在的参数');
  check(typeof tired === 'number' && tired < 0.35,
        '精力见底时眼皮真的压下去了（' + awake + ' → ' + tired + '）');

  // -------------------------------------------------------------------------
  const posture = () => win.webContents.executeJavaScript(
    'JSON.stringify(window.waifuStage.posture())').then(JSON.parse);

  const setMood = async (state) => {
    win.webContents.send('mock', {
      channel: 'mood:change',
      payload: { state, changed: false, stats: { energy: 60, mood: 60, affection: 50 } },
    });
    await wait(200);
  };

  console.log('\n[7] 心情写在身上，不只写在存档里');
  {
    await setMood('normal');
    check((await posture()).applied === 'normal', '平静时不掰她');

    await setMood('sleepy');
    check((await posture()).applied === 'sleepy',
          '**困了整个人就一直塌着** —— 不用戳她也看得出来（以前这个只在存档里）');

    await setMood('lonely');
    check((await posture()).applied === 'lonely', '闹脾气就一直侧着身不看你');
    await setMood('normal');
  }

  console.log('\n[8] 摸着不放，跟「点一下」是两码事');
  {
    // 摸头的落点得**每次按之前重新扫**，不能开头扫一次用到底。
    // 待机动作一直在动她的头（Hiyori 有 9 个在轮播），十秒之后同一个坐标就落空了 ——
    // 这个测试因此时灵时不灵过两次。而且不同模型的头在画布上位置差很多：
    // Mao 有真的 HitArea Head，Hiyori 只能按外接框几何兜底。
    const findHead = async () => JSON.parse(await win.webContents.executeJavaScript(`
      JSON.stringify((() => {
        const b = window.waifuStage.model().getBounds();
        for (let f = 0.08; f <= 0.45; f += 0.02) {
          const x = Math.round(b.x + b.width / 2);
          const y = Math.round(b.y + b.height * f);
          const h = window.waifuStage.hit(x, y);
          if (h.model && h.head) return { x, y, f: +f.toFixed(2) };
        }
        return null;
      })())
    `));

    let head = await findHead();
    check(Boolean(head), '找得到一个算「她的头」的落点' + (head ? '（外接框往下 ' + head.f + '）' : ''));

    const down = async () => {
      head = (await findHead()) || head;   // 按之前重新对一次准星
      return win.webContents.executeJavaScript(
        'window.__ev("mousedown", ' + head.x + ', ' + head.y + ')');
    };
    const up = () => win.webContents.executeJavaScript(
      'window.__ev("mouseup", ' + head.x + ', ' + head.y + ')');

    seen.react.length = 0;
    seen.interact.length = 0;
    await down();
    await wait(150);
    check((await posture()).temp === null, '刚按下去不算摸（350ms 之内当点击，不然点一下姿态会闪）');

    await wait(400);
    check((await posture()).temp === 'pet',
          '**按住不放 → 她眯着眼往你手的方向蹭**（这才是「摸」和「点」的区别）');
    check(seen.react.includes('pet-hold'), '走的是 react 那条路 —— 一分钱不花');
    check(seen.interact.length === 0, '按住的时候还没算完成一次摸头');

    await up();
    await wait(250);
    check((await posture()).temp === null, '松手了，姿态交还给心情那层');
    check(seen.interact.includes('pet'), '松手才算完成一次摸头（好感在这儿涨）');

    console.log('    等她被摸烦（6.5 秒）…');
    seen.react.length = 0;
    await down();
    // 轮询而不是死等 6.5 秒。卡在门槛上会偶发 —— 这条反复挂过三次，
    // 每次都是「差一点点」：GC、掉一帧、IPC 往返慢了几十毫秒都能让它翻
    let away = false;
    for (let i = 0; i < 60 && !away; i++) {
      await wait(200);
      away = (await posture()).temp === 'petAway';
    }
    check(away, '**摸太久了她躲开**（一直舒服就没有层次）');
    check(seen.react.includes('pet-long'), '并且抗议一声');
    await up();
    await wait(250);
    check((await posture()).temp === null, '松手之后恢复');

    // 手一动就该判成「挪位置」，不是「摸了半天」
    seen.react.length = 0;
    await down();
    await wait(120);
    for (let i = 0; i < 12; i++) {
      await win.webContents.executeJavaScript(
        'window.__ev("mousemove", ' + (head.x + i * 6) + ', ' + head.y + ')');
      await wait(25);
    }
    await wait(400);
    check(!seen.react.includes('pet-hold'),
          '手一移开就不算摸了 —— 挪个位置不该变成摸了半天');
    await win.webContents.executeJavaScript(
      'window.__ev("mouseup", ' + (head.x + 72) + ', ' + head.y + ')');
    await wait(200);
  }

  console.log('\n[9] 等她开口那几秒，人也得在想');
  {
    win.webContents.send('mock', { channel: 'greet:thinking', payload: {} });
    await wait(250);
    check((await posture()).temp === 'think',
          '**三个点转着的时候整个人也在想** —— 这几秒最容易露馅，因为你刚戳完正盯着看');

    win.webContents.send('mock', { channel: 'greet:say', payload: { say: '在呢', face: 'normal' } });
    await wait(250);
    check((await posture()).temp === null, '话一出口就不想了');

    // 气泡自己收掉的那条路也得收干净，不然会「想到一半忘了」
    win.webContents.send('mock', { channel: 'greet:thinking', payload: {} });
    await wait(250);
    await win.webContents.executeJavaScript('window.waifuStage.say(""); true');
    win.webContents.send('mock', { channel: 'mood:change', payload: { state: 'normal', changed: false, stats: {} } });
    await wait(250);
    const t = (await posture()).temp;
    check(t === null || t === 'think', '（收尾路径不留悬着的姿态）');
    win.webContents.send('mock', { channel: 'greet:say', payload: { say: '好', face: 'normal' } });
    await wait(200);
  }

  console.log('\n[10] 你走开一阵子回来，她抬头看你一眼');
  {
    win.webContents.send('mock', { channel: 'pet:welcome', payload: { goneMin: 30 } });
    await wait(300);
    check((await posture()).gesturing, '真演了个动作出来（不是只换了张脸）');
    // excited 那个动作 2.0 秒，留足余量 —— 卡在时长边界上会偶发
    await wait(3200);
    check(!(await posture()).gesturing, '演完自己退场，回到该有的状态');
  }

  console.log('\n[11] 气泡别在字看完之前、语音念完之前就跑了');
  {
    const showing = () => win.webContents.executeJavaScript(
      'document.getElementById("bubble").classList.contains("show")');

    // 一句四十来个字的话。以前一律按传进来的那个写死的毫秒数收，
    // 于是你看到一半它就没了
    const long = '这个改完之后你重启一下就能看到效果了，另外那个测试我顺手也补上了，' +
                 '一共九项全过，你有空自己跑一遍看看。';
    await win.webContents.executeJavaScript(
      'window.waifuStage.say(' + JSON.stringify(long) + ', 2000); true');
    await wait(2600);
    check(await showing(),
          '**四十多个字的话，2 秒的 hold 也不会 2 秒就收** —— 按字数算得出「看得完」的下限');

    await win.webContents.executeJavaScript('window.waifuStage.say("嗯", 60000); true');
    await wait(150);

    // 语音是异步合成的，好几秒才到。这几秒里气泡不许自己走
    await win.webContents.executeJavaScript('window.waifuStage.say("好的", 1200); true');
    win.webContents.send('mock', { channel: 'voice:pending', payload: { text: '好的' } });
    await wait(2000);
    check(await showing(),
          '**语音还在合成的时候，气泡被摁住了** —— 不然就是「字先没了，然后一个没气泡的她开始念」');

    // 出题那种「挂着别自动收」不能被上面这些下限带跑
    await win.webContents.executeJavaScript(
      'window.waifuStage.say("这是一道题", 0); true');
    win.webContents.send('mock', { channel: 'voice:pending', payload: { text: '这是一道题' } });
    await wait(1200);
    check(await showing(), 'hold=0 还是一直挂着（出题时气泡自己消失，这局就废了）');

    // 「收工」两个字的下限是 1.5 秒左右。这儿轮询而不是死等一个固定时长 ——
    // 机器忙的时候 IPC 往返能吃掉几百毫秒，卡在边界上会偶发
    await win.webContents.executeJavaScript('window.waifuStage.say("收工", 400); true');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { await wait(150); gone = !(await showing()); }
    check(gone, '短句子该收还是照收，没被下限拖成挂着不走');
  }

  console.log('\n[12] 她汇报干活时，点气泡是看现场（不是跳私聊）');
  {
    seen.chatWith.length = 0;
    win.webContents.send('mock', {
      channel: 'session:say',
      payload: { name: 'WaifuCode', text: '「WaifuCode」那边在等你确认。', termId: 'w7' },
    });
    await wait(300);

    const r = await win.webContents.executeJavaScript('window.__bubbleRect()');
    await win.webContents.executeJavaScript(
      'window.__evOn("bubble", "mouseup", ' + Math.round(r.x) + ', ' + Math.round(r.y) + ')');
    await wait(300);

    check(seen.focusTerm.includes('w7'),
          '**点了汇报气泡 → 调出那个终端看现场**（后台派的活现在是最小化的真终端）');
    check(seen.chatWith.length === 0, '没有跑去开私聊窗口');

    // 普通说话还得是老样子
    seen.focusTerm.length = 0;
    await win.webContents.executeJavaScript('window.waifuStage.say("今天天气不错", 60000); true');
    await wait(200);
    const r2 = await win.webContents.executeJavaScript('window.__bubbleRect()');
    await win.webContents.executeJavaScript(
      'window.__evOn("bubble", "mouseup", ' + Math.round(r2.x) + ', ' + Math.round(r2.y) + ')');
    await wait(300);
    check(seen.chatWith.length === 1, '普通那句话点了还是跳私聊');
    check(seen.focusTerm.length === 0, '**没有串味** —— 上一条的终端 id 被清干净了');
  }

  console.log('\n[13] 换整套贴图：真的重画布料那条路');
  {
    const fsx = require('fs');
    const modelPath = process.env.WAIFU_MODEL ||
      require(path.join(ROOT, 'src', 'config')).load().modelPath;
    const skinDir = path.join(ROOT, path.dirname(modelPath), 'skins');
    // 一个 png = 只换第 0 张（老写法）；一个**目录** = 整套换（换皮模型走这条）
    let skins = [];
    try {
      skins = fsx.readdirSync(skinDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || /\.png$/i.test(e.name))
        .map((e) => e.name);
    } catch (_) {}

    // 传给 setAtlas 的东西：一张图就是它自己，一个目录摊成按贴图号排的数组
    const spread = (name) => {
      const full = path.join(skinDir, name);
      if (!fsx.statSync(full).isDirectory()) return full;
      const out = [];
      for (const f of fsx.readdirSync(full)) {
        const m = /^texture_(\d+)\.png$/i.exec(f);
        if (m) out[Number(m[1])] = path.join(full, f);
      }
      return Array.from(out, (u) => u || null);
    };

    const urlOf = (i) => win.webContents.executeJavaScript(
      '(() => { const t = window.waifuStage.model().textures[' + i + ']; ' +
      'return t && t.baseTexture ? String(t.baseTexture.resource && t.baseTexture.resource.url || "") : ""; })()');
    const urlNow = () => urlOf(0);

    // **开机就该穿在身上。** 这条曾经是死的：渲染层拿到的 look.atlas 是一张
    // 「按模型分」的表，被当成路径 String() 成了 "[object Object]"，归属判断当场判否
    // → 每次开机都退回原装，你上次选的皮肤白选，而且一句提示都没有。
    // 只有 config 里真存着当前模型的皮肤时才验，别的情况这条没意义
    {
      const saved = ((require(path.join(ROOT, 'src', 'config')).load().look || {}).atlas || {})[modelPath];
      if (saved && !process.env.WAIFU_MODEL) {
        check(/skins/i.test(await urlNow()),
              '**开机就穿着存档里那套** —— 存的是 ' + path.basename(saved));
      } else {
        console.log('    config 里没给当前模型存皮肤，跳过「开机穿上」这条');
      }
    }

    if (!skins.length) {
      console.log('    当前模型没有 skins/ 目录，跳过（生成用 npm run probe-uv -- --pattern=…）');
    } else {
      const pick = spread(skins[0]);
      // 这身衣服动的是第几张图。**不能写死第 0 张** —— 一身配色只换真的不一样的那几张，
      // 海梦的「哥特黑」第 0 张跟原装一模一样（脸没变），验第 0 张会误报
      const hit = Array.isArray(pick)
        ? pick.map((u, i) => (u ? i : -1)).filter((i) => i >= 0)
        : [0];

      // **先归零。** config 里可能已经存着一套贴图（启动时就穿上了），
      // 那样「一开始是原装」这个前提就不成立，后面两条断言全会误判
      await win.webContents.executeJavaScript('window.waifuStage.setAtlas(""); true');
      await wait(500);
      const base = await urlNow();
      const baseAt = {};
      for (const i of hit) baseAt[i] = await urlOf(i);
      const untouched = Array.isArray(pick)
        ? [...Array(pick.length).keys()].find((i) => !pick[i]) : undefined;
      const baseUntouched = untouched === undefined ? '' : await urlOf(untouched);

      check(await win.webContents.executeJavaScript(
        'window.waifuStage.setAtlas(' + JSON.stringify(pick) + ')') === true,
        '换上 ' + skins[0] + '（传的是本地路径，不是 url）');
      await wait(900);

      // 这身衣服要换的每一张都得真换过去。只换第 0 张的话，海梦这种
      // 「头发一张、衣服一张、鞋一张」的模型就成了半拉子：头发变了衣服没变
      const missed = [];
      for (const i of hit) {
        const u = await urlOf(i);
        if (!(u !== baseAt[i] && /skins/i.test(u))) missed.push(i);
      }
      check(missed.length === 0,
            '**整套都换过去了** —— 这身动 ' + hit.length + ' 张（第 ' + hit.join('、') + ' 张）' +
            (missed.length ? '，没换上的: ' + missed.join('、') : ''));

      // 皮肤里没有的那号必须保持原装，不能被顺手清掉
      if (untouched !== undefined) {
        check((await urlOf(untouched)) === baseUntouched,
              '皮肤里没给第 ' + untouched + ' 张，那张还是原装');
      }

      check(await win.webContents.executeJavaScript('window.waifuStage.setAtlas("")') === true,
            '换得回原样');
      await wait(500);
      const back = await urlNow();
      check(back === base,
            '**换回来的是原装那张** —— 存底要在启动时记，不然拿到的是换过之后的');
    }

    // 别的模型的贴图，必须挡住。
    //
    // 这是个真出过的事故：存档里 look.atlas 是全局一个值，给 Mao 选了皮肤之后
    // 切到 Hiyori，启动时照样把 Mao 那张 2048 的图糊上去 —— 每片网格取到
    // 完全不相干的像素，出来是一张糊脸，眼睛长在下巴上，**一句报错都没有**。
    const others = [];
    for (const d of fsx.readdirSync(path.join(ROOT, 'models'))) {
      const sd = path.join(ROOT, 'models', d, 'skins');
      if (path.join(ROOT, path.dirname(modelPath)) === path.join(ROOT, 'models', d)) continue;
      try {
        for (const e of fsx.readdirSync(sd, { withFileTypes: true })) {
          if (/\.png$/i.test(e.name)) others.push(path.join(sd, e.name));
          // 皮肤目录里的也算 —— 换皮模型（海梦、猫）根本没有散落的 png，
          // 只看 png 的话这条越界检查会静静地跳过，看着还像跑过了
          else if (e.isDirectory()) {
            for (const f of fsx.readdirSync(path.join(sd, e.name))) {
              if (/\.png$/i.test(f)) others.push(path.join(sd, e.name, f));
            }
          }
        }
      } catch (_) { /* 那个模型没有 skins */ }
    }

    if (!others.length) {
      console.log('    没有别的模型的贴图可以拿来试，跳过越界检查');
    } else {
      const before = await win.webContents.executeJavaScript(
        '(() => { const t = window.waifuStage.model().textures[0]; return t && t.baseTexture ? String(t.baseTexture.resource && t.baseTexture.resource.url || "") : ""; })()');
      const ok = await win.webContents.executeJavaScript(
        'window.waifuStage.setAtlas(' + JSON.stringify(others[0]) + ')');
      await wait(700);
      const after = await win.webContents.executeJavaScript(
        '(() => { const t = window.waifuStage.model().textures[0]; return t && t.baseTexture ? String(t.baseTexture.resource && t.baseTexture.resource.url || "") : ""; })()');

      // 报名字要往 skins 上面一层找 —— 皮肤可能是散落的 png 也可能在子目录里，
      // 层数不固定，写死 dirname(dirname()) 会报出个「skins」来
      const parts = others[0].split(/[\\/]/);
      check(ok === false,
            '**别的模型的贴图被拒了**（' + parts[parts.lastIndexOf('skins') - 1] + ' 的图）');
      check(after === before, '而且没把当前贴图弄坏 —— 拒绝之后还是原来那张');
    }
  }

  // 她现在挂着哪张脸。expressionManager 手里只有表情对象，名字得拿它在
  // expressions 里的下标去 definitions 换 —— 没有现成的「当前表情名」
  const faceNow = () => win.webContents.executeJavaScript(
    '(() => {' +
    '  const m = window.waifuStage.model();' +
    '  const em = m && m.internalModel.motionManager.expressionManager;' +
    '  if (!em || !em.expressions) return "";' +
    '  const i = em.expressions.indexOf(em.currentExpression);' +
    '  const d = i >= 0 && em.definitions ? em.definitions[i] : null;' +
    '  return d ? String(d.Name || d.File || "") : "";' +
    '})()');

  console.log('\n[14] 干活时她身上一直有状态（不是干完才说）');
  {
    const pulse = async (payload) => {
      win.webContents.send('mock', { channel: 'work:pulse', payload });
      await wait(300);
    };
    await setMood('normal');

    await pulse({ state: 'working', id: 'w1', name: 'X', tools: 5, errors: 0 });
    check((await posture()).applied === 'working',
          '**派出去之后她身上就一直有状态** —— 原来这几分钟是完全没反应的');

    await pulse({ state: 'struggling', id: 'w1', name: 'X', tools: 20, errors: 4 });
    check((await posture()).applied === 'struggling', '一直报错 → 绷起来');

    await pulse({ state: 'stuck', id: 'w1', name: 'X', tools: 20, errors: 0 });
    check((await posture()).applied === 'stuck', '卡住不动 → 歪头停住');

    // 摸她的时候，「你正在碰她」比「那边在干活」更即时
    seen.react.length = 0;
    const head = JSON.parse(await win.webContents.executeJavaScript(`
      JSON.stringify((() => {
        const b = window.waifuStage.model().getBounds();
        for (let f = 0.08; f <= 0.45; f += 0.02) {
          const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height * f);
          const h = window.waifuStage.hit(x, y);
          if (h.model && h.head) return { x, y };
        }
        return null;
      })())`));
    if (head) {
      await win.webContents.executeJavaScript(
        'window.__ev("mousedown", ' + head.x + ', ' + head.y + ')');
      await wait(600);
      check((await posture()).applied === 'pet',
            '**你伸手摸她时，摸头压过干活状态** —— 那件事更即时');
      await win.webContents.executeJavaScript(
        'window.__ev("mouseup", ' + head.x + ', ' + head.y + ')');
      await wait(400);
      check((await posture()).applied === 'stuck', '松手之后回到干活状态（活还没完）');
    }

    // 等你确认时点她 = 直接跳过去看，而不是让她现想一句话（那要花钱）
    await pulse({ state: 'waiting', id: 'w7', name: 'X' });
    check((await posture()).applied === 'waiting', '等你确认 → 转过来看着你');

    seen.focusTerm.length = 0;
    seen.interact.length = 0;
    if (head) {
      const h2 = JSON.parse(await win.webContents.executeJavaScript(`
        JSON.stringify((() => {
          const b = window.waifuStage.model().getBounds();
          for (let f = 0.08; f <= 0.45; f += 0.02) {
            const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height * f);
            const hh = window.waifuStage.hit(x, y);
            if (hh.model && hh.head) return { x, y };
          }
          return null;
        })())`)) || head;
      await win.webContents.executeJavaScript('window.__ev("mousedown", ' + h2.x + ', ' + h2.y + ')');
      await win.webContents.executeJavaScript('window.__ev("mouseup", ' + h2.x + ', ' + h2.y + ')');
      await wait(400);
      check(seen.focusTerm.includes('w7'),
            '**这时候点她 = 直接调出那个终端**（你要的显然是去看，不是听她说话）');
      check(seen.interact.length === 0, '而且没走那条要花钱的搭话');
    }

    // 临时表情收工之后，手上还有活的话得回到「干活那张脸」。
    //
    // 少了这一层的话：她干着活，你摸她一下（或者哪一段报了错闪一下脸），
    // 那一下结束后她就从「在干活」变回发呆脸 —— 而 work:pulse **只在状态变了的
    // 时候才吐**，那张脸要一直等到下次状态变化才回得来，中间可能是好几分钟
    await pulse({ state: 'working', id: 'w1', name: 'X', tools: 5, errors: 0 });
    const workFace = await faceNow();
    const pushMood = async (state, reason) => {
      win.webContents.send('mock', {
        channel: 'mood:change',
        payload: { state, changed: true, reason, line: null,
                   stats: { energy: 60, mood: 60, affection: 50 } },
      });
      await wait(300);
    };
    await pushMood('frustrated', 'flash');
    const flashed = await faceNow();
    await pushMood('normal', 'flash-settle');
    const settled = await faceNow();

    if (!workFace) {
      console.log('    当前模型没配「干活」这张脸，跳过这两条');
    } else {
      check(flashed !== workFace, '闪一下的时候脸真的变了（' + workFace + ' → ' + flashed + '）');
      check(settled === workFace, '**闪完回到干活那张脸**，不是发呆脸（' + settled + '）');
    }

    await pulse({ state: 'none' });
    check((await posture()).applied === 'normal', '活干完了，身体交还给心情');
    if (workFace) {
      await pushMood('happy', 'task-done');
      check((await faceNow()) !== workFace, '活干完了，脸也交还给心情');
    }
  }

  // --- 情绪符号：头顶真的冒出来（跟聊天换脸走同一条链，静默失效就靠这两条守）--
  {
    win.webContents.send('mock', { channel: 'perform:face', payload: { name: 'angry' } });
    await wait(350);
    const mk = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('mood-mark');
      return el ? { t: el.textContent, pop: el.classList.contains('pop') } : null;
    })()`);
    check(!!mk && mk.t === '💢' && mk.pop, '情绪符号：生气的 💢 真的冒出来了（元素在、动画在放）');
    // 同一情绪 8 秒内不重复冒：pop 类 1.9 秒后被摘，马上再发不该重新挂上
    await wait(1900);
    win.webContents.send('mock', { channel: 'perform:face', payload: { name: 'angry' } });
    await wait(300);
    const again = await win.webContents.executeJavaScript(
      `document.getElementById('mood-mark').classList.contains('pop')`);
    check(!again, '同一情绪 8 秒内不重复冒（不然连着三句气话就成弹幕了）');
  }

  if (errors.length) {
    console.log('\n页面报的错：');
    for (const e of errors.slice(0, 8)) console.log('  ' + e);
  }

  win.destroy();
  console.log('');
  console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
  app.exit(bad === 0 ? 0 : 1);
}).catch((e) => { console.error('炸了: ' + (e && e.stack || e)); app.exit(1); });
