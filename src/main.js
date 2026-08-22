'use strict';

const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog, shell,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

// 代码/素材在哪儿、数据写哪儿，是两回事。开发时它俩相同，打包后就分家了 ——
// 装到 Program Files 底下时安装目录是**只读**的。详见 src/paths.js
const { APP_ROOT, DATA_ROOT } = require('./paths');
const logfile = require('./logfile');

const ROOT = APP_ROOT;
const STORE = path.join(DATA_ROOT, 'sessions');
const LOG_FILE = path.join(DATA_ROOT, 'waifu.log');

// 托盘和任务栏的图标。是 npm run make-icon 从模型渲染出来的她的头像，
// 所以换了角色重跑一次就换了图标。没有也能跑，只是托盘那儿会是个空白占位。
const TRAY_ICON = path.join(ROOT, 'assets', 'tray.png');
const APP_ICON = path.join(ROOT, 'assets', 'icon.png');

function iconOr(file, fallback) {
  try {
    if (fs.existsSync(file)) return file;
  } catch (_) {
    /* 读不到就当没有 */
  }
  return fallback;
}

const { Mood, LINES } = require('./mood');
const { SessionManager, resolveClaudeBin, claudeInstalled } = require('./sessions');
// codex 那一侧的适配（找 bin、判装没装、拼参数在 term-shell 里用）
const agents = require('./agents');
const { startServer } = require('./server');
const { profileFor } = require('./profiles');
const { Voice } = require('./voice');
const { TerminalManager, spokenReport } = require('./terminals');
const { Chat } = require('./chat');
const { Performer, MUSIC_DIR } = require('./perform');
const { Greeter } = require('./greet');
const { Play } = require('./play');
const config = require('./config');
// 她自己的流水账。**一分钱不花** —— 只是把已经发生的事顺手记一行，
// 「今天干了什么 / 花了多少 / 认识多少天」全从它来。见 src/journal.js
const journal = require('./journal');
// 她给每个项目攒的那张小抄。攒不花钱（用的是她本来就要说的那句汇报），
// 开终端时带进去约 2 分钱一次。见 src/notes.js
const notes = require('./notes');

// 桌宠是被动出声的（她自己有情绪才说话），没有「用户点了播放」这一步，
// 不放开这个开关 Chromium 会直接掐掉音频。必须在 app ready 之前设。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 窗口是全透明的 —— 一旦模型加载失败，屏幕上什么都不会出现，
// 光看桌面根本无从判断是崩了还是没启动。所以所有事都记到文件里。
//
// 写盘那半段交给 logfile.js：它带一个 8 MB 的刹车。正常速度下永远碰不到
// （实测每天 88 KB），但出 bug 那天 —— 循环里的 log、反复重连的组件 ——
// 几个小时就能刷出几个 G，原来那个一路 append 到底的写法一点招都没有。
const writeLog = logfile.makeWriter(LOG_FILE);

function log(...args) {
  writeLog('[' + new Date().toISOString() + '] ' + args.join(' ') + '\n');
  console.log(...args);
}

let petWin = null;
let panelWin = null;
let chatWin = null;
let settingsWin = null;
let tray = null;
let mood = null;
let sessions = null;
let voice = null;
let chat = null;
let terminals = null;
let performer = null;
let greeter = null;
let play = null;
// 玩游戏 / 番茄钟期间她该闭嘴：情绪台词、主动搭话、提议唱跳全压住。
// 一边让你专注一边在旁边碎碎念，那这个功能就是反效果。
let quiet = false;
let lastGreetAt = 0;
let hookPort = null; // hook 服务实际抢到的端口，开终端时要告诉那边往哪汇报
// 当前发型，右键菜单里打勾用。真正的值在 whenReady 里从 config 读
// （这儿还在模块顶层，loadConfig 那个 const 还没轮到初始化）
let currentHair = 'normal';

const CONFIG_FILE = config.FILE;
const loadConfig = config.load;

// 用哪个模型：命令行 --model= 优先（方便临时预览别的角色），
// 其次 config.json，最后回落到默认。
function currentModelPath() {
  const arg = process.argv.find((a) => a.startsWith('--model='));
  if (arg) return arg.slice('--model='.length);

  // 存档里那个模型可能已经不在盘上了（改过名、删掉了、换皮的那几份被折进本体了）。
  // 不兜一下的话表现是**一个人都不出来、也不报错** —— 窗口在、透明、什么都没有。
  const saved = loadConfig().modelPath;
  if (saved && fs.existsSync(path.join(ROOT, saved))) return saved;
  const first = scanModels()[0];
  if (first) {
    log('[model] 存档里的 ' + saved + ' 找不着了，先用 ' + first.name);
    return first.path;
  }
  return saved;
}

const PET_W = 420;
// 她本人占 540，上面那 160 是空出来给气泡站的（renderer 里的 BUBBLE_ZONE）。
// 窗口整块是透明的，所以这段空带在桌面上看不见 —— 但气泡有地方待了，
// 不会像以前那样直接浮在她脸上。加高是往上长的，她还站在原来那个位置。
const PET_H = 540 + 160;

// ---------------------------------------------------------------------------
// 角色窗口
// ---------------------------------------------------------------------------
function createPetWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  // 屏幕矮的时候（小笔记本、缩放拉满）别让窗口顶出可视区
  const h = Math.min(PET_H, Math.max(360, height - 48));

  petWin = new BrowserWindow({
    width: PET_W,
    height: h,
    x: Math.max(0, width - PET_W - 24),
    y: Math.max(0, height - h - 24),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关掉后台节流，否则窗口失焦时 Live2D 的呼吸/眨眼会卡成 PPT
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' 层级才能盖住全屏应用；普通 alwaysOnTop 会被游戏/视频挡住
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 把渲染层的 console 全部接出来 —— 这是排查 Live2D 加载问题的唯一途径
  petWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    log(`[renderer:${tag}] ${message} (${path.basename(sourceId || '')}:${line})`);
  });
  petWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`[main] 页面加载失败 code=${code} desc=${desc} url=${url}`);
  });
  petWin.webContents.on('did-finish-load', () => {
    log('[main] 角色窗口就绪');
    pushMood('boot');
  });

  petWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWin.on('closed', () => { petWin = null; });

  return petWin;
}

// ---------------------------------------------------------------------------
// 派活面板
// ---------------------------------------------------------------------------
const PANEL_W = 780;
const PANEL_H = 700;

/**
 * 面板该摆在哪：**跟着她走，贴在她旁边，落在她所在的那块屏幕上**。
 *
 * 原来这儿拿的是主屏的尺寸 —— 她要是站在副屏上，面板会被按着主屏的宽度
 * 夹回去，出现在离她十万八千里的地方，你根本找不到。
 * 多屏定位必须先问「她在哪块屏」（getDisplayNearestPoint），
 * 再在**那块屏的工作区**里摆。
 */
function panelSpot(prefW, prefH) {
  const b = petWin && !petWin.isDestroyed() ? petWin.getBounds() : { x: 400, y: 200, width: 420, height: 700 };
  const disp = screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
  });
  const wa = disp.workArea;
  // 尺寸先跟屏幕商量：矮屏 / 窄屏上按默认尺寸摆会把底下一排裁出屏外。
  // 面板还 resizable —— 用户改过尺寸的话调用方会把真实尺寸传进来，
  // 拿死常量算位置会把它摆出屏外
  const w = Math.min(prefW || PANEL_W, wa.width - 24);
  const h = Math.min(prefH || PANEL_H, wa.height - 24);
  // 贴在她左边；左边放不下就去右边；再不行就夹回屏内
  let x = b.x - w - 12;
  if (x < wa.x + 12) x = b.x + b.width + 12;
  x = Math.max(wa.x + 12, Math.min(wa.x + wa.width - w - 12, x));
  const y = Math.max(wa.y + 12, Math.min(wa.y + wa.height - h - 12, b.y - 40));
  return { x: Math.round(x), y: Math.round(y), w, h, display: disp };
}

/**
 * 面板给终端让个位。
 *
 * 面板是 alwaysOnTop 的 —— 这保证你随时找得到它，但也意味着**任何普通窗口
 * 都压不过它**：你点「调到最前」，终端确实到了普通窗口的最前面，却还是被
 * 置顶的面板盖着，看起来就是「点了没反应」。
 *
 * 所以每次把终端送到你面前时，面板临时放弃置顶（终端自然盖上来）；
 * 你再点一下面板（focus 事件）它就恢复置顶。不藏、不最小化 ——
 * 你多半还要对照着面板看终端，它只是退到旁边，不是消失。
 */
function panelYield() {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) {
    panelWin.setAlwaysOnTop(false);
  }
}

function createPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.setAlwaysOnTop(true); // 让过位的话，唤起时拿回置顶
    // 缩到任务栏的必须先 restore。show() 在 Windows 上就是个 SW_SHOW，
    // 对已经最小化的窗口什么也不干 —— 表现出来就是「双击角色没反应」
    if (panelWin.isMinimized()) panelWin.restore();

    // 她挪到别的屏幕了的话，把面板搬过去 —— 你双击她，就是想在**她旁边**
    // 看到面板。还在同一块屏上就不动它（你手动摆过的位置得尊重）。
    // 位置按面板**现在的**尺寸算 —— 你拖大过它的话，按默认尺寸算会摆出屏外
    const pb = panelWin.getBounds();
    const spot = panelSpot(pb.width, pb.height);
    const cur = screen.getDisplayMatching(pb);
    if (cur.id !== spot.display.id) {
      panelWin.setBounds({ x: spot.x, y: spot.y, width: spot.w, height: spot.h });
    }

    panelWin.show();
    // 光 show 不够 —— 全屏应用、别的置顶窗口都可能压着它。
    // 「找不到任务弹窗」就是这么来的
    panelWin.moveTop();
    panelWin.focus();
    return;
  }

  const spot = panelSpot();
  panelWin = new BrowserWindow({
    width: spot.w,
    height: spot.h,
    minWidth: 640,
    minHeight: 520,
    x: spot.x,
    y: spot.y,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#0d0f16',
    show: false,
    icon: iconOr(APP_ICON, undefined),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  panelWin.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panelWin.once('ready-to-show', () => { panelWin.show(); panelWin.moveTop(); });
  panelWin.on('closed', () => { panelWin = null; });
  // 给终端让过位之后，你点回面板它就重新置顶 —— 「让位」只让到你回来为止
  panelWin.on('focus', () => {
    if (panelWin && !panelWin.isDestroyed()) panelWin.setAlwaysOnTop(true);
  });

  // 面板平时不占任务栏的位置（skipTaskbar: true），但**缩下去的时候必须占**，
  // 不然它就消失得无影无踪，你还是得回去双击角色 —— 那还不如直接关掉。
  // 所以任务栏按钮只在最小化期间存在：收起来时加上，展开时再摘掉。
  panelWin.on('restore', () => {
    if (panelWin && !panelWin.isDestroyed()) panelWin.setSkipTaskbar(true);
  });

  panelWin.webContents.on('console-message', (_e, level, message) => {
    log('[panel] ' + message);
  });
}

// ---------------------------------------------------------------------------
// 设置窗口
// ---------------------------------------------------------------------------

// 能选的音色。Edge TTS 的中文音色不少，这里挑几个常用的 ——
// 全列出来一屏都装不下，也没人真会挨个试。
const VOICES = [
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 年轻女声，活泼' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声，温柔' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵 · 女声，偏成熟' },
  { id: 'zh-CN-XiaomengNeural', label: '晓梦 · 女声，甜' },
  { id: 'zh-CN-XiaoshuangNeural', label: '晓双 · 童声' },
  { id: 'zh-CN-XiaoyouNeural', label: '晓悠 · 童声，清亮' },
  { id: 'zh-CN-XiaozhenNeural', label: '晓甄 · 女声，稳' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声，年轻' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声，播音腔' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾腔' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉曼 · 粤语' },
];

const PERMISSION_MODES = [
  { id: 'auto', label: 'auto · 她自己判断，安全放行危险拦下（推荐）' },
  { id: 'acceptEdits', label: 'acceptEdits · 只自动放行文件编辑' },
  { id: 'dontAsk', label: 'dontAsk · 不问，但危险的照样拦' },
  { id: 'plan', label: 'plan · 只出方案不动手' },
  { id: 'manual', label: 'manual · 每一步都问你' },
  { id: 'bypassPermissions', label: 'bypassPermissions · 全放行（不建议）' },
];

const TERMINAL_APPS = [
  { id: 'auto', label: '自动 · 有 Windows Terminal 就用它' },
  { id: 'conhost', label: '老式控制台 · 就是那个灰白窗口' },
];

/** 扫一遍 models/ 下面有哪些角色可选 */
function scanModels() {
  const dir = path.join(ROOT, 'models');
  const out = [];
  try {
    for (const sub of fs.readdirSync(dir)) {
      const d = path.join(dir, sub);
      try {
        if (!fs.statSync(d).isDirectory()) continue;
        for (const f of fs.readdirSync(d)) {
          if (!f.endsWith('.model3.json')) continue;
          const rel = 'models/' + sub + '/' + f;
          out.push({ name: profileFor(rel).name || sub, path: rel });
        }
      } catch (_) { /* 这个子目录读不了就跳过 */ }
    }
  } catch (err) {
    log('[settings] 扫模型失败: ' + err.message);
  }
  return out;
}

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  const bounds = petWin ? petWin.getBounds() : { x: 500, y: 160 };
  const W = 460;
  const H = 620;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  settingsWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.max(12, Math.min(sw - W - 12, bounds.x - W - 24)),
    y: Math.max(12, Math.min(sh - H - 12, bounds.y - 100)),
    minWidth: 400,
    minHeight: 480,
    frame: false,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: '#0d0f16',
    show: false,
    icon: iconOr(APP_ICON, undefined),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.webContents.on('console-message', (_e, _l, m) => log('[settings] ' + m));
}

// ---------------------------------------------------------------------------
// 私聊窗口
// ---------------------------------------------------------------------------
function createChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.show();
    chatWin.focus();
    return;
  }

  const bounds = petWin ? petWin.getBounds() : { x: 500, y: 160 };
  const W = 430;
  const H = 620;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  chatWin = new BrowserWindow({
    width: W,
    height: H,
    // 也贴在角色左边，但比派活面板再往左让一点，两个窗口同时开着不会叠死
    x: Math.max(12, Math.min(sw - W - 12, bounds.x - W - 24)),
    y: Math.max(12, Math.min(sh - H - 12, bounds.y - 120)),
    minWidth: 340,
    minHeight: 420,
    frame: false,
    resizable: true, // 聊天窗口跟派活面板不一样，是要长时间待着的，得能拉大
    skipTaskbar: false, // 也不一样：私聊得能从任务栏切回来
    alwaysOnTop: false,
    backgroundColor: '#0d0f16',
    show: false,
    // 私聊窗口是会出现在任务栏里的（skipTaskbar: false），所以它需要图标
    icon: iconOr(APP_ICON, undefined),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'));
  chatWin.once('ready-to-show', () => chatWin.show());
  chatWin.on('closed', () => { chatWin = null; });

  chatWin.webContents.on('console-message', (_e, level, message) => {
    log('[chat] ' + message);
  });
}

// 往所有窗口广播 —— 有可能其中一个还没建/已经关了，都要防一手
function send(channel, payload) {
  for (const w of [petWin, panelWin, chatWin, settingsWin]) {
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload);
      } catch (_) {
        /* 窗口正在销毁的竞态，忽略 */
      }
    }
  }
}

function pushMood(reason) {
  if (!mood) return;
  const snap = mood.snapshot();
  send('mood:change', { ...snap, reason: reason || 'sync', changed: true, line: null });
}

// ---------------------------------------------------------------------------
// 一起玩：把 play.js 那边的事件翻译成渲染层认识的话
//
// 全程不调 claude —— 题目、干扰项、对错反馈都是本地算的。
// 一局猜情绪来回三轮，要是每轮都问一次模型，玩十分钟够买杯咖啡了。
// ---------------------------------------------------------------------------
function wirePlay() {
  if (!play) return;

  play.on('say', (e) => {
    send('greet:say', {
      say: e.text,
      // options 是这一题的几个选项，stage.js 的 say() 收数组就会摆成一排按钮
      offer: e.options || null,
      hold: e.hold,
    });
    // 出题那句念出来，选项就别念了 —— 念一串「开心、得意、害羞、吃惊」很吵
    speakLine(e.text, { maxLen: 60 });
  });

  play.on('perform', (e) => {
    if (e.face) send('perform:face', { name: e.face });
    if (e.gesture) send('perform:gesture', { name: e.gesture, interrupt: Boolean(e.interrupt) });
  });

  // 猜歌用的片段。不能走 perform:song —— 那条路上 stage.js 会把歌名念出来，
  // 等于直接报答案
  play.on('clip', (e) => send('perform:clip', e));

  play.on('quiet', (e) => {
    quiet = Boolean(e.on);
    // 专注期间「到日子了」那句也别冒出来 —— 不挡的话它会被下面那层吞掉台词，
    // 但里程碑已经算响过了，等于白白错过一次
    if (mood) mood.quiet = quiet;
    log('[play] ' + (quiet ? '安静模式开（专注中，她不吵你）' : '安静模式关'));
  });

  play.on('done', () => { quiet = false; });
}

// ---------------------------------------------------------------------------
// 光标位置：让她的视线能跟到窗口外面去
//
// 角色窗口只有 420x700，鼠标绝大部分时间根本不在里面 —— 而 forward:true
// 只转发落在窗口范围内的 mousemove。所以「视线跟着鼠标」这件事，
// 光靠渲染层那边的事件是做不全的，最需要它的场合恰恰收不到事件。
//
// 这里按 120ms 问一次全局光标位置，换算成相对角色窗口的坐标推过去。
// 三道闸：窗口不可见不问、坐标没变不推、取不到就安静跳过。
// 单次 getCursorScreenPoint 是一个很轻的系统调用，这个频率下开销可以忽略。
// ---------------------------------------------------------------------------
let cursorTimer = null;
let lastCursorKey = '';
let presenceTimer = null;

/**
 * 你人还在不在电脑前。
 *
 * 心情系统需要分清「你去开会了」和「你就在旁边打游戏晾着她」——
 * 前者她该安静等着，后者才有资格委屈。判据用系统空闲时间：
 * 三分钟没碰过键鼠就当你人不在。
 *
 * 只喂一个时间戳，不读你在干什么、不看窗口标题，
 * 也不往任何地方发 —— 就是问一句「键鼠刚才动过吗」。
 */
// 走开多久，回来才值得她抬个头。
// 设 15 分钟是调出来的：接杯水上个厕所回来就一惊一乍，那比没反应还烦人。
const WELCOME_MIN = 15;

let awaySince = 0; // 人是什么时候走的（0 = 人就在）

function startPresenceWatch() {
  clearInterval(presenceTimer);
  const { powerMonitor } = require('electron');
  presenceTimer = setInterval(() => {
    if (!mood) return;

    let idle;
    try {
      // 返回秒。锁屏时 Windows 上这个值会一直涨，正好也算「人不在」
      idle = powerMonitor.getSystemIdleTime();
    } catch (_) {
      return; // 拿不到就不喂 —— mood 那边会退回「一直当你在」，跟以前的行为一致
    }

    if (idle >= 180) {
      // 记的是「你实际停手的那一刻」，不是「我发现你不在的那一刻」——
      // 这一拍最多晚 20 秒，减掉 idle 才算得准
      if (!awaySince) awaySince = Date.now() - idle * 1000;
      return;
    }

    // 人回来了。这个信号以前只喂给 tick() 算数值，屏幕上一点反馈都没有 ——
    // 你走开一小时回来，她跟没事人一样坐着
    if (awaySince) {
      const goneMin = (Date.now() - awaySince) / 60000;
      awaySince = 0;
      if (goneMin >= WELCOME_MIN) {
        log('[presence] 你走开了 ' + Math.round(goneMin) + ' 分钟，她抬头看你一眼');
        mood.onReturn(goneMin);          // 台词和表情（本地台词库，不花钱）
        send('pet:welcome', { goneMin }); // 动作（本地算的，不花钱）
      }
    }
    mood.onSeen();
    // 20 秒一拍而不是 60 秒：「你回来了」要是能晚一分钟才反应，那就不叫反应了。
    // 代价只是一次系统调用
  }, 20 * 1000);
  if (presenceTimer.unref) presenceTimer.unref();
}

function startCursorWatch() {
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;

    let p;
    let b;
    try {
      p = screen.getCursorScreenPoint();
      b = petWin.getBounds();
    } catch (_) {
      return; // 锁屏、切用户之类的时候会取不到，跳过这一拍就行
    }

    const x = p.x - b.x;
    const y = p.y - b.y;
    const key = x + ',' + y;
    // 鼠标没动就别推 —— 这也正是渲染层判断「你走神了」的依据：
    // 收不到新坐标，她过几秒自己就把视线飘走了
    if (key === lastCursorKey) return;
    lastCursorKey = key;

    if (petWin && !petWin.isDestroyed()) {
      try { petWin.webContents.send('pet:cursor', { x, y }); } catch (_) { /* 竞态 */ }
    }
  }, 120);
  if (cursorTimer.unref) cursorTimer.unref();
}

// ---------------------------------------------------------------------------
// 把「她在干什么」翻译成「她什么心情」
// ---------------------------------------------------------------------------
// 合成语音并推给渲染层播放。失败了只记日志 —— 说不出话不该影响她干活。
//
// important=true 的那些（任务播报）不会被后来的话顶掉：情绪台词丢一句无所谓，
// 「XX 项目干完了」这种是你真的需要听到的。
async function speakLine(text, opts = {}) {
  if (!voice || !text) return;
  // 先打个招呼：合成要几秒，这几秒里气泡不许自己收掉。
  // 不然常见的样子是「字看到一半没了，然后一个没有气泡的她开始念」
  send('voice:pending', { text: String(text) });
  try {
    const r = await voice.speak(text, opts);
    if (r) {
      log('[voice] 念「' + r.text + '」 ' + Math.round(r.audio.length / 1024) + 'KB');
      send('voice:play', r);
    }
  } catch (err) {
    log('[voice] 合成失败: ' + err.message);
  }
}

// 把一段（可能很长的）成果压成一句她会说出口的话
function briefly(text, max = 46) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'));
  return (stop > 10 ? cut.slice(0, stop + 1) : cut) + '…';
}

function wireEvents() {
  mood.on('change', (e) => {
    // 表情该换还得换（专注的时候她也会累），但**嘴要闭上**：
    // 番茄钟期间她在旁边碎碎念「有点累了…」，这功能就白做了
    send('mood:change', quiet ? { ...e, line: null } : e);
    // 只念她自己的情绪台词。干活时的输出又长又密，全念出来会很吵。
    if (e.line && !quiet) speakLine(e.line);
  });

  // 到日子了（认识满一个月、一起干完第一百个活…）。话和动作 mood 那边已经
  // 走 change 发出去了，这儿只管在流水上留一条印，面板「今天」那栏会显示。
  // **一分钱不花**：台词是预置的，不问 claude
  mood.on('milestone', (e) => {
    log('[mood] 到日子了: ' + e.id + ' — ' + e.text);
    journal.add('milestone', { id: e.id, text: e.text });
  });

  sessions.on('start', (e) => {
    log(`[session] 开工 ${e.name} :: ${e.task}`);
    mood.onTaskStart();
    journal.add('task-start', { project: e.name });
    send('session:start', e);
  });

  sessions.on('tool', (e) => {
    mood.onTool(e.count);
    send('session:tool', e);
  });

  sessions.on('trouble', (e) => {
    mood.onTrouble(e.count);
    send('session:trouble', e);
  });

  sessions.on('say', (e) => {
    // 她干活时说的话，直接顶到气泡上
    send('session:say', e);
  });

  sessions.on('done', (e) => {
    log(`[session] 收工 ${e.name} ok=${e.ok} 用时=${Math.round((e.elapsedMs || 0) / 1000)}s ` +
        `工具=${e.toolCount} 错误=${e.errorCount}`);
    mood.onTaskDone(e);
    journal.add('task-done', {
      project: e.name, ok: e.ok, ms: e.elapsedMs,
      tools: e.toolCount, errors: e.errorCount, costUsd: e.costUsd,
    });
    send('session:done', e);
  });

  sessions.on('log', (m) => log('[session] ' + m));

  // --- 开出去的终端：她在旁边盯着 ---------------------------------------

  terminals.on('change', () => {
    send('term:change', { count: terminals.liveCount() });
  });

  // 一个阶段干完了，主动来汇报。这就是「监督」的落点：
  // 你不用一直盯着那个终端窗口，她做完一段会自己过来说。
  // 每完事一轮记一笔流水。**不能挂在下面那条 report 上** ——
  // 它被 minGapSec 节流掉、supervise 关了压根不发，拿它当账本必漏。
  terminals.on('turn', (e) => {
    journal.add('turn', {
      termId: e.id, project: e.project, lane: e.laneName,
      tools: e.tools, errors: e.errors,
    });
  });

  // 她在终端里烧的钱。以前这笔是黑洞（那是独立的 claude 进程，hook 事件里
  // 没有成本字段），面板只能写「另有 N 轮算不到钱」；现在从 Claude Code 自己的
  // 会话记录里读出来（src/cost.js）。走的是流水账已有的 costUsd 字段，
  // 所以「今天 / 本月花了多少」自动就把这笔算进去了
  terminals.on('cost', (e) => {
    journal.add('term-cost', {
      termId: e.id, project: e.project, lane: e.laneName, costUsd: e.costUsd,
    });
  });

  // codex 的窗口认领到会话文件了 —— 记到那条线上，「接着聊」从此能真接上
  terminals.on('codex-session', (e) => {
    sessions.rememberCodexSession(e.dir, e.laneId, e.sessionId, e.file);
  });

  // claude 的窗口在里面换了会话（用户敲了 /resume 或 /clear）—— 跟着改线上的记录。
  // 不跟的话「接着聊」永远接的是我们发出去但从没被写过的那个空 id
  terminals.on('claude-session', (e) => {
    sessions.rememberSession(e.dir, e.laneId, e.sessionId);
  });

  /**
   * 一条线的活干完了 —— 她脸上得有那一下。
   *
   * 这块以前是空的。「干完一个活是什么反应」写在 mood.onTaskDone 里（一遍过
   * 就得意四分钟、砸了会低落、还攒着「一起干完一百个活」那种日子），可它只挂在
   * 无头模式的 sessions 上，而默认早就换成真终端了 —— 于是那段代码
   * **在正常使用里一次都没跑过**，你看到的就是「活干完了，她毫无表示」。
   *
   * 派出去的活算她自己的成败，走完整的心情结算（有台词、会说出来）；
   * 你自己开的终端她只是在旁边盯着，只闪一下脸、一个数值都不动 ——
   * 不然你敲一晚上代码，她的情绪会被你的编译结果带着上蹿下跳。
   */
  terminals.on('finish', (e) => {
    log('[term] ' + e.name + ' 收工 ok=' + e.ok + ' 轮数=' + e.turns +
        ' 工具=' + e.tools + ' 错误=' + e.errors);
    if (!e.dispatched) {
      mood.flash(e.ok ? 'happy' : 'frustrated', null, 3600);
      return;
    }
    mood.onTaskDone({ ok: e.ok, elapsedMs: e.elapsedMs, errorCount: e.errors });
    // 结算完再闪一下。**光靠结算不保证脸上有变化** —— 中间报过错的那种
    // 「成了但不干净」只加 10 点心情，多半跨不过任何一条阈值，
    // 于是她那一刻的表情跟五分钟前一模一样，你根本看不出活干完了
    mood.flash(e.ok ? 'excited' : 'sad', null, 3600);
  });

  terminals.on('report', (e) => {
    // 【记账永远做，说不说另算。】关掉「开启监督」的人，关的是「她别每做完
    // 一段就过来说话」，不是「别记我干过什么」—— 所以下面这两笔在
    // e.quiet 时照样落地，只有播报那半段会提前收工。
    journal.add('report', {
      project: e.project, lane: e.laneName,
      tools: e.toolCount, errors: e.errorCount, files: e.files,
      brief: briefly(e.text, 60),
    });

    // 顺手记进这个项目的小抄，下次开终端带给她。
    // **拿不到原话时的那句兜底不要**（「动了 8 次工具，一路顺利」）——
    // 一点信息量都没有，进去就是白占一个坑位，总共才 6 条。
    if (!/^动了 \d+ 次工具/.test(String(e.text || ''))) {
      notes.append(e.dir, {
        task: e.task, text: e.text, errorCount: e.errorCount,
      });
    }

    if (e.quiet) return; // 到此为止：不弹气泡、不出声

    log(`[term] ${e.name} 阶段汇报: ${briefly(e.text, 80)}`);

    mood.onPhaseDone({ errorCount: e.errorCount });

    // 这一段里翻过车的话，脸上当场给一下。数值那边只是「少加两分」，
    // 那是慢慢累积、屏幕上看不出来的东西 —— 而你想知道的是「刚才那段出事了」。
    // 一个数值都不动，也不说话，纯粹是张脸。三秒后自己回到干活那张脸
    if (e.errorCount > 0) mood.flash('frustrated', null, 3000);

    const touched = e.files && e.files.length ? '改了 ' + e.files.join('、') + '。' : '';

    // 面板上更新，桌面上的她也把话说出来
    send('term:report', {
      id: e.id, name: e.name,
      text: briefly(e.text, 70),
      files: e.files,
      errorCount: e.errorCount,
    });
    send('session:say', {
      name: e.name,
      text: '「' + e.name + '」' + touched + briefly(e.text, 110),
      // 带上终端 id：点这个气泡就直接调出现场，而不是跳私聊。
      // 她刚汇报完一段，你最想干的事就是看一眼她到底改了什么
      termId: e.id,
    });

    // 念出来的那句**只挑关键的**，拼法见 terminals.js 的 spokenReport。
    // 气泡上那句照旧带原话 —— 看和听是两回事，看可以扫、听只能从头到尾熬完
    if (e.speak) {
      speakLine(spokenReport(e), { important: true, maxLen: 60 });
    }
  });

  // --- 私聊 ---------------------------------------------------------------

  chat.on('delta', (e) => send('chat:delta', e));

  chat.on('done', (e) => {
    send('chat:done', e);
    mood.onInteract('talk'); // 陪你聊天，亲密度是要涨的
    // 只记花了多少和多长，**不记聊了什么** —— 原话本来就在 chat.json 里，
    // 流水是长期留着的，没理由在这儿再存一份
    journal.add('chat', { chars: (e.text || '').length, costUsd: e.costUsd || 0 });
    // 聊天内容也念出来。用普通优先级 —— 你连着说好几句时，
    // 只念最新那句才对，不然她会排队把旧的一句句念完
    speakLine(e.text, { maxLen: 70 });
  });

  chat.on('error', (e) => send('chat:error', e));

  // 她说要跳/要唱，那就真的去跳、去唱
  chat.on('action', (a) => runAction(a));

  // 她派出去的活现在什么状况，每三秒一拍、只在变了的时候来。
  // 这条**不碰心情系统也不说话** —— 纯粹交给身体去表达。
  // 一段活跑几分钟，中间要是每隔一会儿念一句进度，比不说还烦
  terminals.on('pulse', (e) => {
    send('work:pulse', e);
    if (e && e.state !== 'none') {
      log('[term] 她现在的状态: ' + e.state + '（' + e.name + '，' +
          e.tools + ' 次工具 / ' + e.errors + ' 次报错）');
    }
  });

  // 得叫你一声的两种场合：那边卡在权限确认上（不叫能干等一整晚），
  // 或者她要动的东西不对劲（改到项目外面去了、要跑回不来的命令）。
  //
  // 话由 terminals 那边拼好（保证是能直接念的中文成句），这儿只管发出去 ——
  // 原来这儿是硬编码「那边在等你确认」，报警的话根本传不出来。
  terminals.on('attention', (e) => {
    log(`[term] ${e.name} 喊你（${e.kind || 'confirm'}）: ${e.text}`);
    // 这是最该一点就跳过去的场合，所以气泡上带终端 id
    send('session:say', { name: e.name, text: e.text, termId: e.id });
    speakLine(e.text, { important: true });
  });
}

// ---------------------------------------------------------------------------
// 你自己手动跑的 Claude Code —— 走官方 hook 感知
//
// 跟派活的区别很重要：这些活是**你**在干，不是她。所以只轻轻拨动情绪，
// 绝不去碰 busy 状态和 errorStreak 上限，否则你那边一报错她就当自己搞砸了，
// 整个心情系统会被你的编码活动带着跑。
// ---------------------------------------------------------------------------
function handleHookEvent(ev) {
  if (!ev) return;

  // 先问一句：这是不是她自己开出去的那些终端干的活？
  // 是的话走「监督」那条线（要汇报、要计进度），到此为止。
  if (terminals && terminals.onHookEvent(ev)) return;

  if (!mood) return;
  const name = ev.waifuEvent || ev.hook_event_name;
  const cwd = ev.cwd || ev.waifuCwd || '';
  const proj = cwd ? path.basename(cwd) : '';

  switch (name) {
    case 'UserPromptSubmit':
    case 'Stop':
      // 你在敲活儿，说明人就在电脑前 —— 至少不算冷落她
      mood.onInteract('talk');
      break;

    case 'PostToolUse': {
      const resp = ev.tool_response;
      const failed = resp && (resp.is_error || resp.error);
      // 封顶 2，够不到 frustrated 的门槛（3）—— 那个状态留给她自己的活
      if (failed) mood.onTrouble(Math.min(2, (mood.errorStreak || 0) + 1));
      break;
    }

    case 'Notification':
      send('session:say', { name: proj, text: '那边好像在等你确认。' });
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 唱跳
//
// 具体怎么跳在渲染层（dance.js 贴着每一帧算参数），这里只管三件事：
// 她累不累、放哪首歌、跳完心情怎么变。
// ---------------------------------------------------------------------------

// 精力见底还硬要她跳就太不近人情了 —— 一个跳一整天都不累的桌宠看着就假
function tooTired() {
  if (!mood || mood.energy >= 15) return null;
  const line = mood.isLateNight() ? '这么晚了…我困得站都站不稳。' : '我快累趴了，让我歇会儿吧。';
  send('session:say', { name: '', text: line });
  speakLine(line);
  return line;
}

function startDance(opts) {
  const o = typeof opts === 'number' ? { bpm: opts } : (opts || {});
  const tired = tooTired();
  if (tired) return { ok: false, error: tired };

  send('perform:dance', {
    bpm: o.bpm || 118,
    steps: Array.isArray(o.steps) ? o.steps : null,
    amp: o.amp,
    seconds: o.seconds,
  });
  mood.onPerform();
  log('[perform] 跳舞 bpm=' + (o.bpm || 118) +
      (o.steps ? ' 舞步=' + o.steps.join('/') : '') +
      (o.amp ? ' 幅度=' + o.amp : ''));
  return { ok: true };
}

/**
 * 她在聊天里说要唱某首歌 —— 去你自己的 music 文件夹里翻。
 *
 * 只放你已经有的文件。她没有凭空唱出一首现成歌的本事，
 * 也不该假装有：找不到就老实说找不到，顺便报几首现成的。
 */
// 「随便来一首」的各种说法。她有时会把这类词当歌名填进来，
// 于是拿着「random」去 music 文件夹里翻，当然一首都翻不到 ——
// 日志里就留下一行 sing: {"song":"random"} 然后没了下文。
const ANY_SONG = /^(random|any|anything|whatever|随便|随便一首|随便来一首|随意|任意|都行|都可以|什么都行|一首歌|来一首)$/i;

// 「当前目录随机播放」这类说法，光靠上面那个全等匹配是接不住的（它 ^…$ 锚死了）。
// 但也不能直接改成包含匹配 —— 万一真有一首歌叫《随便》就点不着了。
// 所以这个只在**按字面确实找不到**之后才用，见 singByKeyword。
const RANDOM_HINT = /随机|随便|随意|都行|都可以|任意|无所谓|shuffle|random/i;

/**
 * 她这儿没有这首歌的时候。
 *
 * 只做一件事：**明确告诉你没有**，并且报出手上有什么。
 * 帮你开个搜索页是可选的下一步 —— 歌从哪儿来是你自己的决定，
 * 这儿不碰下载、不碰任何平台接口。
 */
function songSearchUrl(keyword) {
  return 'https://www.bing.com/search?q=' + encodeURIComponent(String(keyword || '') + ' 歌曲');
}

function singByKeyword(keyword, o = {}) {
  const songs = performer.list().filter((s) => !s.tooBig);
  let k = String(keyword || '').trim().toLowerCase();

  // 泛指词直接当没指定，随机挑
  if (ANY_SONG.test(k)) {
    log('[perform] 「' + keyword + '」是泛指，随便挑一首');
    k = '';
  }

  if (!songs.length) {
    const line = 'music 文件夹里还一首歌都没有，你先丢几首进去我才能唱。';
    send('session:say', { name: '', text: line });
    speakLine(line, { important: true, maxLen: 60 });
    return { ok: false, error: line };
  }

  // 按可信度从严到宽找：歌名完全一样 → 歌名包含 → 歌手 → 文件名。
  // 歌手放在里面，是为了「放首某某某的歌」这种说法也能点得到。
  let hit = null;
  if (k) {
    const title = (s) => (s.title || '').toLowerCase();
    const artist = (s) => (s.artist || '').toLowerCase();
    const byArtist = songs.filter((s) => artist(s) && (artist(s).includes(k) || k.includes(artist(s))));

    hit = songs.find((s) => title(s) === k)
       || songs.find((s) => title(s).includes(k))
       || songs.find((s) => k.includes(title(s)) && title(s).length >= 2)
       // 同一个歌手有好几首就随机挑一首，别每次都放同一首
       || (byArtist.length ? byArtist[Math.floor(Math.random() * byArtist.length)] : null)
       || songs.find((s) => s.file.toLowerCase().includes(k));
  }

  // 按字面找不着，但你说的其实是「随便放一首」（比如「当前目录随机播放」）。
  // 这个判断必须放在字面查找**之后** —— 否则真有一首歌叫《随便》就永远点不着了
  if (k && !hit && RANDOM_HINT.test(k)) {
    log('[perform] 「' + keyword + '」按歌名找不到，但听着是要随机 —— 在 music 里随便挑一首');
    k = '';
  }

  if (k && !hit) {
    const names = songs.slice(0, 4)
      .map((s) => s.title + (s.artist ? '（' + s.artist + '）' : '')).join('、');
    const line = '我这儿没有「' + keyword + '」诶。现在有的是：' + names +
                 (songs.length > 4 ? ' 什么的' : '');
    // 歌从哪儿来是你自己的决定 —— 她只负责把搜索页开给你，
    // 下不下、从哪儿下都不归她管，代码里也没有任何下载的路
    send('greet:say', {
      say: line,
      face: 'sad',
      hold: 14000,
      offer: { kind: 'websearch', label: '帮我搜一下', payload: keyword },
    });
    speakLine(line, { important: true, maxLen: 80 });
    return { ok: false, error: line };
  }

  return singSong((hit || songs[Math.floor(Math.random() * songs.length)]).file, o);
}

/**
 * 即兴哼唱：她自己现编几句词，用她的声音哼出来，同时跟着跳。
 *
 * 音调拉高、语速放慢 —— TTS 本来是朗读引擎，不这么调听着就是在念稿。
 * 这不是真的歌声合成，但配上跳舞和口型，「她在哼歌」这个意思是到了。
 */
async function humLyrics(lyrics, o = {}) {
  const text = String(lyrics || '').trim();
  if (!text) return { ok: false, error: '没词儿' };

  const tired = tooTired();
  if (tired) return { ok: false, error: tired };

  try {
    const r = await voice.speak(text, {
      important: true,
      maxLen: 220,
      rate: '-12%',
      pitch: '+35Hz',
    });
    if (!r) return { ok: false, error: '没合成出来' };

    send('perform:song', {
      audio: r.audio, // base64，渲染层那边两种格式都收
      title: '她现编的',
      bpm: o.bpm || 100,
      steps: Array.isArray(o.steps) ? o.steps : null,
      amp: o.amp,
      mime: 'audio/mpeg',
      volume: 0.9,
    });
    mood.onPerform();
    log('[perform] 哼了一段自己编的：' + text.slice(0, 40));
    return { ok: true };
  } catch (err) {
    log('[perform] 哼不出来: ' + err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 戳她一下，她主动搭话
//
// 这句话是现想的 —— 她知道现在几点、自己什么心情、你多久没理她、
// 手头有几个活在跑、音乐文件夹里有没有歌。所以说出来的是应景的话，
// 不是台词库里那几句轮着念。
//
// 成本跟着你的点击走：不点就不花钱，狂点有冷却挡着。
// ---------------------------------------------------------------------------

const GREET_COOLDOWN_MS = 25 * 1000;

// 连着戳的话别每下都调一次 —— 钱和耐心都受不了。
// 冷却期内就退回台词库那几句，她照样有反应。
//
// 玩游戏 / 专注期间也一律不调：那会儿气泡上正摆着一道题等你点，
// 她再冒一句现想的话出来，会把题目直接顶掉。
function canGreet() {
  if (quiet || (play && play.busy)) return false;
  return Boolean(greeter && mood) && Date.now() - lastGreetAt >= GREET_COOLDOWN_MS;
}

async function greetOnTouch(kind) {
  lastGreetAt = Date.now();
  send('greet:thinking');

  const songs = performer ? performer.list().filter((s) => !s.tooBig) : [];
  const r = await greeter.greet({
    kind,
    mood: mood.describe(),
    idleMin: Math.round((Date.now() - mood.lastInteract) / 60000),
    // 「你多久没理我」和「你人在不在」是两件事，心情系统里早就分开了，
    // 但一直没进过提示词 —— 她因此永远分不清你是走开了还是在晾着她
    awayMin: (Date.now() - mood.lastSeen) / 60000,
    terminals: terminals ? terminals.liveCount() : 0,
    jobs: sessions ? sessions.list().length : 0,
    // 真实 BPM 早就在 perform.js 里解析好了（文件名方括号里那个数），
    // 但只把歌名传了过去 —— 她提议跳舞时还在 60~160 之间瞎猜
    songs: songs.map((s) =>
      s.title + (s.artist ? '（' + s.artist + '）' : '') + (s.bpm ? ' ' + s.bpm + 'BPM' : '')),
    projects: sessions ? sessions.recentProjects() : [],
    // 私聊窗口刚聊过的话。桌面上这个她和聊天框里那个她**是同一个人**，
    // 不带这个的话，你刚在聊天框跟她说完话、回头戳一下桌面上的她，
    // 她会一脸茫然地重新自我介绍
    chat: recentChatBits(),
  });

  if (!r) {
    // 没生成出来（超时、网络不好）。别让气泡上那三个点一直转着，
    // 回落到台词库随便说一句 —— 她照样有反应，只是不那么应景。
    lastGreetAt = 0;
    send('greet:say', { say: pickLine(kind === 'pet' ? 'pet' : 'idle'), face: 'normal' });
    return false;
  }

  // 这是她身上最贵的一笔（约 $0.0151 一次），记进流水才谈得上「今天花了多少」。
  // 上面那条 r 为 null 的分支**故意不记** —— 那次可能也花了钱但拿不到数，
  // 宁可少算，也不编一个数字。
  journal.add('greet', { kind, costUsd: r.costUsd || 0 });

  send('greet:say', r);
  speakLine(r.say, { maxLen: 70 });
  return true;
}

/**
 * 私聊里最近说过的几句，拿去垫给桌面上那个她。
 *
 * 卡半小时是有意的：半小时前聊的，你多半已经忘了，她再提起来反而突兀。
 * 也只取两句 —— 这是给她一个「话头」，不是把聊天记录搬过去。
 */
function recentChatBits(maxAgeMin = 30, n = 2) {
  if (!chat) return [];
  try {
    const cutoff = Date.now() - maxAgeMin * 60000;
    return chat.history()
      .filter((m) => m && m.text && !m.error && (m.ts || 0) > cutoff)
      .slice(-n)
      .map((m) => (m.role === 'user' ? '他说「' : '你说「') +
                  String(m.text).replace(/\s+/g, ' ').slice(0, 40) + '」');
  } catch (_) {
    return []; // 聊天存档有问题不该连累搭话
  }
}

/**
 * 换整套贴图的存档，**必须按模型分开存**。
 *
 * 贴图和网格的 UV 是死死绑在一起的。存成全局一个值的话，你给 Mao 选了一套皮肤、
 * 转头切到 Hiyori，启动时照样把 Mao 那张 2048 的图糊到 Hiyori 身上 ——
 * 每片网格都取到完全不相干的像素，出来是一张糊脸，眼睛长在下巴上。
 * 这个事故真的发生过，而且**一句报错都没有**。
 *
 * 老格式（一个全局字符串）读的时候顺手挡掉：只有当它确实躺在当前模型目录里
 * 才认，否则当没设过。写的时候会自然升级成按模型分的对象。
 */
function atlasInside(file, modelPath) {
  if (!file) return false;
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  return norm(path.resolve(file)).includes(norm(path.dirname(modelPath)) + '/');
}

function savedAtlasFor(modelPath) {
  const a = (loadConfig().look || {}).atlas;
  if (!a) return '';
  if (typeof a === 'string') return atlasInside(a, modelPath) ? a : '';
  return atlasInside(a[modelPath], modelPath) ? a[modelPath] : '';
}

// 一套皮肤摊平成「第几张贴图换成哪个 url」—— 一张 png 只换第 0 张，一个目录整套换。
// 实现在 src/config.js（渲染层的替身和自检要用同一份）。渲染层是个 file:// 页面，
// 读不了目录也认不了 `D:\` 开头的路径，所以摊平和转 url 都得在这边做完。
const atlasUrls = config.atlasUrls;

function saveAtlas(modelPath, file) {
  send('pet:atlas', { urls: atlasUrls(file) });
  try {
    // deepMerge 遇到 plain object 会合并；老格式那个字符串会被整个换成对象，
    // 正好完成升级
    config.patch({ look: { atlas: { [modelPath]: file } } });
  } catch (_) { /* 存不上就只这次有效 */ }
}


/**
 * 没装 Claude Code 就别让人干等着。
 *
 * 这条是给「发给别人」准备的。她的唱跳、摸头、小游戏、换装一样都不依赖 claude，
 * 拿到包的人双击就能玩；但「派活」和「私聊」是真的在调 claude。
 * 不拦一下的话，对方点下去等半天，最后收到一句 `spawn claude ENOENT` ——
 * 那句话既不说明发生了什么，也不说明该怎么办。
 */
function guardClaude() {
  if (claudeInstalled()) return null;
  return {
    ok: false,
    // missing 让面板长出「帮我装」按钮；这段话也会出现在没按钮的地方
    // （私聊窗、气泡），所以「派活面板上」四个字得说全
    missing: 'claude',
    error: '这台电脑上没找到 Claude Code —— 「派活」和「私聊」要靠它'
         + '（唱跳、摸头、小游戏都不用）。派活面板上点「帮我装」，'
         + '我自己就能装好；或者「用谁来干」选 Codex 也能派活。',
  };
}

// 按面板上选的 CLI 拦：选了 codex 就查 codex，别拿 claude 的标准冤枉人
/**
 * 问一次「那个 hook 的信任哈希是多少」，存进 config。
 *
 * 【为什么要有这一步。】codex 的 hook **不被信任就静默不跑** —— 不报错、
 * 不警告、日志里一个字都没有，表现就是「她还是不知道 codex 在等你确认」。
 * 信任是按 hook 定义的内容哈希记的，算法没公开，但 codex 自己会报：
 * 起一个本地 app-server 问 `hooks/list` 就有（不调模型、不花钱，约 1.6 秒）。
 *
 * 哈希只跟命令串有关，也就是只跟这台机器上 node 和 notify.js 的路径有关，
 * **存一次管一辈子**，换了安装位置才重问（所以 key 里带上那两个路径）。
 *
 * 摸着头做：拿不到就算了，那次窗口只是没有「等你确认」的提醒，照样能干活；
 * 同一时刻只许有一个在飞，别每点一次 codex 就起一个 app-server。
 */
let codexHashProbing = false;
function ensureCodexHookHash() {
  if (codexHashProbing) return;
  const notifyFile = path.join(__dirname, '..', 'hooks', 'notify.js');
  const nodeBin = terminals ? terminals.node.bin : process.execPath;
  const want = nodeBin + '|' + notifyFile;

  const cur = loadConfig().codex || {};
  if (cur.hookHash && cur.hookFor === want) return; // 存过了，路径也没变

  codexHashProbing = true;
  try {
    agents.probeCodexHookHash(
      { bin: agents.resolveCodexBin(), notifyFile, nodeBin },
      (hash) => {
        codexHashProbing = false;
        if (!hash) { log('[codex] 没问到 hook 的信任哈希，这次先不带（不影响干活）'); return; }
        try {
          config.patch({ codex: { hookHash: hash, hookFor: want } });
          log('[codex] hook 信任哈希存好了 ' + hash.slice(7, 15) + '… 下次开窗她就能喊你了');
        } catch (_) { /* 存不上就下次再问 */ }
      }
    );
  } catch (_) { codexHashProbing = false; }
}

function guardAgent(agent) {
  if (agent === 'codex') {
    if (agents.codexInstalled()) {
      // 顺手把 hook 的信任哈希问了（存过就直接返回，不重复问）——
      // 不带信任的话「codex 在等你确认」那个提醒是静默失效的
      ensureCodexHookHash();
      return null;
    }
    return {
      ok: false,
      missing: 'codex',
      error: '这台电脑上没找到 Codex CLI，而「用谁来干」选的是它。'
           + '派活面板上点「帮我装」，我自己就能装好；'
           + '或者把「用谁来干」换回 Claude Code。',
    };
  }
  return guardClaude();
}

// ─── 没装就帮着装 ────────────────────────────────────────────────────────────
// 「用谁来干」选的 CLI 这台机器上没有 → 面板报错旁边给「帮我装」，点了走这儿。
// npm 全局装，跟手动敲 npm i -g 一模一样：命令落在 npm 全局 bin 里，那个目录
// 本来就在 PATH 上，装完**不用重启桌宠**，再点一次派活就能用。装好第一次用
// 还要登录（浏览器点授权，替不了），她开口报「装好了」时会顺嘴提醒。
const AGENT_PKG = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};
let agentInstalling = null; // 同一时刻只装一个，别让两个 npm -g 打架

function installAgent(agent) {
  const pkg = AGENT_PKG[agent];
  if (!pkg) return { ok: false, error: '不认识要装什么：' + agent };
  if (agentInstalling) return { ok: false, error: '正装着呢，装完这个再说' };
  if (!agents.onPath('npm')) {
    return {
      ok: false,
      // 「装完回来再点」是空头支票：本进程的 PATH 在启动那刻就冻住了，
      // 装完 Node 只有重启桌宠才看得见（评审抓的死循环）
      error: '这台电脑连 npm 都没有，我装不了 —— 得先去 nodejs.org 装个'
           + ' Node.js（选 LTS 那个）。装完把桌宠关了重开一次再来点我 ——'
           + ' 不重开的话我看不见新装的东西。',
    };
  }
  const name = agent === 'codex' ? 'Codex CLI' : 'Claude Code';
  agentInstalling = agent;
  log('[install] npm i -g ' + pkg + ' 开始');

  // shell:true 是必须的：npm 在 Windows 上是 .cmd，新版 node 不带 shell 直接
  // spawn 它会 EINVAL；给裸名 'npm' 让 cmd 自己按 PATH 找 —— 上面 onPath 已经
  // 确认在，而且裸名不含空格，躲开 "C:\Program Files\..." 在 shell 拼接时炸掉
  const child = spawn('npm', ['install', '-g', pkg], { windowsHide: true, shell: true });
  let tail = '';
  const eat = (b) => { tail = (tail + String(b)).slice(-2000); };
  child.stdout.on('data', eat);
  child.stderr.on('data', eat);

  let settled = false;
  let deadline = null;
  const finish = (ok, detail) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    agentInstalling = null;
    // npm 退出码 0 只证明装上了，不证明我找得着：全局 prefix 挪过
    // （npm config set prefix）而那个目录不在本进程 PATH 上时，guard 下次
    // 照样拦 ——「再点一次」就成了装-成功-再报错的死循环（评审抓的）。
    // 播喜报之前回头真探一次，探不到就说实话
    if (ok && !(agent === 'codex' ? agents.codexInstalled() : claudeInstalled())) {
      log('[install] ' + name + ' npm 装完了，但探不到它（多半全局目录不在 PATH 上）');
      send('session:say', {
        name: '',
        text: name + ' 装是装上了，但我找不着它 —— 多半 npm 的全局目录不在'
            + ' PATH 里。把它加进 PATH，或者重启一次桌宠，再点一次试试。',
      });
      send('agent:install-done', { agent, ok: false });
      return;
    }
    if (ok) {
      log('[install] ' + name + ' 装好了');
      send('session:say', {
        name: '',
        text: name + ' 装好啦！再点一次「派活 / 开终端」就能开工。'
            + '第一次用它会让你登录，照它窗口里说的来就行。',
      });
    } else {
      const gist = String(detail || '').split(/\r?\n/).map((s) => s.trim())
        .filter(Boolean).slice(-2).join('；').slice(0, 160);
      log('[install] ' + name + ' 没装上：' + (gist || '(没有输出)'));
      send('session:say', {
        name: '',
        text: name + ' 没装上……' + (gist ? '它说：' + gist : '多半是网络不给力，过会儿再试一次？'),
      });
    }
    send('agent:install-done', { agent, ok });
  };
  // ponytail: 网络烂到 10 分钟装不完就放弃并解锁；shell:true 下 kill 杀的是
  // cmd 壳，里面的 npm 可能还在跑 —— 只影响这一次的提示，不值得上进程树
  deadline = setTimeout(() => {
    try { child.kill(); } catch (_) { /* 已经退了 */ }
    finish(false, '装了 10 分钟还没装完，先不等了');
  }, 10 * 60 * 1000);
  child.on('error', (err) => finish(false, err.message));
  child.on('close', (code) => finish(code === 0, tail));
  return { ok: true };
}

/**
 * 这个目录已经有终端开着了吗？
 *
 * **以前这儿是一道墙**：同目录只准开一个终端，撞上了就把已开的那个调到前面。
 * 那道墙不是洁癖 —— 同目录的终端共用同一条 claude 会话 id，两个进程同时
 * --resume 同一条会话，记忆会被交错写坏，而且是事后根本查不出来的坏。
 *
 * 墙早拆了，而且现在连分叉都不用了：**每开一个终端就是一条全新的会话**，
 * 谁也读不到谁、谁也踩不着谁。所以这个判断只剩一个用处 —— 起名字：
 * 目录里头一个终端就叫项目名，之后再开的才在后面缀上线名，好在任务栏里分得开。
 */
function dirHasLiveTerminal(dir) {
  return Boolean(terminals) && terminals.livesFor(dir).length > 0;
}

/**
 * 从任务描述里挑一个线名出来。
 *
 * 你开好几个终端本来就是为了问不同的问题，**问题本身就是最好的名字** ——
 * 所以默认不让你多敲一个字。面板上那个名字框是可改的，改了就以你的为准。
 *
 * 注意这只是**兜底**：正常情况下名字是面板算好了传过来的（你看得见、能改）。
 * 这里管的是「面板没给」的路径，比如右键菜单直接开终端。
 */
function laneNameFromTask(task, project, n) {
  const first = String(task || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  // 「帮我」「请」这类开头一个信息量都没有，占的却是任务栏最金贵的前几个字
  const core = first.replace(/^(帮我|请|麻烦|你|能不能|可以|然后)+/g, '').trim();
  const cut = core.slice(0, 14);
  return cut || (project + ' #' + n);
}

/**
 * 开一条线的终端。
 *
 * 两种派法（「让她后台干」和「开终端我看着」）唯一的差别就是 minimized，
 * 别的一个字都不差 —— 所以合成一个函数。分开写的话，改一处忘一处，
 * 两条路的行为就会慢慢飘开。
 *
 * **仅剩的那条硬约束在这儿**：同一个目录随便开几个终端都行（每个都是一条
 * 全新会话），但**你点「接着聊」回到的那条老线只能有一个**。两个终端
 * --resume 同一条会话 id，记忆照样会被交错写坏。所以撞上了就把那个窗口
 * 调到你面前，而不是再开一个。
 */
/**
 * 派活能选的模型。白名单而不是随便收 —— 这个值最终会拼进命令行
 * （term-shell 的 --model），收任意字符串等于让面板往命令行里塞参数。
 * 空串 = 不传 --model，让 claude 用它自己设置里的。
 */
const DISPATCH_MODELS = new Set([
  '', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5',
]);

/**
 * 面板传来的模型：过一遍白名单，顺手记住。
 *
 * 「记住」是这个功能的一半 —— 你选一次，后台干 / 开终端两条路从此都默认用它，
 * 下次打开面板还是它。不认识的值当没选（比如老版本存档里的脏数据）。
 */
function resolveDispatchModel(raw) {
  const m = String(raw == null ? '' : raw).trim();
  if (!DISPATCH_MODELS.has(m)) return undefined;
  try {
    if ((loadConfig().dispatch || {}).model !== m) config.patch({ dispatch: { model: m } });
  } catch (_) { /* 存不上就只这次有效 */ }
  return m || undefined;
}

/**
 * 面板传来的「用谁来干」：只做白名单归一化，**这里不落盘**。
 * 「记住」由面板下拉的 onchange 直接 saveSettings —— 原来在这儿 patch 的话，
 * 没装 codex 的机器上被 guard 拦下的那次尝试也会把 'codex' 写进 config，
 * 之后所有不带 agent 字段的入口（比如老线的「接着聊」）全撞「没找到 Codex」。
 * 另外「再来 / 接着聊」带的是**那条线自己的** agent，本来就不该改写全局默认。
 * 不认识的值一律当 claude —— 老存档、老面板没这个字段，行为必须原样。
 */
const DISPATCH_AGENTS = new Set(['claude', 'codex']);

function resolveDispatchAgent(raw) {
  const a = String(raw == null ? '' : raw).trim();
  return DISPATCH_AGENTS.has(a) ? a : 'claude';
}

function openLaneTerminal(opts, { minimized }) {
  const dir = opts.projectPath;
  const wantLane = opts.laneId || null;

  // 想回到的那条线已经开着了 → 调过去，别开第二个
  if (wantLane && terminals) {
    const live = terminals.livesFor(dir).find((t) => t.laneId === wantLane);
    if (live) {
      focusTerminal(live.id);
      return { id: live.id, name: live.name, dir, focused: true, focusedLane: live.laneName || '' };
    }
  }

  const extra = !wantLane && dirHasLiveTerminal(dir);

  // 名字：面板算好传过来的优先（你看得见、能改）；没给就从任务描述兜底
  let laneName = String(opts.laneName || '').trim();
  if (extra && !laneName) {
    const project = path.basename(path.resolve(dir));
    laneName = laneNameFromTask(opts.task, project, terminals.livesFor(dir).length + 1);
  }

  const info = sessions.prepareTerminal({
    projectPath: dir,
    laneId: wantLane,
    laneName,
  });

  /**
   * 那条会话已经有个窗口开着在写了 → 调过去，绝不开第二个。
   *
   * 上面按 laneId 挡过一道，这儿按**真实会话 id** 再挡一道 —— 两者会岔开：
   * 用户在 A 窗口里 `/resume` 到了 B 线那条会话，A 和 B 的 laneId 不一样，
   * 但底下是同一条会话。两个 claude 同时 --resume 它，记忆会被交错写坏，
   * 而且是事后查不出来的坏（不报错、不崩，只是她开始把两件事混着说）。
   */
  if (info.resume && terminals) {
    const busy = terminals.livesFor(dir).find((t) => t.sessionId === info.sessionId);
    if (busy) {
      focusTerminal(busy.id);
      // 带上是**哪条线**的窗口：这道闸命中的场景恰恰是「调出来的不是你点的那条」
      // （laneId 不同才轮得到这道闸），不说清楚你会对着一个陌生的窗口发懵
      return {
        id: busy.id, name: busy.name, dir, focused: true,
        focusedLane: busy.laneName || '', otherLane: busy.laneId !== wantLane,
      };
    }
  }

  // info.name 是 path.basename 出来的项目名，天然不带路径。
  // 上面「已经开着就调过去」那条早退分支不记 —— 那次没开新的。
  journal.add('term-open', {
    project: info.name, lane: info.laneName || laneName,
    mode: minimized ? 'bg' : 'watch',
  });

  const agent = opts.agent === 'codex' ? 'codex' : 'claude';

  return terminals.open({
    ...info,
    // codex 的 resume 只有认领过会话才有意义（prepareTerminal 算好了：
    // codexSessionId 在，resume 才可能为 true）。agent 配错的防线也在这儿 ——
    // 没有 codexSessionId 的 codex 线永远当新开
    resume: agent === 'codex' ? Boolean(info.codexSessionId) : info.resume,
    codexSessionId: agent === 'codex' ? info.codexSessionId : undefined,
    codexFile: agent === 'codex' ? info.codexFile : undefined,
    task: opts.task,
    // 面板上这一次选的权限模式（没选就是 undefined，terminals 回落到配置默认值）
    permissionMode: opts.permissionMode || undefined,
    // codex 不认 claude 的模型名，这条线上永远不传（模型跟 ~/.codex/config.toml 走）
    model: agent === 'codex' ? undefined : opts.model,
    port: hookPort,
    minimized,
    agent,
    bin: agent === 'codex' ? agents.resolveCodexBin() : undefined,
    // 这个项目的小抄。claude 走 --append-system-prompt-file；codex 没这参数，
    // 把文件路径给 term-shell，由它把内容拼进开场 prompt（没派活就不拼）。
    // 两条路都是：没攒下东西就一个字都不多带
    extraArgs: agent === 'codex' ? undefined : notes.argsFor(dir),
    notesFile: agent === 'codex' ? notes.fileFor(dir) : undefined,
  });
}

// 右键菜单里显示的终端状态
const TERM_STATUS_WORD = {
  running: '干着呢', waiting: '在等你确认', idle: '这轮完事了', done: '干完了',
};

/**
 * 把某个终端调到最前面来。
 *
 * 后台派的活现在是最小化的真终端，所以这条路是「看现场」的主入口：
 * 右键菜单、点她汇报的那个气泡，都走这儿。
 */
function focusTerminal(id) {
  if (!terminals) return;
  panelYield(); // 终端要上来了，置顶的面板先让开，不然盖着它像没反应
  terminals.focus(id).then((r) => {
    if (r && !r.ok && r.error) {
      send('session:say', { name: '', text: r.error });
    }
  }).catch((err) => log('[term] 置顶失败: ' + err.message));
}

// 这儿原来有个 liveTerminalFor(name)，**已删**。
//
// 它定义在这儿、注释写着「给点气泡看现场用」，但**全项目没有一处调用** ——
// 真正那条路早就改成按 termId 走了（session:say 带 termId → stage.js
// linkBubbleTo → focusTerminal(id) → terminals.focus(id)），是对的。
//
// 删掉是因为它是个陷阱：它按 `name` 找终端，而 name 就是目录 basename。
//   · 同一个目录现在能开好几条线 → 全都叫一个名字，find 拿到的是最新那条，
//     你点「查支付」那条汇报，跳出来的是「登录页」那个窗口
//   · 就算不开多条，C:\work\web 和 D:\proj\web 也都叫 web，照样撞
//   · 它还有个兜底 `find(status==='running'||'waiting')` —— 名字没匹配上时
//     **随便返回一个正在跑的终端**，那是纯粹的乱认人
//
// 留着一段「看起来正是干这事、其实是错的」的死代码，比没有更危险。

// 从心情系统那套台词库里挑一句垫着
function pickLine(bank) {
  const list = LINES[bank] || LINES.idle;
  return list[Math.floor(Math.random() * list.length)];
}

// 你点了她提议的那个按钮
function acceptOffer(offer) {
  if (!offer || !offer.kind) return;
  log('[greet] 你答应了: ' + offer.kind + ' —— ' + offer.label);
  mood.onInteract('talk');

  switch (offer.kind) {
    case 'dance':
      startDance({ bpm: offer.bpm, amp: offer.amp, steps: offer.steps, seconds: 32 });
      break;

    case 'song':
      // payload 是歌名关键词，空的就随便挑一首
      if (offer.payload && offer.payload.trim()) singByKeyword(offer.payload, offer);
      else singSong(null, offer);
      break;

    case 'websearch': {
      // 她这儿没有这首歌，你说要搜。开个浏览器搜索页就到此为止 ——
      // 歌从哪儿来、下不下载是你自己的事，桌宠不参与
      const q = String(offer.payload || '').trim();
      if (!q) return;
      require('electron').shell.openExternal(songSearchUrl(q)).catch((err) =>
        log('[perform] 打不开浏览器: ' + err.message));
      send('session:say', { name: '', text: '搜索页开好了，找到合适的丢进 music/ 我就能唱。' });
      break;
    }

    case 'joke': {
      // 笑话在提议的时候就一起写好了，所以这儿不用再花一次钱
      const joke = String(offer.payload || '').trim();
      if (!joke) { send('session:say', { name: '', text: '……我忘了。' }); return; }
      send('session:say', { name: '', text: joke });
      speakLine(joke, { important: true, maxLen: 160 });
      mood.onInteract('talk');
      break;
    }

    default:
      break;
  }
}

// 她在聊天里说要做什么，就真的去做
function runAction(a) {
  if (!a || !a.act) return;
  log('[perform] 她要 ' + a.act + ': ' + JSON.stringify(a).slice(0, 160));

  switch (a.act) {
    case 'dance': startDance(a); break;
    case 'sing': singByKeyword(a.song, a); break;
    case 'hum': humLyrics(a.lyrics, a); break;
    case 'face': send('perform:face', { name: a.name }); break;
    case 'stop': stopPerform(); break;
    default: log('[perform] 不认识的动作: ' + a.act);
  }
}

function stopPerform() {
  send('perform:dance', { stop: true });
  return { ok: true };
}

function singSong(file, o = {}) {
  const tired = tooTired();
  if (tired) return { ok: false, error: tired };

  try {
    const song = performer.load(file);
    send('perform:song', {
      ...song,
      // 文件名里标的 BPM 最准，她自己估的只是回落
      bpm: song.bpm || o.bpm,
      steps: Array.isArray(o.steps) ? o.steps : null,
      amp: o.amp,
    });
    mood.onPerform();
    speakLine('那我唱一首咯。', { maxLen: 30 });
    return { ok: true, title: song.title };
  } catch (err) {
    log('[perform] 放不了: ' + err.message);
    send('session:say', { name: '', text: err.message });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function wireIpc() {
  // --- 角色窗口的鼠标行为 ---

  // 整个窗口是一块 420x540 的透明画布，但角色只占中间一小片。
  // 不穿透的话，这块透明区域会把底下的窗口全挡住 —— 你点不到桌面图标。
  // forward:true 保证穿透状态下 renderer 仍能收到 mousemove，否则没法判断何时该恢复。
  ipcMain.on('pet:set-click-through', (_e, through) => {
    if (!petWin || petWin.isDestroyed()) return;
    petWin.setIgnoreMouseEvents(Boolean(through), { forward: true });
  });

  // 拖动：renderer 传来的是本次 mousemove 的位移量，主进程负责挪窗口。
  // 不用 -webkit-app-region:drag，那会吃掉 canvas 上所有鼠标事件，
  // 角色就没法响应点击和视线跟随了。
  ipcMain.on('pet:drag', (_e, { dx, dy }) => {
    if (!petWin || petWin.isDestroyed()) return;
    const [x, y] = petWin.getPosition();
    let nx = Math.round(x + dx);
    let ny = Math.round(y + dy);

    // 夹在屏幕里，别让她被拖出去找不回来。
    // 用鼠标当前所在那块屏的 workArea：多屏的时候按主屏算会把她卡在错误的范围里。
    // 留 GRAB 那么一条边可以露在外面 —— 完全不许出界的话，
    // 贴着屏幕边缘放（很多人就爱这么摆）会顶得很别扭。
    try {
      const GRAB = 80;
      const { x: wx, y: wy, width: ww, height: wh } =
        screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const [w, h] = petWin.getSize();
      nx = Math.max(wx - w + GRAB, Math.min(wx + ww - GRAB, nx));
      ny = Math.max(wy, Math.min(wy + wh - GRAB, ny)); // 顶部不许出去，出去就抓不着了
    } catch (_) {
      /* 取不到屏幕信息就不夹，总比拖不动强 */
    }

    petWin.setPosition(nx, ny);
  });

  /**
   * 哪些互动值得让她「现想一句」。
   *
   * **拖动绝对不能在里面。** 原来这儿对任何 kind 都跑 canGreet()，
   * 于是你把她挪个位置、只要过了 25 秒冷却，就会真的起一个 claude 进程 ——
   * 一次一两分钱，一天挪几次就是白烧的钱，而且你根本看不出来它花了。
   * 拖动是「摆家具」，不是「找她说话」。
   */
  const GREET_KINDS = new Set(['pet', 'poke', 'talk']);

  ipcMain.on('pet:interact', (_e, kind) => {
    const k = kind || 'pet';
    const willGreet = GREET_KINDS.has(k) && canGreet();
    // 要现想一句的话就别让台词库先抢着说 —— 否则会先蹦一句「干嘛啦」，
    // 两秒后又冒出一句正经的，像两个人在说话
    if (mood) mood.onInteract(k, { silent: willGreet });
    if (willGreet) {
      greetOnTouch(k).catch((err) => log('[greet] 出错: ' + err.message));
    }
  });

  /**
   * 拖动这类「只要个反应，不要她开口」的互动。
   *
   * 单开一条路而不是复用 pet:interact，是为了让「会不会花钱」这件事
   * 在代码里一眼可见：走这条的永远不花钱，没有例外、也没有 kind 白名单要维护。
   */
  ipcMain.on('pet:react', (_e, kind) => {
    if (!mood) return;
    if (kind === 'drag') {
      // 被拎起来的时候吓一跳，放下之后自己缓过来。
      // 好感不动 —— 挪个位置不算「理她」
      mood.flash('surprised', '欸欸欸——！', 2600);
    } else if (kind === 'pet-hold') {
      // 手按在她头上不动。身体那边已经在演了，这儿只动一点数值、不说话
      mood.onPetHold();
    } else if (kind === 'pet-long') {
      // 摸太久了，她躲开并且抗议一句
      mood.onPetLong();
    }
  });

  ipcMain.on('greet:accept', (_e, offer) => acceptOffer(offer));

  // --- 一起玩 ---
  // 全程不调 claude，所以这几个入口一分钱都不花
  ipcMain.on('play:start', (_e, game) => {
    if (!play) return;
    const r = play.start(game);
    if (!r.ok && r.error) send('session:say', { name: '', text: r.error });
  });

  // 气泡上那几个选项按钮点了哪个
  ipcMain.on('play:choose', (_e, id) => { if (play) play.choose(id); });
  ipcMain.on('play:stop', () => { if (play) play.stop(); });

  ipcMain.on('greet:decline', () => {
    if (mood) mood.onInteract('talk');
    log('[greet] 你说算了');
  });

  ipcMain.on('pet:context-menu', () => {
    // 歌单每次弹菜单时现读 —— 你往 music 文件夹里丢首新歌，右键就能看见
    const songs = performer ? performer.list() : [];
    const songItems = songs.slice(0, 12).map((s) => ({
      label: s.title + (s.artist ? ' — ' + s.artist : '') +
             (s.bpm ? '  (' + s.bpm + ')' : '') +
             (s.tooBig ? '  — 太大了放不了' : ''),
      enabled: !s.tooBig,
      click: () => singSong(s.file),
    }));

    // 这个模型有没有备用造型（藏几个部件就能换一身），有才显示这一项。
    // 每个模型的造型名都不一样（Hiyori 是 normal/down，Mao 是 witch/casual…），
    // 所以存档里那个值对不上号时，退回该模型的第一项，别让菜单一个都不打勾。
    const styles = profileFor(currentModelPath()).hairStyles;
    if (styles && !styles[currentHair]) currentHair = Object.keys(styles)[0];
    const hairItem = styles
      ? [{
          label: '换身打扮',
          submenu: Object.entries(styles).map(([key, s]) => ({
            label: s.label || key,
            type: 'radio',
            checked: key === currentHair,
            click: () => {
              currentHair = key;
              send('pet:hair', { name: key });
              // 记住选的这个，重启回来还是这个造型
              try { config.patch({ look: { hair: key } }); } catch (_) { /* 存不上就只这次有效 */ }
            },
          })),
        }]
      : [];

    // 换整套贴图：扫 models/<模型>/skins/ 底下的 png。
    // 这是三条换装路里走得最远的一条 —— 藏部件是脱一件、换配色是预置的几套色，
    // 换贴图是**真的重画了布料**。生成用 `npm run probe-uv -- --pattern=…`
    let skins = [];
    try {
      const dir = path.join(__dirname, '..', path.dirname(currentModelPath()), 'skins');
      // 一个 png = 只换第 0 张；一个**目录** = 整套换（换皮模型走这条，见 atlasUrls）
      skins = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || /\.png$/i.test(e.name))
        .map((e) => ({ label: e.name.replace(/\.png$/i, ''), file: path.join(dir, e.name) }));
    } catch (_) { /* 没有这个目录很正常 */ }

    const mp = currentModelPath();
    const picked = savedAtlasFor(mp);
    const skinItem = skins.length
      ? [{
          label: '换套贴图',
          submenu: [{ label: '原样', type: 'radio', checked: !picked,
                      click: () => saveAtlas(mp, '') },
            ...skins.map((s2) => ({
              label: s2.label,
              type: 'radio',
              checked: picked === s2.file,
              click: () => saveAtlas(mp, s2.file),
            }))],
        }]
      : [];

    // 她手上还开着的活。后台派的活现在是**最小化的真终端**，
    // 所以「看看她在干嘛」是能真的调出现场的 —— 这一项也是无头模式给不了的东西
    const live = terminals ? terminals.list().filter((t) => t.status !== 'done') : [];
    const workItem = live.length
      ? [
        {
          label: live.length === 1
            ? '看看她在干嘛（' + live[0].name + '）'
            : '看看她在干嘛（' + live.length + ' 个）',
          submenu: live.length === 1 ? undefined : live.map((t) => ({
            label: t.name + ' —— ' + (TERM_STATUS_WORD[t.status] || ''),
            click: () => focusTerminal(t.id),
          })),
          click: live.length === 1 ? () => focusTerminal(live[0].id) : undefined,
        },
        { type: 'separator' },
      ]
      : [];

    const menu = Menu.buildFromTemplate([
      ...workItem,
      { label: '派个活…', click: () => createPanel() },
      { label: '跟她聊聊…', click: () => createChatWindow() },
      { label: '设置…', click: () => createSettingsWindow() },
      { type: 'separator' },
      ...hairItem,
      ...skinItem,
      {
        label: play && play.busy ? '不玩了' : '一起玩点什么',
        submenu: play && play.busy
          ? [{ label: '结束这局', click: () => play.stop() }]
          : (play ? play.menu().map((g) => ({
              label: g.label,
              click: () => {
                const r = play.start(g.id);
                if (!r.ok && r.error) send('session:say', { name: '', text: r.error });
              },
            })) : []),
      },
      { label: '跳个舞', click: () => startDance() },
      {
        label: '唱首歌',
        submenu: songs.length
          ? [
              { label: '随便来一首', click: () => singSong() },
              { type: 'separator' },
              ...songItems,
              ...(songs.length > 12 ? [{ label: '…还有 ' + (songs.length - 12) + ' 首', enabled: false }] : []),
              { type: 'separator' },
              { label: '打开音乐文件夹', click: () => shell.openPath(MUSIC_DIR) },
            ]
          : [
              { label: 'music 文件夹里还没有歌', enabled: false },
              { label: '打开音乐文件夹，放几首进去', click: () => shell.openPath(MUSIC_DIR) },
            ],
      },
      { label: '停下来', click: () => stopPerform() },
      { type: 'separator' },
      { label: '隐藏', click: () => petWin && petWin.hide() },
      { label: '开发者工具', click: () => petWin && petWin.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    menu.popup({ window: petWin });
  });

  ipcMain.handle('pet:get-config', () => {
    const modelPath = currentModelPath();
    const cfg = loadConfig();
    return {
      modelPath,
      profile: profileFor(modelPath),
      root: ROOT,
      // 这两块以前漏在这儿没给出去，于是 config.json 里存着的眼神预设和色调
      // **每次开机都不生效** —— 你在设置面板里调好保存了，重启回来又是原样，
      // 而且一句报错都没有（stage.js 那边读到的是 undefined，
      // 转手 look.apply({}) 传了个空对象）。gesture 那块更彻底：全项目没人读过。
      look: cfg.look || {},
      gesture: cfg.gesture || {},
      // 上次选的那套贴图，已经摊平成 url。**别让渲染层自己去 look.atlas 里翻** ——
      // 那是一张按模型分的表，渲染层读不了目录，也认不了 `D:\` 开头的路径
      atlas: atlasUrls(savedAtlasFor(modelPath)),
    };
  });

  // --- 派活面板 ---

  ipcMain.on('panel:open', () => createPanel());
  ipcMain.on('panel:close', () => panelWin && !panelWin.isDestroyed() && panelWin.close());

  // 收起来 ≠ 关掉：目录、刚敲了一半的活、下面那两栏的滚动位置全留着。
  // 先给任务栏按钮再缩，顺序反了就等于把窗口丢进虚空。
  ipcMain.on('panel:minimize', () => {
    if (!panelWin || panelWin.isDestroyed()) return;
    panelWin.setSkipTaskbar(false);
    panelWin.minimize();
  });

  ipcMain.handle('panel:pick-folder', async () => {
    const res = await dialog.showOpenDialog(panelWin || petWin, {
      title: '选一个项目目录',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  /**
   * 「让她后台干」。
   *
   * 现在默认开的是一个**真终端，只是最小化的**，而不是无头进程。
   * 换掉的理由只有一条，但很硬：**无头模式跑挂了你看不到现场**。
   * 它只能从 stream-json 里捞一句摘要，栈、上下文、她当时试了什么、
   * 卡在哪个确认上 —— 全都没了，你连查都没得查。
   *
   * 最小化的终端两头都占：不往你脸上弹，但滚屏全在，
   * 右键「看看她在干嘛」或者点面板里那条就调出来了。
   *
   * 老的无头模式没删，config.json 里 `"dispatch": { "mode": "headless" }` 换回去。
   */
  // 「帮我装」：起了就返回，装没装好她开口告诉你（面板关了也听得见）
  ipcMain.handle('agent:install', (_e, agent) => installAgent(String(agent || '')));

  ipcMain.handle('session:dispatch', (_e, opts) => {
    const cfg = loadConfig().dispatch || {};
    // 面板传了 agent 就用它；没这个字段的老入口用记住的默认（记住这件事在面板侧做）
    const agent = resolveDispatchAgent('agent' in (opts || {}) ? opts.agent : cfg.agent);
    const noCli = guardAgent(agent);
    if (noCli) return noCli;

    // codex 的线不带模型（它不认 claude 的模型名），也**不动**记住的那个 ——
    // 你切回 claude 时上次选的模型还在
    const model = agent === 'codex' ? undefined
      : ('model' in (opts || {}) ? resolveDispatchModel(opts.model)
                                 : resolveDispatchModel(cfg.model));
    try {
      // 老的无头模式是 claude 专属（sessions.dispatch 拼的是 claude 参数）。
      // codex 一律走终端路 —— 反正也是最小化的，行为几乎没差
      if (cfg.mode === 'headless' && agent !== 'codex') {
        // opts 在后面，所以面板上临时选的那个会盖掉配置里的默认值
        const r = sessions.dispatch({ permissionMode: cfg.permissionMode, ...opts, model });
        return { ok: true, ...r };
      }

      // 会话身份归 sessions 管（主线 / 分线 / 回到老线都在那边算），
      // 窗口和监督归 terminals 管 —— 跟 session:open-terminal 走的是同一套，
      // 唯一的差别就是 minimized
      const r = openLaneTerminal({ ...opts, model, agent }, { minimized: true });
      return { ok: true, ...r, terminal: true };
    } catch (err) {
      log('[session] 派活失败: ' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:open-terminal', (_e, opts) => {
    const dcfg = loadConfig().dispatch || {};
    const agent = resolveDispatchAgent('agent' in (opts || {}) ? opts.agent : dcfg.agent);
    const noCli = guardAgent(agent);
    if (noCli) return noCli;

    const model = agent === 'codex' ? undefined
      : ('model' in (opts || {}) ? resolveDispatchModel(opts.model)
                                 : resolveDispatchModel(dcfg.model));
    try {
      // 会话身份归 sessions 管（主线 / 分线 / 回到老线都在那边算），
      // 窗口和监督归 terminals 管
      panelYield(); // 你点了「开终端我看着」，那个窗口就该出现在最上面
      const r = openLaneTerminal({ ...opts, model, agent }, { minimized: false });
      mood.onInteract('talk');
      return { ok: true, ...r };
    } catch (err) {
      log('[session] 开终端失败: ' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:list', () => sessions.list());
  ipcMain.handle('session:projects', () => sessions.knownProjects());
  ipcMain.handle('session:stop', (_e, key) => sessions.stop(key));
  ipcMain.handle('mood:get', () => (mood ? mood.snapshot() : null));

  // 流水账。**这两条是 invoke（问一句答一句），不是推送** ——
  // 所以不进 preload 那个 allowed 白名单，那个名单只管 on() 那条广播路。
  ipcMain.handle('journal:today', () => ({
    today: journal.today(),
    month: journal.month(),
    // 「认识多少天」从心情那边来（它兜了老存档、也兜了文件夹被拷走的情况）
    days: mood ? mood.snapshot().days : 0,
  }));
  ipcMain.handle('journal:totals', () => journal.totals());

  // --- 开着的终端 ---

  ipcMain.handle('term:list', () => (terminals ? terminals.list() : []));

  ipcMain.handle('term:focus', async (_e, id) => {
    if (!terminals) return { ok: false, error: '终端管理还没起来' };
    try {
      panelYield(); // 你在面板上点的这一下，就是要看终端 —— 面板让开
      return await terminals.focus(id);
    } catch (err) {
      log('[term] 置顶失败: ' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('term:forget', (_e, id) => {
    if (!terminals) return { ok: false };
    terminals.forget(id);
    return { ok: true };
  });

  // 面板上「她动过的文件」那一排，点一下在资源管理器里定位到它。
  // 只认还在盘上的路径 —— 她可能刚把那个文件删了，或者是临时文件
  ipcMain.handle('term:reveal', (_e, file) => {
    try {
      const p = path.resolve(String(file || ''));
      if (!fs.existsSync(p)) return { ok: false, error: '这个文件已经不在了' };
      shell.showItemInFolder(p);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * 这个目录现在什么状态 —— 哪个分支、有几个文件没提交。
   *
   * 派活之前你第一件想知道的就是这个：**别在错的分支上让她开工**，
   * 也别在一堆没提交的改动上再叠一层。
   *
   * 不是 git 仓库就安静地什么都不返回（`--porcelain` 那次会非零退出）。
   * 全程本地命令，不花钱。
   */
  ipcMain.handle('project:status', async (_e, dir) => {
    const d = String(dir || '').trim();
    if (!d || !fs.existsSync(d)) return null;
    const git = (args) => new Promise((resolve) => {
      execFile('git', args, { cwd: d, timeout: 3000, windowsHide: true },
        (err, out) => resolve(err ? null : String(out || '')));
    });
    try {
      const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (branch === null) return null; // 不是 git 仓库
      const status = await git(['status', '--porcelain']);
      const dirty = String(status || '').split('\n').filter((l) => l.trim()).length;
      return { branch: branch.trim(), dirty };
    } catch (_) {
      return null;
    }
  });

  // --- 设置 ---

  ipcMain.on('settings:open', () => createSettingsWindow());
  ipcMain.on('settings:close', () => settingsWin && !settingsWin.isDestroyed() && settingsWin.close());

  ipcMain.handle('settings:get', () => ({
    config: loadConfig(),
    meta: {
      models: scanModels(),
      voices: VOICES,
      permissionModes: PERMISSION_MODES,
      terminalApps: TERMINAL_APPS,
      // 色调和眼神预设的定义在渲染层（look.js），这儿只报个名字和标签
      tints: [
        { id: 'none', label: '原色' },
        { id: 'warm', label: '暖调' },
        { id: 'cool', label: '冷调' },
        { id: 'night', label: '夜间' },
        { id: 'vivid', label: '鲜艳' },
        { id: 'faded', label: '淡雅' },
      ],
      presets: [
        { id: 'default', label: '原样' },
        { id: 'gentle', label: '温柔' },
        { id: 'bright', label: '精神' },
        { id: 'sleepyEyes', label: '慵懒' },
        { id: 'tsundere', label: '傲娇' },
        { id: 'cool', label: '清冷' },
      ],
    },
  }));

  // 调外观时实时预览，不写盘 —— 拖滑块看不到效果就没法调
  ipcMain.on('settings:preview-look', (_e, lookCfg) => send('look:apply', lookCfg || {}));

  ipcMain.handle('settings:try-voice', async (_e, voiceCfg) => {
    if (!voice) return { ok: false, error: '语音还没起来' };
    try {
      // 拿面板上当前的滑块值临时合成一句，不动已保存的配置
      const probe = new Voice({ ...(loadConfig().voice || {}), ...(voiceCfg || {}), enabled: true });
      probe.onLog = log;
      const r = await probe.speak('你好呀，我是' + ((loadConfig().persona || {}).name || '小依') + '，这样说话行吗？',
                                  { important: true, maxLen: 60 });
      probe.dispose();
      if (!r) return { ok: false, error: '没合成出来' };
      send('voice:play', r);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:save', (_e, next) => {
    if (!next || typeof next !== 'object') return { ok: false, error: '没收到配置' };
    try {
      const before = loadConfig();
      const after = config.patch(next);

      // 语音的改动当场生效，不用重启
      if (voice) {
        Object.assign(voice.cfg, after.voice || {});
        // 音色变了得把连接扔掉重建 —— 那条 WebSocket 是绑着音色开的
        if ((before.voice || {}).voiceName !== (after.voice || {}).voiceName) {
          voice._drop('换了音色');
        }
      }

      // 换角色：重新加载渲染层就行，整个应用不用重启
      if (before.modelPath !== after.modelPath) {
        log('[settings] 换角色: ' + before.modelPath + ' → ' + after.modelPath);
        if (petWin && !petWin.isDestroyed()) petWin.reload();
      } else {
        // 没换人的话，把外观推过去落定（预览时已经在看了，这一步是为了保险）
        send('look:apply', after.look || {});
      }

      log('[settings] 存好了');
      return { ok: true };
    } catch (err) {
      log('[settings] 存不上: ' + err.message);
      return { ok: false, error: err.message };
    }
  });

  // --- 私聊 ---

  ipcMain.on('chat:open', () => createChatWindow());
  ipcMain.on('chat:close', () => chatWin && !chatWin.isDestroyed() && chatWin.close());

  /**
   * 点了桌面上那个气泡：把她刚说的话带过去，开私聊接着聊。
   *
   * seed 要在 createChatWindow 之前调。聊天窗口是一 ready 就去拉 chat:history 的，
   * 顺序反了的话，那句话还没进 msgs，窗口开出来是空的 ——
   * 而它恰恰是你点进来的理由。
   */
  ipcMain.on('chat:open-with', (_e, text) => {
    if (chat && text) {
      chat.seed(text);
      log('[chat] 从气泡跳进来: ' + String(text).slice(0, 40));
    }
    createChatWindow();
  });

  ipcMain.handle('chat:send', async (_e, text) => {
    if (!chat) return { ok: false, error: '聊天还没准备好' };
    // 陪聊跟着「用谁来干」走：选了 codex 就查 codex，别拿 claude 的标准拦人
    const noCli = guardAgent((loadConfig().dispatch || {}).agent === 'codex' ? 'codex' : 'claude');
    if (noCli) return noCli;
    try {
      return await chat.send(text);
    } catch (err) {
      log('[chat] 出错: ' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('chat:history', () => (chat ? chat.history() : []));

  ipcMain.handle('chat:reset', () => {
    if (!chat) return { ok: false };
    chat.reset();
    log('[chat] 重开了一段对话');
    return { ok: true };
  });

  // --- 唱跳 ---

  ipcMain.handle('perform:songs', () => (performer ? performer.list() : []));
  ipcMain.handle('perform:dance', (_e, bpm) => startDance(bpm));
  ipcMain.handle('perform:sing', (_e, file) => singSong(file));
  ipcMain.on('perform:stop', () => stopPerform());
  ipcMain.on('perform:open-music', () => shell.openPath(MUSIC_DIR));

  // 打开这个项目的小抄给你看/改。文件还不存在就先把默认头部落出来 ——
  // 不然点一下打开的是个不存在的文件。
  // 一份你看不见也改不了的「她的记忆」是危险的：错了就一直错下去
  ipcMain.handle('notes:open', (_e, dir) => {
    if (!dir) return false;
    const f = notes.notesFile(dir);
    if (!fs.existsSync(f)) notes.append(dir, null);
    return shell.openPath(f);
  });
  ipcMain.on('perform:bpm', (_e, p) => {
    if (performer && p) performer.rememberBpm(p.file, p.bpm);
  });

  ipcMain.handle('persona:get', () => loadConfig().persona);

  ipcMain.handle('persona:save', (_e, p) => {
    if (!p || !p.text || !String(p.text).trim()) {
      return { ok: false, error: '性格设定别留空' };
    }
    try {
      const persona = {
        name: String(p.name || '').trim() || '小依',
        text: String(p.text).trim(),
      };
      config.patch({ persona });
      if (chat) chat.setPersona(persona);
      log('[chat] 人设改了: ' + persona.name);
      // claude：已经聊起来的那段不会中途变性子（system prompt 开场定死），得等下一段。
      // codex：人设是每轮垫在开场白里的，下一句就生效 —— 别谎报要等重开
      return {
        ok: true,
        willApplyNext: Boolean(chat && chat.hasHistory()) &&
                       (loadConfig().dispatch || {}).agent !== 'codex',
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('app:info', () => ({
    claudeBin: resolveClaudeBin(),
    root: ROOT,
    dataRoot: DATA_ROOT,
  }));
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function createTray() {
  let img = nativeImage.createEmpty();
  try {
    if (fs.existsSync(TRAY_ICON)) {
      const loaded = nativeImage.createFromPath(TRAY_ICON);
      if (!loaded.isEmpty()) img = loaded;
    }
  } catch (err) {
    log('[main] 托盘图标读不了: ' + err.message);
  }
  if (img.isEmpty()) {
    log('[main] 没有托盘图标（托盘里会是个空白占位），跑一下 npm run make-icon');
  }

  tray = new Tray(img);
  tray.setToolTip('WaifuCode — ' + ((loadConfig().persona || {}).name || '桌宠'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '派个活…', click: () => createPanel() },
    { label: '跟她聊聊…', click: () => createChatWindow() },
    { label: '设置…', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: '跳个舞', click: () => startDance() },
    { label: '唱首歌（随便挑）', click: () => singSong() },
    { label: '停下来', click: () => stopPerform() },
    { label: '打开音乐文件夹', click: () => shell.openPath(MUSIC_DIR) },
    { type: 'separator' },
    {
      label: '显示 / 隐藏',
      click: () => {
        if (!petWin) return;
        petWin.isVisible() ? petWin.hide() : petWin.show();
      },
    },
    {
      label: '让她出声',
      type: 'checkbox',
      checked: !!(loadConfig().voice || {}).enabled,
      click: (item) => {
        if (voice) voice.setEnabled(item.checked);
        // 写回配置，下次启动还记得
        const cfg = loadConfig();
        cfg.voice = Object.assign({}, cfg.voice, { enabled: item.checked });
        try {
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        } catch (err) {
          log('[main] 写 config.json 失败: ' + err.message);
        }
      },
    },
    { type: 'separator' },
    // 打开的是**数据目录**不是安装目录 —— 你要找的 config.json、waifu.log、
    // music 都在这儿。开发时这两个是同一个文件夹，装完之后就不是了
    { label: '打开数据目录', click: () => shell.openPath(DATA_ROOT) },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('double-click', () => createPanel());
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  // 已经有一只在跑了，别再冒出第二只来抢同一份 registry
  app.quit();
} else {
  app.on('second-instance', () => {
    if (petWin) { petWin.show(); petWin.focus(); }
  });

  /**
   * 一个全局快捷键，随手把派活面板叫出来。
   *
   * 派活是这个项目里最高频的动作，而在此之前唯一的入口是「找到她、双击她」——
   * 她被别的窗口盖住的时候，那一下要先最小化好几个窗口。
   *
   * 抢不到就安静地算了（别的软件占着是常事），只在日志里留一行。
   * 绝不为这个弹窗打扰你 —— 快捷键没了顶多是少条近路，功能一点没少。
   */
  function registerHotkey() {
    const key = (loadConfig().hotkey || {}).panel || 'CommandOrControl+Alt+W';
    if (!key) return;
    try {
      const ok = globalShortcut.register(key, () => {
        createPanel();
        if (panelWin && !panelWin.isDestroyed()) {
          if (panelWin.isMinimized()) panelWin.restore();
          panelWin.show();
          panelWin.focus();
        }
      });
      log(ok ? '[main] 全局快捷键 ' + key + ' 已挂上' : '[main] 全局快捷键 ' + key + ' 被别的软件占了，跳过');
    } catch (err) {
      log('[main] 全局快捷键挂不上: ' + err.message);
    }
  }

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(() => {
    fs.mkdirSync(STORE, { recursive: true });
    // 三个月前的流水清一次。启动时来这么一下就够，不用起定时器
    journal.sweep();
    mood = new Mood({ storeDir: STORE });
    sessions = new SessionManager({
      storeDir: STORE,
      getConfig: loadConfig,
      // 干活时她也带着当下的心情。跟私聊那条链注入的是同一个东西
      getMoodDesc: () => (mood ? mood.describe() : ''),
    });
    voice = new Voice(loadConfig().voice || {});
    voice.onLog = log;
    terminals = new TerminalManager({
      storeDir: STORE,
      log,
      claudeBin: resolveClaudeBin(),
      getConfig: loadConfig,
    });
    chat = new Chat({
      storeDir: STORE,
      log,
      claudeBin: resolveClaudeBin(),
      getConfig: loadConfig,
      // 把心情接进聊天：她烦躁的时候说出来的话就该不一样
      getMoodDesc: () => (mood ? mood.describe() : ''),
    });
    performer = new Performer({ log, storeDir: STORE });
    greeter = new Greeter({ log, claudeBin: resolveClaudeBin(), getConfig: loadConfig });

    play = new Play({
      log,
      songs: () => (performer ? performer.list() : []),
      loadSong: (file) => performer.load(file),
    });
    wirePlay();
    log('[main] claude 可执行文件: ' + resolveClaudeBin());
    log('[main] 模型: ' + currentModelPath());

    wireEvents();
    wireIpc();

    // hook 服务。装不装 hook 是另一回事（npm run install-hooks），
    // 但服务本身先起着 —— 没装 hook 时它只是空转，不花什么资源。
    startServer({
      runtimeFile: path.join(STORE, 'runtime.json'),
      log,
      onEvent: handleHookEvent,
      onTermEvent: (p) => terminals.onShellEvent(p),
      onListen: (port) => { hookPort = port; },
    });

    currentHair = (loadConfig().look || {}).hair || 'normal';

    createPetWindow();
    createTray();
    startCursorWatch();
    startPresenceWatch();
    registerHotkey();

    // 调试模式：--shot 启动后截图存盘再退出。
    // 透明窗口没法靠肉眼隔空判断渲染对不对，有张图就能直接看出
    // 模型是不是歪了、缩放是不是过头、有没有被裁掉。
    if (process.argv.includes('--shot')) {
      const shot = async (name) => {
        try {
          const img = await petWin.webContents.capturePage();
          fs.writeFileSync(path.join(DATA_ROOT, name), img.toPNG());
          log('[main] 截图 -> ' + name);
        } catch (e) {
          log('[main] 截图失败 ' + name + ': ' + e.message);
        }
      };

      // 依次把她推进几种情绪再拍照，这样能直接看出表情到底切没切、
      // 切得对不对 —— 光看一张默认脸是验证不了心情系统的。
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      setTimeout(async () => {
        await shot('shot-normal.png');

        mood.onInteract('pet');       // 摸头 -> 害羞（脸红）
        await wait(2200);
        await shot('shot-shy.png');

        mood.busy = true;
        mood.onTrouble(3);            // 连错三次 -> 烦躁（压眉撇嘴）
        await wait(2200);
        await shot('shot-frustrated.png');

        mood.busy = false;
        mood.mood = 90;
        mood.onTaskDone({ ok: true, elapsedMs: 20000, errorCount: 0 }); // -> 得意
        await wait(2200);
        await shot('shot-proud.png');

        app.quit();
      }, 6000);
    }
  });

  // 桌宠关掉窗口不该退出进程（托盘还在）
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    if (sessions) sessions.stopAll();
    if (terminals) terminals.dispose();
    if (chat) chat.dispose();
    if (mood) mood.dispose();
    if (voice) voice.dispose();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
  });
}
