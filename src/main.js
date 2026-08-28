'use strict';

const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, dialog, shell,
  clipboard,
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
// 局域网版本更新：查新版/下载校验/当分发点，协议和边界见模块头注释
const updates = require('./updates');
// 算钱那套。**必须在这儿 require**：session:lanes 用它给没起名的线取名，
// 漏了的话一碰到没名字的线就 ReferenceError → 被 catch 吞掉 → 整排
// 「留着的线」静默消失（排查抓的，跟 registerHotkey 一个死法）
const cost = require('./cost');
// 「有来有回的一天」：回来汇报 / 隔天开场 / 收工 / 久坐，全是本地拼的、不花钱
const recap = require('./recap');
// 口头交代的提醒（「三点提醒我开会」）
const { remindStore } = require('./remind');
// 桌面感知：拖文件分类、久未提交状态机、全屏判定
const desk = require('./desk');
// 「关于你」的小本子 + 她写的周记
const { aboutStore } = require('./about');
const diary = require('./diary');
// 手机工作台：扫码进的手机页（派活 + SSE 实时进度 + 远程放行）
const mobile = require('./mobile');
// 出门模式：cloudflared 免费隧道，把手机工作台暴露成临时公网地址
const tunnel = require('./tunnel');
// 截图：框一块，图进剪贴板（自己 Ctrl+V 粘到哪儿是哪儿）
const shot = require('./shot');
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
  // 控制台回显**只给开发**。打包版的 Electron 会攀附启动它的那个控制台 ——
  // 从终端/脚本里把她拉起来，日志就整屏灌进人家窗口（实机把用户的
  // Claude Code 界面刷满过）。文件里全都有，打包版没理由再往外吐
  if (!app.isPackaged) console.log(...args);
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
let reminders = null;      // 口头提醒的小本子（「三点提醒我开会」）
let about = null;          // 「关于你」的小本子（她聊天时听到就记）
let play = null;
// 玩游戏 / 番茄钟期间她该闭嘴：情绪台词、主动搭话、提议唱跳全压住。
// 一边让你专注一边在旁边碎碎念，那这个功能就是反效果。
let quiet = false;
let fsQuiet = false;       // 前台在全屏（开会/游戏/看片），她自动闭嘴
// 「现在该不该闭嘴」只从这一个口问。quiet 是玩法要的安静（专注模式、游戏中），
// fsQuiet 是全屏勿扰 —— 分开存是因为退出机制完全不同：一个由 play 收，
// 一个由探针收，合在一个变量里会互相踩
function hushed() { return quiet || fsQuiet; }
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
// 拖动时要往 setBounds 里回填的「本意尺寸」。**绝不能现读现写**：显示缩放
// 不是 100% 的机器上，getSize/setPosition 每来回一趟就被四舍五入撑大 1 像素，
// 拖一路她就肉眼可见地长个儿（发出去的机器上实测撞过）。写死一个常量进去，
// 同一个逻辑尺寸每次换算结果一样，就长不了
let petWinSize = { w: PET_W, h: PET_H };

// 「她的大小」（look.scale，设置页的滑杆）。她是适配窗口渲染的，所以放大 =
// 把窗口按比例放大 —— 头肩比、点击判定、气泡占位全是按比例算的，渲染层
// 一行不用改。**尺寸只有 petWinSize 一个源头**：缩放改它一次，拖动永远写
// 它的常量值，「拖着拖着变大」那个坑不会因为加了缩放又回来
function petScaleOf(cfg) {
  const s = Number(((cfg || {}).look || {}).scale);
  return s >= 0.5 && s <= 2 ? s : 1;
}

function petBaseH() {
  try {
    const { height } = screen.getPrimaryDisplay().workAreaSize;
    return Math.min(PET_H, Math.max(360, height - 48));
  } catch (_) { return PET_H; }
}

function applyPetScale(s) {
  if (!petWin || petWin.isDestroyed()) return;
  const w = Math.round(PET_W * s);
  const h = Math.round(petBaseH() * s);
  if (w === petWinSize.w && h === petWinSize.h) return;
  // 脚底站住不动：往上、往两边长 —— 一放大就往下坠出屏幕的话没法调
  const [x, y] = petWin.getPosition();
  const nx = Math.round(x + (petWinSize.w - w) / 2);
  const ny = y + (petWinSize.h - h);
  petWinSize = { w, h };
  petWin.setBounds({ x: nx, y: ny, width: w, height: h });
}

// ---------------------------------------------------------------------------
// 角色窗口
// ---------------------------------------------------------------------------
function createPetWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const s = petScaleOf(loadConfig());
  // 屏幕矮的时候（小笔记本、缩放拉满）别让窗口顶出可视区
  const h = Math.round(Math.min(PET_H, Math.max(360, height - 48)) * s);
  const w = Math.round(PET_W * s);
  petWinSize = { w, h };

  petWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.max(0, width - w - 24),
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
  settingsWin.on('closed', () => {
    settingsWin = null;
    // 预览是真作用在她身上的（拖大小、换色调当场就变）。点「取消」或直接
    // 关窗口时不还原的话：屏幕上是新样子、存档里是旧值，下次打开设置
    // 滑块跟她对不上，你会以为设置面板读错了（排查抓的）
    try {
      const cfg = loadConfig();
      send('look:apply', cfg.look || {});
      applyPetScale(petScaleOf(cfg));
    } catch (_) { /* 还原不了就等下次重启 */ }
  });
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
    if (mood) mood.quiet = quiet || fsQuiet;
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
let sitSince = Date.now(); // 上次「真正休息」是什么时候（离开 ≥5 分钟才算休息）
const SIT_MIN = 90;        // 连坐多久开始念叨

// 一天只该来一次的事（隔天开场白、收工那句）记在这儿，重启不重来
const MARKS_FILE = path.join(STORE, 'daymarks.json');
function dayMarks() {
  try { return JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}
function markDay(key) {
  const m = dayMarks();
  m[key] = journal.dayKey();
  try { fs.writeFileSync(MARKS_FILE, JSON.stringify(m), 'utf8'); } catch (_) { /* 丢了就今天多说一次 */ }
}

/** 你走的这段时间的流水（可能跨了早上 5 点那条日界线，两天都要读） */
function recordsSince(ts) {
  const days = new Set([journal.dayKey(ts), journal.dayKey()]);
  return [...days].flatMap((d) => journal.read(d));
}

/**
 * 「昨天挂着一半的那条线」。从 sessions 登记簿挑：最近动过、今天还没碰、
 * 会话还在盘上的。挑不出来就没有开场白 —— 不硬找话说。
 */
function leftoverLane() {
  try {
    const today = journal.dayKey();
    let best = null;
    // knownProjects 给的才是真目录 —— recentProjects 返回的是
    // 「WaifuCode（昨天弄的）」这种显示串，拿去查线永远查不到（差点栽这儿）
    for (const p of sessions.knownProjects()) {
      if (!p.path || !fs.existsSync(p.path)) continue;
      for (const l of sessions.lanes(p.path)) {
        if (!l.alive) continue;
        const ts = Date.parse(l.lastRun) || 0;
        if (!ts) continue;
        if (journal.dayKey(ts) >= today) continue;          // 今天碰过的不算「挂着」
        if (Date.now() - ts > 4 * 86400000) continue;       // 放了四天以上的，多半是不想弄了
        if (!best || ts > best.ts) {
          best = { ts, dir: p.path, laneId: l.id, name: l.name || '', turns: l.turns || 0,
                   project: p.name || path.basename(p.path) };
        }
      }
    }
    return best;
  } catch (err) {
    log('[recap] 找不着昨天的线: ' + err.message);
    return null;
  }
}

/** 隔天第一次见面：昨天那条线还挂着的话，问一句要不要接着弄。一天一次 */
function tryOpener() {
  if (hushed() || (play && play.busy)) return false;
  if (dayMarks().opener === journal.dayKey()) return false;
  const lane = leftoverLane();
  const r = recap.opener(lane);
  if (!r) return false;
  markDay('opener');
  r.offer.dir = lane.dir;
  r.offer.laneId = lane.laneId;
  r.offer.laneName = lane.name;
  send('greet:say', { say: r.say, face: r.face, offer: r.offer, hold: 25000 });
  speakLine(r.say, { maxLen: 60 });
  log('[recap] 隔天开场白：' + (lane.name || lane.project));
  return true;
}

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
      const wentAt = awaySince;
      const goneMin = (Date.now() - awaySince) / 60000;
      awaySince = 0;
      if (goneMin >= 5) sitSince = Date.now(); // 离开够久才算休息过
      if (goneMin >= WELCOME_MIN) {
        log('[presence] 你走开了 ' + Math.round(goneMin) + ' 分钟，她抬头看你一眼');
        send('pet:welcome', { goneMin }); // 动作（本地算的，不花钱）
        // 开口说什么，按料多少挑：跨天了先问昨天挂着的线；你不在时有动静就汇报；
        // 都没有才是普通那句「你回来啦」。台词全是本地拼的，不花钱
        if (tryOpener()) {
          mood.onReturn(goneMin, { silent: true });
        } else {
          const rep = hushed() ? null : recap.welcome(recordsSince(wentAt), wentAt, goneMin);
          if (rep) {
            mood.onReturn(goneMin, { silent: true });
            send('greet:say', { say: rep.say, face: rep.face, hold: 12000 });
            speakLine(rep.say, { maxLen: 80 });
            log('[recap] 回来汇报：' + rep.say.slice(0, 60));
          } else {
            mood.onReturn(goneMin);      // 台词和表情（本地台词库，不花钱）
          }
        }
      }
    }
    mood.onSeen();

    // 久坐提醒：上次休息到现在超过 SIT_MIN 分钟就念叨一句，然后重新计时。
    // 安静模式（专注/游戏中）不吵 —— 但计时不清零，退出安静模式该催还是催
    if (!hushed() && !(play && play.busy) && Date.now() - sitSince >= SIT_MIN * 60000) {
      sitSince = Date.now();
      const line = recap.SIT_LINES[Math.floor(Math.random() * recap.SIT_LINES.length)];
      send('greet:say', { say: line, face: 'tired', hold: 9000 });
      speakLine(line, { maxLen: 60 });
      log('[presence] 久坐 ' + SIT_MIN + ' 分钟，催了一句');
    }
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
    send('mood:change', hushed() ? { ...e, line: null } : e);
    // 只念她自己的情绪台词。干活时的输出又长又密，全念出来会很吵。
    if (e.line && !hushed()) speakLine(e.line);
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
    // 顺手记小抄：后台线断档（会话丢了换新 id）时记忆全押在 --resume 上，
    // 小抄正是为断档设计的兜底 —— 这条链原来没接。干砸的不记，别攒垃圾
    if (e.ok && e.dir && e.summary && e.summary !== '（没有输出）') {
      try { notes.append(e.dir, { task: e.task, text: String(e.summary).slice(0, 200) }); }
      catch (_) { /* 小抄记不上不拦收工 */ }
    }
    send('session:done', e);
  });

  sessions.on('log', (m) => log('[session] ' + m));

  // --- 开出去的终端：她在旁边盯着 ---------------------------------------

  terminals.on('change', () => {
    // 她盯着几条活线，喂给心情系统 —— 盯梢费一点神（远小于自己干活），
    // 一条都没有时她才真正在歇着（精力回血的判据，跟你的键鼠无关）。
    // 用 liveCount 不用 list()：change 事件每次工具调用都来一发，
    // list() 每次都顺手刷全量算钱，这儿只要个数（评审抓的）
    try { if (mood) mood.watching = terminals.liveCount(); } catch (_) { /* 喂不上下拍再说 */ }
    send('term:change', { count: terminals.liveCount() });
    refreshTrayTip();
    if (mobileSrv) mobileSrv.pushState(); // 手机那头的长连接跟着动
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
      // termId：手机详情页要按线把「这条线之前汇报过什么」捞回来。
      // 内存里的时间线是这轮开的窗口才有，重启/老窗口一条都没有
      termId: e.id,
      project: e.project, lane: e.laneName,
      tools: e.toolCount, errors: e.errorCount, files: e.files,
      brief: briefly(e.text, 160), // 60 字看不出「做到哪了」，手机详情页要靠它
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
    // 这是最该一点就跳过去的场合，所以气泡上带终端 id。
    // detail 只进气泡不进语音 —— 命令行原文念出来没法听
    send('session:say', { name: e.name, text: e.text + (e.detail ? ' ' + e.detail : ''), termId: e.id });
    speakLine(e.text, { important: true });
  });
}

// 托盘 tooltip：悬停就知道她手上有几条线、有没有在等你。
// change 事件每次工具调用都来一发，10 秒节流 —— tooltip 不值得每秒重算
let trayTipAt = 0;
let trayTipPending = null;
// ─── 截图 ────────────────────────────────────────────────────────────────────
/**
 * 盖一层透明浮罩让你框一块。**一块屏一层**，不是拿并集开一个大的。
 *
 * 【为什么不能开一个大的】开过，双屏上只能截当前那块屏。量出来的：
 * 要 3840x1080，Windows 给的是 1920x1032 —— 它把窗口裁到了**一块屏的
 * 工作区**（1032 = 1080 减掉任务栏那条）。第二块屏根本没被盖住，
 * 自然也就框不到。所以改成一块屏开一层。
 *
 * 【show 完必须再 setBounds 掰一次】同一个裁剪：建窗口时给的尺寸会被
 * 按工作区削掉，掰回去才能盖住任务栏那一条（不然屏幕最底下那行永远截不到）。
 *
 * 【坐标这件事必须说清楚】浮罩里给的是**窗口内**的 CSS 像素，得先加上
 * 这层浮罩自己的原点才是桌面坐标；而截图那头 CopyFromScreen 要的是物理
 * 像素 —— 缩放 125% 的机器上直接拿 DIP 去截，框会小一圈还偏位。
 * 所以是两步：加原点 → dipToScreenRect。
 */
function openShot() {
  if (shotWins.length) { for (const w of shotWins) if (!w.isDestroyed()) w.focus(); return; }
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
      resizable: false, movable: false, hasShadow: false, fullscreenable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.loadFile(path.join(__dirname, 'renderer', 'shot.html'));
    w.on('closed', () => { shotWins = shotWins.filter((x) => x !== w); });
    w.once('ready-to-show', () => {
      w.show();
      w.setBounds(d.bounds);   // 见上：不掰这一下就盖不住任务栏那条
      w.focus();
    });
    shotWins.push(w);
  }
}

/** 把框掐进「所有屏的并集」里。按住不放划出屏幕是常事 */
function clampToDesktop(r) {
  const all = screen.getAllDisplays();
  const x0 = Math.min(...all.map((d) => d.bounds.x));
  const y0 = Math.min(...all.map((d) => d.bounds.y));
  const x1 = Math.max(...all.map((d) => d.bounds.x + d.bounds.width));
  const y1 = Math.max(...all.map((d) => d.bounds.y + d.bounds.height));
  const left = Math.max(x0, Math.min(r.x, x1));
  const top = Math.max(y0, Math.min(r.y, y1));
  const right = Math.min(x1, Math.max(r.x + r.width, x0));
  const bottom = Math.min(y1, Math.max(r.y + r.height, y0));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 收摊：所有屏上的浮罩一起撤（在哪块屏上框完的都一样） */
function closeShot() {
  const list = shotWins.slice();
  shotWins = [];
  for (const w of list) { if (!w.isDestroyed()) w.destroy(); }
}

async function doShot(rect, from) {
  // **原点要在关窗口之前拿**：关了就问不出它在哪块屏上了。
  // 浮罩给的 rect 是「窗口内」的坐标，加上原点才是桌面上的位置 ——
  // 第二块屏的浮罩原点是 (1920,0)，不加就等于全按主屏算，截的是主屏那块
  const org = (from && !from.isDestroyed()) ? from.getBounds() : { x: 0, y: 0 };
  // **先把浮罩关干净再拍**：不关的话拍到的是自己那层灰罩。
  // closed 之后再等 120ms —— 窗口没了不等于屏幕已经重画完
  closeShot();
  await new Promise((r) => setTimeout(r, 120));

  const dir = path.join(DATA_ROOT, 'shots');
  try {
    // 桌面坐标（DIP）
    let abs = {
      x: org.x + Math.round(rect.x), y: org.y + Math.round(rect.y),
      width: Math.round(rect.w), height: Math.round(rect.h),
    };
    // 拖过头了就掐回桌面范围内 —— 按住不放划出屏幕是常事，
    // 划出去的坐标喂给 CopyFromScreen 会截出一块黑的
    abs = clampToDesktop(abs);
    if (abs.width < 8 || abs.height < 8) {
      send('session:say', { name: '', text: '这框太小了，没截。' });
      return { ok: false, error: '框太小' };
    }
    // DIP → 物理像素（缩放不是 100% 的机器上不换算就截歪）
    const phys = screen.dipToScreenRect(null, abs);
    const file = await shot.grab({
      x: phys.x, y: phys.y, w: phys.width, h: phys.height, dir, log,
    });
    shot.sweep(dir);

    // 【只放剪贴板，不替用户发。】原来是截完直接 sendText 打进「最近那条活线」——
    // 用户明说了不要：图得是**可粘贴**的，粘进哪个框、配什么话、什么时候发，
    // 是他自己的事（同一张图也可能是要贴给别的窗口的）。而且「最近那条」
    // 本来就是猜的，猜错就是把图发错了人。
    // 【文字和图一起放，主力是文字。】只放位图行不通 —— 实机试过粘不进去：
    // 终端的 Ctrl+V 走的是「粘贴**文字**」那条路（Windows Terminal 自己
    // 就把这个键占了），剪贴板里只有位图时它拿到的是空的，按下去毫无反应。
    // 所以放的是**图片路径**：任何终端都粘得进，发出去她自己会去读这张图。
    // 位图同时也放着 —— 粘进聊天软件、文档里那边要的就是图。
    const img = nativeImage.createFromPath(file);
    // 用户名带空格的机器上（C: 反斜杠 Users 反斜杠 Li Ming 那种）不加引号会被拆成两截
    const paste = /\s/.test(file) ? '"' + file + '"' : file;
    try {
      if (img.isEmpty()) clipboard.writeText(paste);
      else clipboard.write({ text: paste, image: img });
    } catch (err) {
      log('[shot] 剪贴板写不进去: ' + err.message);
      send('session:say', { name: '', text: '图存下了但复制不了（剪贴板被别的软件占着）：' + path.basename(file) });
      return { ok: false, file, error: err.message };
    }
    send('session:say', { name: '', text: '截好了，Ctrl+V 粘进输入框，回车发给她。' });
    return { ok: true, file, copied: img.isEmpty() ? 'path' : 'both' };
  } catch (err) {
    log('[shot] 截图没成: ' + err.message);
    send('session:say', { name: '', text: '截图没成：' + err.message });
    return { ok: false, error: err.message };
  }
}

// ─── 桌面感知：拖文件 / 剪贴板求助 ─────────────────────────────────────────

/**
 * 替你把一句话打进聊天框并发出去（她在聊天窗口里答）。
 * 窗口可能还没开：开完等页面加载好再推，不然那句话掉地上没人捡。
 */
function askChat(text) {
  // 「开着」必须是「加载完了」—— 第一问刚把窗口拉起来、第二问接踵而至时，
  // 窗口存在但页面还在加载，直接 send 就丢了（评审抓的）
  const wasReady = chatWin && !chatWin.isDestroyed() && !chatWin.webContents.isLoading();
  createChatWindow();
  if (wasReady) { send('chat:ask', { text }); return; }
  chatWin.webContents.once('did-finish-load', () => {
    setTimeout(() => send('chat:ask', { text }), 300);
  });
}

/** 拖到她身上的东西分流。一次只接第一个 —— 拖一把过来意图就不明了 */
function routeDrop(paths) {
  const p = paths && paths[0] ? String(paths[0]) : '';
  if (!p) return;
  let st;
  try { st = fs.statSync(p); } catch (_) {
    send('session:say', { name: '', text: '这个我够不着（读不了）：' + path.basename(p) });
    return;
  }
  const kind = desk.kindOf(p, st);
  log('[drop] ' + kind + ': ' + p + (paths.length > 1 ? '（还拖了 ' + (paths.length - 1) + ' 个，只接第一个）' : ''));

  switch (kind) {
    case 'dir': {
      // 文件夹 = 要派活。面板叫出来，目录替你填好。
      // **面板可能是刚创建的**：页面没加载完就推，prefill 落地上、
      // 她还嘴硬「帮你填好了」（评审抓的）—— 跟 askChat 同款等法
      const panelWasReady = panelWin && !panelWin.isDestroyed() && !panelWin.webContents.isLoading();
      createPanel();
      if (panelWasReady) send('panel:prefill', { dir: p });
      else panelWin.webContents.once('did-finish-load', () => {
        setTimeout(() => send('panel:prefill', { dir: p }), 200);
      });
      send('session:say', { name: '', text: '收到，面板上目录帮你填好了：' + path.basename(p) });
      break;
    }
    case 'music': {
      // 歌收进歌单。**拷贝不搬家** —— 拖过来不等于同意把原文件挪走
      try {
        const name = desk.freshName(MUSIC_DIR, path.basename(p));
        fs.mkdirSync(MUSIC_DIR, { recursive: true });
        fs.copyFileSync(p, path.join(MUSIC_DIR, name));
        send('session:say', { name: '', text: '收进歌单了：' + name + '。想听就说～' });
      } catch (err) {
        log('[drop] 歌拷不进来: ' + err.message);
        send('session:say', { name: '', text: '这首没收进来：' + err.message });
      }
      break;
    }
    case 'image': {
      // 图跟截图一个待遇：路径 + 位图一起进剪贴板，粘给哪条线都行
      const img = nativeImage.createFromPath(p);
      const paste = /\s/.test(p) ? '"' + p + '"' : p; // \s：测空白，不是字母 s（笔误栽过）
      try {
        if (img.isEmpty()) clipboard.writeText(paste);
        else clipboard.write({ text: paste, image: img });
        send('session:say', { name: '', text: '图放剪贴板了，Ctrl+V 粘给哪条线都行。' });
      } catch (err) {
        send('session:say', { name: '', text: '剪贴板被占着，没放进去：' + err.message });
      }
      break;
    }
    case 'text': {
      // 日志/代码：读**尾巴**拿去问她（报错永远在尾巴上，整个塞进去是白花钱）
      try {
        const tail = desk.tailOf(p, 3000);
        askChat('帮我看看这个文件有什么问题，说说结论就行。\n文件：' + p + '\n内容（结尾部分）：\n' + tail);
      } catch (err) {
        send('session:say', { name: '', text: '文件读不了：' + err.message });
      }
      break;
    }
    default:
      send('session:say', { name: '', text: '这个我看不懂……丢文件夹、日志或者歌给我吧。' });
  }
}

// ─── 全屏勿扰 ────────────────────────────────────────────────────────────────
// 你在全屏（开会投屏/游戏/看片）时她主动出声，是这类产品最社死的场景。
// 探针：45 秒问一次「前台窗口是不是盖满了它那块屏」。
// **进入要连着两拍**（切窗口瞬间会闪一下全屏），**退出一拍就退**。
// 桌面本体（Progman/WorkerW）和系统壳层（CoreWindow：锁屏/开始菜单/搜索）不算 ——
const FS_PROBE_PS = [
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class U{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport(\"user32.dll\")]public static extern int GetClassName(IntPtr h,System.Text.StringBuilder s,int n);[StructLayout(LayoutKind.Sequential)]public struct R{public int L;public int T;public int Rt;public int B;}}'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '$h=[U]::GetForegroundWindow()',
  '$r=New-Object U+R',
  '[U]::GetWindowRect($h,[ref]$r)|Out-Null',
  '$sb=New-Object System.Text.StringBuilder 256',
  '[U]::GetClassName($h,$sb,256)|Out-Null',
  '$cls=$sb.ToString()',
  '$b=[System.Windows.Forms.Screen]::FromHandle($h).Bounds',
  '$fs=($r.L -le ($b.X+4)) -and ($r.T -le ($b.Y+4)) -and ($r.Rt -ge ($b.X+$b.Width-4)) -and ($r.B -ge ($b.Y+$b.Height-4))',
  "if(@('Progman','WorkerW','Windows.UI.Core.CoreWindow','') -contains $cls){$fs=$false}",
  "Write-Output ('FS ' + $(if($fs){1}else{0}))",
].join('\n');

const fsState = {};       // desk.fsDebounce 的状态
let fsProbing = false;    // 上一发还没回来就别叠

function startFullscreenWatch() {
  const b64 = Buffer.from(FS_PROBE_PS, 'utf16le').toString('base64');
  const timer = setInterval(() => {
    if (fsProbing) return;
    fsProbing = true;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { timeout: 10000, windowsHide: true }, (err, out) => {
        fsProbing = false;
        // 探不出来就**当没全屏喂进去**（而不是保持原状）：全屏程序关了、
        // 探针恰好开始报错的话，保持原状 = 勿扰永远卡死（评审抓的）。
        // 误静音比不静音糟，误解除只是多说两句话
        const m = err ? null : /^FS ([01])/m.exec(String(out));
        const was = fsQuiet;
        fsQuiet = desk.fsDebounce(fsState, Boolean(m && m[1] === '1'));
        // 勿扰也喂给心情系统：里程碑/羁绊道喜这种一次性的事，别在全屏里消费掉
        if (mood) mood.quiet = quiet || fsQuiet;
        if (fsQuiet !== was) log('[fs] 全屏勿扰' + (fsQuiet ? '开（前台全屏了，她闭嘴）' : '关'));
      });
  }, 45 * 1000);
  if (timer.unref) timer.unref();
}

// ─── git 值日生 ──────────────────────────────────────────────────────────────
// 改动攒了三个钟头没提交，她念叨一句（一天一个项目最多一次），
// 点「拟一条」派个终端去写提交信息给你过目 —— **先别真提交**。
const gitDirty = {}; // { 项目路径小写: 第一次看见脏的时刻 }

function startGitWatch() {
  const timer = setInterval(() => {
    try {
      if (awaySince || hushed()) return; // 人不在/不该吵，连查都不查
      const projects = sessions.knownProjects()
        .filter((p) => p.path && p.lastRun &&
                Date.now() - Date.parse(p.lastRun) < 7 * 86400000 &&
                fs.existsSync(path.join(p.path, '.git')))
        .slice(0, 6);
      for (const p of projects) checkGitDirty(p);
    } catch (err) { log('[git] 值日生出错: ' + err.message); }
  }, 30 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function checkGitDirty(p) {
  const key = p.path.toLowerCase();
  execFile('git', ['-C', p.path, 'status', '--porcelain'], { timeout: 15000, windowsHide: true },
    (err, out) => {
      if (err) return; // git 不在/仓库坏了都不关她事
      const n = String(out).split(/\r?\n/).filter(Boolean).length;
      if (!desk.gitNagCheck(gitDirty, key, n)) return;
      // 该念叨了 —— 但一天一个项目最多一次
      const markKey = 'git:' + key;
      if (dayMarks()[markKey] === journal.dayKey()) return;
      const m = dayMarks(); m[markKey] = journal.dayKey();
      try { fs.writeFileSync(MARKS_FILE, JSON.stringify(m), 'utf8'); } catch (_) { /* 明天再念叨一次也死不了 */ }
      const say = '「' + (p.name || path.basename(p.path)) + '」攒了 ' + n +
                  ' 个文件的改动，三个多钟头没提交了。要不要我拟条提交信息？';
      send('greet:say', {
        say, face: 'curious', hold: 20000,
        offer: { kind: 'commitmsg', label: '拟一条', dir: p.path },
      });
      speakLine(say, { maxLen: 60 });
      log('[git] 念叨了 ' + p.path + '（' + n + ' 个文件没提交）');
    });
}

// ─── 她写的周记 ─────────────────────────────────────────────────────────────
let diaryBusy = false;
let diaryDoneKey = '';   // 本次进程里已写过的周钥匙 —— daymarks 写盘失败时的兜底，
                         // 没有它的话盘写不进去会每 15 分钟重烧一次钱（评审抓的）

async function tryDiary() {
  try {
    if (diaryBusy) return;
    // 判「周一」必须跟 weekKey 同一套时钟（早上 5 点日界线）。
    // 用墙钟 getDay() 的话：熬夜的周一凌晨 00:30，getDay 说是周一、
    // dayKey 还算周日 → 凌晨写一次（记号记成周日），下午 dayKey 变周一
    // 又写一次 —— 一个周一烧两次钱、出两份周记（评审抓的）
    if (new Date(Date.now() - 5 * 3600 * 1000).getDay() !== 1) return;
    if (awaySince || hushed() || (play && play.busy)) return;
    const weekKey = journal.dayKey();                    // 这个周一的日期就是这周的钥匙
    if (diaryDoneKey === weekKey) return;
    if (dayMarks().diary === weekKey) return;
    diaryDoneKey = weekKey;
    const facts = diary.weekFacts({ readDay: journal.read, dayKeyOf: journal.dayKey });
    if (!facts) { markDay('diary'); return; }            // 这周没干什么，跳过也算写过
    diaryBusy = true;
    markDay('diary');                                    // 先记号 —— 失败也别这周反复烧钱重试
    const r = await diary.write({
      claudeBin: resolveClaudeBin(),
      getConfig: loadConfig,
      persona: (loadConfig().persona || {}).text || '',
      facts,
      aboutBits: about ? about.sample(2) : [],
      log,
    });
    diaryBusy = false;
    if (!r) { log('[diary] 这周没写出来，下周一再说'); return; }
    const file = path.join(STORE, 'diary', weekKey + '.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.text + '\n', 'utf8');
    journal.add('diary', { costUsd: r.costUsd || 0 });
    log('[diary] 写好了 ' + file + '（$' + (r.costUsd || 0).toFixed(4) + '）');
    send('greet:say', {
      say: '我写了这周的周记，要看吗？', face: 'shy', hold: 25000,
      offer: { kind: 'diary', label: '看看', file },
    });
    speakLine('我写了这周的周记，要看吗？', { maxLen: 30 });
  } catch (err) {
    diaryBusy = false;
    log('[diary] 出岔子: ' + err.message);
  }
}

// 全局快捷键。**必须是顶层函数**：设置里改完键要当场重挂，而那条路在
// wireIpc 里 —— 原来它嵌在 createTray 里，跨作用域调用直接 ReferenceError，
// 被 handler 的 try/catch 吞掉，表现是「保存好了但按了没反应」（实机踩过）
function registerHotkey() {
  // 先全摘掉再挂 —— 设置里改完键要能当场重挂，不摘的话老键还赖着
  try { globalShortcut.unregisterAll(); } catch (_) { /* 没挂过 */ }
  hotkeyState = {};
  const key = (loadConfig().hotkey || {}).panel || '';
  if (!key) { hotkeyState.panel = 'off'; } else {
  try {
    const ok = globalShortcut.register(key, () => {
      createPanel();
      if (panelWin && !panelWin.isDestroyed()) {
        if (panelWin.isMinimized()) panelWin.restore();
        panelWin.show();
        panelWin.focus();
      }
    });
    hotkeyState.panel = ok ? 'ok' : 'taken';
    log(ok ? '[main] 全局快捷键 ' + key + ' 已挂上' : '[main] 全局快捷键 ' + key + ' 被别的软件占了，跳过');
  } catch (err) {
    hotkeyState.panel = 'taken';
    log('[main] 全局快捷键挂不上: ' + err.message);
  }
  }

  // 截图那个键。跟面板那个分开注册 —— 一个被占不该连累另一个
  const sk = (loadConfig().hotkey || {}).shot || '';
  if (!sk) { hotkeyState.shot = 'off'; } else {
    try {
      const ok2 = globalShortcut.register(sk, () => openShot());
      hotkeyState.shot = ok2 ? 'ok' : 'taken';
      log(ok2 ? '[shot] 截图快捷键 ' + sk + ' 已挂上' : '[shot] 截图快捷键 ' + sk + ' 被别的软件占了，跳过');
    } catch (err) {
      hotkeyState.shot = 'taken';
      log('[shot] 截图快捷键挂不上: ' + err.message);
    }
  }

  // 剪贴板求助键：任何地方复制了报错，按一下她拿去看。
  // **只在你按键那一刻读一次剪贴板** —— 不做任何后台偷看
  const ck = (loadConfig().hotkey || {}).clip || '';
  if (!ck) { hotkeyState.clip = 'off'; } else {
    try {
      const ok3 = globalShortcut.register(ck, () => {
        let t = '';
        try { t = clipboard.readText().trim(); } catch (_) { /* 被占着 */ }
        if (!t) { send('session:say', { name: '', text: '剪贴板里没有文字呀。先复制报错再按这个键。' }); return; }
        if (t.length > 2500) t = t.slice(0, 2500) + '\n…（太长了，掐掉了后面）';
        askChat('帮我看看这个（我刚复制的），说说是怎么回事：\n' + t);
      });
      hotkeyState.clip = ok3 ? 'ok' : 'taken';
      log(ok3 ? '[clip] 求助快捷键 ' + ck + ' 已挂上' : '[clip] 求助快捷键 ' + ck + ' 被别的软件占了，跳过');
    } catch (err) {
      hotkeyState.clip = 'taken';
      log('[clip] 求助快捷键挂不上: ' + err.message);
    }
  }
}

function stopTunnel() {
  if (tunnelHandle) { try { tunnelHandle.stop(); } catch (_) { /* 已经没了 */ } tunnelHandle = null; }
}

function refreshTrayTip() {
  if (!tray) return;
  const now = Date.now();
  if (now - trayTipAt < 10000) {
    // 尾刷：窗口期里最后那次变化不能丢 —— 不补的话最后一条线干完之后
    // 再没有 change 事件，tooltip 会永远停在「1 条线在跑」（评审抓的）
    if (!trayTipPending) {
      trayTipPending = setTimeout(() => {
        trayTipPending = null;
        refreshTrayTip();
      }, 10000 - (now - trayTipAt) + 100);
    }
    return;
  }
  trayTipAt = now;
  try {
    const list = terminals ? terminals.list() : [];
    const run = list.filter((t) => t.status === 'running').length;
    const wait = list.filter((t) => t.status === 'waiting').length;
    const who = (loadConfig().persona || {}).name || '桌宠';
    const bits = [];
    if (run) bits.push(run + ' 条线在跑');
    if (wait) bits.push(wait + ' 条等你确认');
    tray.setToolTip('WaifuCode — ' + who + (bits.length ? '（' + bits.join(' · ') + '）' : ''));
  } catch (_) { /* tooltip 而已 */ }
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
    // 小本子随机抽两条 —— 搭话像认识很久的人，靠的就是这个
    about: about ? about.sample(2) : [],
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
let codexHashProbing = null;   // 正在飞的那一趟（Promise），别重复起
function ensureCodexHookHash() {
  if (codexHashProbing) return codexHashProbing;
  const notifyFile = path.join(__dirname, '..', 'hooks', 'notify.js');
  const nodeBin = terminals ? terminals.node.bin : process.execPath;
  // 尾巴上那个 v2 是**挂的 hook 变了**的标记：加了 UserPromptSubmit / Stop /
  // PreCompact 三条，老存档里那个单串哈希对不上新表，必须重问一次
  const want = nodeBin + '|' + notifyFile + '|v2';

  const cur = loadConfig().codex || {};
  if (cur.hookHashes && cur.hookFor === want) return Promise.resolve(); // 存过了，路径也没变

  codexHashProbing = new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; codexHashProbing = null; resolve(); };
    try {
      agents.probeCodexHookHash(
        { bin: agents.resolveCodexBin(), notifyFile, nodeBin },
        (hashes) => {
          const n = hashes ? Object.keys(hashes).length : 0;
          if (!n) { log('[codex] 没问到 hook 的信任哈希，这次先不带（不影响干活）'); return finish(); }
          try {
            config.patch({ codex: { hookHashes: hashes, hookHash: undefined, hookFor: want } });
            log('[codex] hook 信任哈希存好了 ' + n + ' 条，下次开窗她就能喊你了');
          } catch (_) { /* 存不上就下次再问 */ }
          finish();
        }
      );
    } catch (_) { finish(); }
    // 死线：探针自己有 9 秒超时，这儿再兜一层 —— 绝不能让开窗卡在这儿
    setTimeout(finish, 12000);
  });
  return codexHashProbing;
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
      // **把新装的路径推给三个长命对象**：它们各存了一份启动那刻解析的 bin，
      // 不推的话装完照样是 spawn ENOENT，用户得重启才好 —— 而她刚说完
      // 「装好啦，再点一次就能开工」（排查抓的）
      if (agent !== 'codex') {
        try {
          const fresh = resolveClaudeBin();
          if (terminals) terminals.claudeBin = fresh;
          if (chat) chat.claudeBin = fresh;
          if (greeter) greeter.claudeBin = fresh;
          log('[install] claude 路径已更新给正在跑的那几摊: ' + fresh);
        } catch (e) { log('[install] 路径推不过去（重启一次就好）: ' + e.message); }
      }
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

// ─── 局域网版本更新 ──────────────────────────────────────────────────────────
const UPDATE_DIR = path.join(DATA_ROOT, 'updates');          // 发包侧：安装包丢这儿
const UPDATE_DL = path.join(DATA_ROOT, 'update-download');   // 收包侧：下到这儿
let updateSrv = null;      // 分发服务（开着才有）
let mobileSrv = null;      // 手机工作台服务（面板点过「手机」才有）
let mobileToday = null;    // 今天花费的 10 秒缓存 —— SSE 每 0.8 秒一推，别每推都扫流水
let tunnelHandle = null;   // 出门模式的隧道（开着才有）
let shotWins = [];         // 截图浮罩，**一块屏一层**（框的时候才有）
// 两个快捷键各自挂没挂上（ok / taken 被占了 / off 没设）。
// 设置页要如实显示 —— 全局快捷键被别的软件占是家常便饭，
// 不说的话用户按了没反应只会以为「这功能坏了」
let hotkeyState = {};
let docsWin = null;        // 功能手册窗口（面板上「说明书」开的，单例）
let updateLatest = null;   // 上次探到的远端 manifest —— 面板开晚了靠它补显示

// 分发开关：让「现在的状态」向「存档想要的状态」看齐（启动、设置保存都走这儿）
function syncUpdateServe(cfg) {
  const want = !!(((cfg || {}).update || {}).serve);
  const port = Number(((cfg || {}).update || {}).port) || 47200;
  if (want === !!updateSrv) return;
  if (!want) {
    try { updateSrv.close(); } catch (_) { /* 关不上也没什么可做的 */ }
    updateSrv = null;
    log('[update] 分发关了');
    return;
  }
  try { fs.mkdirSync(UPDATE_DIR, { recursive: true }); } catch (_) { /* 已存在 */ }
  const srv = updates.createServer({ dir: UPDATE_DIR, log });
  srv.on('error', (err) => {
    // 典型是端口被占。别崩，说清楚就行
    log('[update] 分发起不来: ' + err.message);
    send('session:say', { name: '', text: '更新分发起不来：' + err.message + '（多半是 ' + port + ' 口被占了）' });
    updateSrv = null;
  });
  srv.listen(port, () => log('[update] 分发开在 :' + port + '，包放 ' + UPDATE_DIR));
  updateSrv = srv;
}

// ─── 手机工作台 ──────────────────────────────────────────────────────────────
/**
 * 详情 = 内存里的时间线 + **流水账里这条线之前的阶段汇报**。
 *
 * 内存那份只有「这轮开的窗口」才有；桌宠重启过、或者窗口是上午开的，
 * 打开详情就是一张白纸 —— 而用户点进来最想知道的恰恰是「做到哪了」。
 * 流水账里每条 report 都记着（今天 + 昨天，够用了），按 termId 捞回来。
 */
function detailWithHistory(id) {
  const d = terminals ? terminals.detail(id) : null;
  if (!d) return null;
  let past = [];
  try {
    const rows = [...journal.read(Date.now() - 86400000), ...journal.read()];
    past = rows
      .filter((r) => r.type === 'report' && r.termId === id && r.brief)
      .map((r) => ({ at: +new Date(r.at), kind: 'her', text: r.brief }));
  } catch (_) { /* 流水读不到就只给内存那份 */ }
  if (!past.length) return d;

  // 合起来按时间排，同一句话不重复摆（内存那份和流水那份会有重叠）。
  //
  // 【为什么原来去重会漏】两份是同一句话，但**长得不完全一样**：流水那份
  // 进过 journal 的净化（绝对路径压成「…」、密钥被抹），内存那份是原文、
  // 还把连续空白压成了一个空格。拿前 40 个字符当钥匙，只要差异落在前 40 个
  // 字里，两份就都留下 —— 手机上就是「我说一句，她的回答出现两遍」（实拍）。
  //
  // 【比前缀是不够的】差异可能就落在第二个字上（「把 D:\WaifuCode\src 里的…」
  // vs「把 … 里的…」），前缀一比就分家。所以**把会被净化掉的整段抹掉再比**：
  // 路径、被替换成「…」的那截、空白、密钥占位，一律抹平，剩下的中文/字母
  // 才是这句话的骨架。60 秒内同 kind、骨架前 16 字一样 = 同一句。
  // 只留**中文骨架**。路径、密钥、英文标识符、省略号、标点、空白 —— 净化会动的
  // 全在这些里头，一律抹掉；剩下的汉字和数字才是这句话真正说了什么。
  // （两份的差异永远是「被净化的那截」，抹了它俩就一模一样）
  const norm = (s) => String(s).replace(/[^一-龥぀-ヿ0-9]/g, '');
  const seen = new Set();
  const recent = [];
  const all = [...past, ...(d.timeline || [])]
    .sort((a, b) => a.at - b.at)
    .filter((e) => {
      const n = norm(e.text);
      if (!n) return true; // 抹完什么都不剩（纯路径那种）：留着，别误杀
      const k = e.kind + '|' + n.slice(0, 24);
      if (seen.has(k)) return false;
      const head = n.slice(0, 16);
      if (recent.some((r) => r.kind === e.kind && r.head === head && Math.abs(r.at - e.at) < 60000)) return false;
      seen.add(k);
      recent.push({ kind: e.kind, head, at: e.at });
      return true;
    });
  return { ...d, timeline: all.slice(-40) };
}

/**
 * 让手机翻电脑上的文件夹（选项目用）。
 *
 * 手机上没有系统选择器，手敲 D:\某某\某某 是最劝退的一步。
 * **只列文件夹名，不读任何文件内容**；dir 给空就列所有盘符。
 * 隐藏目录和 . 开头的不列 —— 选项目用不上，列出来还碍眼。
 */
function browseDirs(dir) {
  const d = String(dir || '').trim();
  if (!d) {
    // 盘符列表：A~Z 挨个探一遍（比拉 wmic 快，也不用另起进程）
    const drives = [];
    for (let i = 67; i <= 90; i++) { // C..Z
      const root = String.fromCharCode(i) + ':\\';
      try { if (fs.existsSync(root)) drives.push({ name: String.fromCharCode(i) + ':', path: root }); } catch (_) { /* 探不了就跳 */ }
    }
    return { cwd: '', parent: null, dirs: drives, files: [] };
  }
  let cwd;
  try { cwd = path.resolve(d); } catch (_) { return { cwd: '', parent: null, dirs: [], error: '这个路径不认识' }; }
  let names = [];
  try { names = fs.readdirSync(cwd, { withFileTypes: true }); } catch (err) {
    return { cwd, parent: path.dirname(cwd) === cwd ? '' : path.dirname(cwd), dirs: [], files: [], error: '打不开这个文件夹' };
  }
  const dirs = names
    .filter((e) => {
      if (!e.isDirectory() || e.name.startsWith('.')) return false;
      try { return !(fs.statSync(path.join(cwd, e.name)).mode & 0); } catch (_) { return false; }
    })
    .slice(0, 300)
    .map((e) => {
      const full = path.join(cwd, e.name);
      let git = false;
      try { git = fs.existsSync(path.join(full, '.git')) || fs.existsSync(path.join(full, 'package.json')); } catch (_) { /* 探不了当不是 */ }
      return { name: e.name, path: full, project: git };
    })
    // 像项目的排前面 —— 你要找的多半就是它们
    .sort((a, b) => (Number(b.project) - Number(a.project)) || a.name.localeCompare(b.name, 'zh'));
  // 文件也列出来 —— 手机上要把「电脑上的这张图 / 这个日志」交给她，
  // 只能在这儿挑（手机没有电脑的系统选择器）。**只给名字、路径、类型和大小，
  // 绝不给内容** —— 内容要不要读是那条线自己的事
  const files = names
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .slice(0, 300)
    .map((e) => {
      const full = path.join(cwd, e.name);
      let st = null;
      try { st = fs.statSync(full); } catch (_) { return null; }
      return { name: e.name, path: full, kind: desk.kindOf(full, st), size: st.size };
    })
    .filter(Boolean)
    // 图和文本排前面 —— 要交给她看的多半是这两类
    .sort((a, b) => (RANK[b.kind] || 0) - (RANK[a.kind] || 0) || a.name.localeCompare(b.name, 'zh'));
  const up = path.dirname(cwd);
  return { cwd, parent: up === cwd ? '' : up, dirs, files };
}

// 挑文件时谁该排前面（图和日志是最常要交给她的）
const RANK = { image: 3, text: 2, music: 1, nope: 0 };

/**
 * 拖进面板的那几个东西**分别是什么**。渲染层碰不到 fs，只能问这儿。
 *
 * 跟拖到她身上（routeDrop）用的是**同一个** desk.kindOf —— 一套判据，
 * 两处用。这儿只认类型不做事：怎么用（填目录还是填进任务）由面板自己定。
 */
function classifyDrop(paths) {
  const out = [];
  for (const raw of (Array.isArray(paths) ? paths : []).slice(0, 20)) {
    const p = String(raw || '');
    if (!p) continue;
    let st = null;
    try { st = fs.statSync(p); } catch (_) { out.push({ path: p, name: path.basename(p), kind: 'gone' }); continue; }
    out.push({ path: p, name: path.basename(p), kind: desk.kindOf(p, st), size: st.isFile() ? st.size : 0 });
  }
  return out;
}

// 心情英文状态词 → 中文（跟 panel.js 的 STATE_TEXT 保持一致）
const MOOD_TEXT = {
  normal: '平静', working: '干活中', excited: '来劲了', frustrated: '烦躁',
  sad: '低落', lonely: '闹脾气', happy: '开心', proud: '得意',
  surprised: '吃惊', shy: '害羞', tired: '累了', sleepy: '困',
  angry: '生气', playful: '搞怪', scorn: '不屑', curious: '好奇',
  panic: '慌', bored: '无聊',
};
function mobileState() {
  const cfg = loadConfig();
  if (!mobileToday || Date.now() - mobileToday.at > 10000) {
    let usd = 0;
    try { usd = journal.today().costUsd || 0; } catch (_) { /* 没账就 0 */ }
    mobileToday = { at: Date.now(), usd };
  }
  let projects = [];
  // 按最近用过排序 + 过滤掉 registry 里的垃圾目录（Desktop/music 之类），
  // 跟桌面面板一个待遇 —— 手机上手敲目录最痛苦，chips 得端上最可能要的那几个
  // **knownProjects 给的才是真目录**（{name, path}）。recentProjects 返回的是
  // 「WaifuCode（昨天弄的）」这种**显示串**，.name / .path 全是 undefined ——
  // 手机上就摆出一排没字、点了还把目录框填成 undefined 的空胶囊（用户实拍）。
  // 筛法跟 recentProjects 一样：目录里有 .git 或 package.json 才算项目，
  // 挡掉 registry 里的 Desktop / music 这类垃圾目录
  try {
    projects = sessions.knownProjects()
      .filter((p) => p.path && p.lastRun &&
              (fs.existsSync(path.join(p.path, '.git')) ||
               fs.existsSync(path.join(p.path, 'package.json'))))
      .sort((a, b) => Date.parse(b.lastRun) - Date.parse(a.lastRun))
      .slice(0, 6);
  } catch (_) { /* 空着 */ }
  return {
    name: (cfg.persona || {}).name || '小依',
    // 翻成中文再下发（normal→平静）—— 手机页不该看到内部英文状态词
    mood: mood ? MOOD_TEXT[(mood.snapshot() || {}).state] || '' : '',
    todayUsd: mobileToday.usd,
    projects: projects.map((p) => ({ name: p.name, path: p.path })),
    terminals: terminals ? terminals.list() : [],
  };
}

function ensureMobile() {
  const cfg = loadConfig();
  let token = (cfg.mobile || {}).token;
  const port = Number((cfg.mobile || {}).port) || 47201;
  if (!token) {
    token = mobile.newToken();
    config.patch({ mobile: { token } });
  }
  if (!(cfg.mobile || {}).enabled) config.patch({ mobile: { enabled: true } });

  const urls = updates.lanIPs().map((ip) => 'http://' + ip + ':' + port + '/?t=' + token);
  // 出门模式开着的话，把公网地址一起带回去 —— 关了二维码窗口再打开，
  // 面板要能如实显示「现在是开着的、地址是这个」，而不是装作没开过
  const tunnelUrl = tunnelHandle ? tunnelHandle.url + '/?t=' + token : null;
  if (mobileSrv) return Promise.resolve({ ok: true, urls, port, tunnelUrl });

  return new Promise((resolve) => {
    const srv = mobile.createMobileServer({
      pageFile: path.join(ROOT, 'src', 'renderer', 'mobile.html'),
      // 「加到主屏」要的图标。取不到就只是图标是白的，不影响用
      iconFile: (() => {
        for (const p of [path.join(ROOT, 'build', 'icon.png'), path.join(ROOT, 'assets', 'icon.png')]) {
          try { if (fs.existsSync(p)) return p; } catch (_) { /* 探不了就试下一个 */ }
        }
        return null;
      })(),
      token,
      log,
      hooks: {
        state: () => mobileState(),
        // 手机派的活永远最小化开（人都不在电脑前，弹脸给谁看）
        dispatch: async (opts) => {
          const agent = resolveDispatchAgent(opts.agent);
          const noCli = guardAgent(agent);
          if (noCli) return noCli;
          // 手机上派 codex 更要等 —— 这条路上人根本不在电脑前，
          // 「Hooks need review」冒出来就是彻底卡死（用户实拍）
          if (agent === 'codex') await ensureCodexHookHash();
          // 手机上选了就用手机的，没选才跟电脑上的设置走。
          // **一定要过 resolveDispatchModel**：那是白名单，手机来的字段
          // 是外部输入，不能直接拼进命令行
          const model = agent === 'codex' ? undefined
            : (opts.model ? resolveDispatchModel(opts.model)
                          : resolveDispatchModel((loadConfig().dispatch || {}).model));
          try {
            return { ok: true, ...openLaneTerminal({ ...opts, model, agent }, { minimized: true }) };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
        approve: (id, allow) => (terminals ? terminals.approveRemote(id, allow) : { ok: false, error: '终端管理还没起来' }),
        detail: (id) => detailWithHistory(id),
        send: (id, text) => (terminals ? terminals.sendText(id, text) : { ok: false, error: '终端管理还没起来' }),
        // 完整对话：从 Claude Code 自己写的会话档案里读（内存那份时间线
        // 每条只有 300 字，用户要的细节不在那儿）
        full: (id) => {
          try {
            const rec = terminals ? terminals.get(id) : null;
            if (!rec) return { ok: false, why: '这条线不在了', turns: [] };
            if (!rec.sessionId) return { ok: false, why: '这条线还没有会话记录', turns: [] };
            // 两张嘴的档案格式天差地别，但**吐出来的形状必须一样** ——
            // 手机那头不该知道这条线是谁在干（agents.codexTurns 照着
            // cost.turnsOf 的契约写的）
            return rec.agent === 'codex'
              ? agents.codexTurns(rec.sessionId)
              : cost.turnsOf(rec.sessionId);
          } catch (err) {
            log('[mobile] 完整对话读不出来: ' + err.message);
            return { ok: false, why: '读不出来：' + err.message, turns: [] };
          }
        },
        browse: (dir) => browseDirs(dir),
        lanes: (dir) => lanesFor(dir),
        /**
         * 手机上「看看那个窗口」：把它捞到前台，照着它的矩形截一张。
         * 截的是**屏幕**（跟框选截图同一条路），所以窗口必须真的在前面 ——
         * 人在电脑前会看见它跳出来，这点没法绕。
         */
        peek: async (id) => {
          if (!terminals) return { ok: false, error: '终端管理还没起来' };
          const r = await terminals.peekRect(id);
          if (!r.ok) return r;
          try {
            // DIP → 物理像素：缩放不是 100% 的机器上不换算就截歪（跟 doShot 同款）
            const phys = screen.dipToScreenRect(null, {
              x: r.rect.x, y: r.rect.y, width: r.rect.w, height: r.rect.h,
            });
            const file = await shot.grab({
              x: phys.x, y: phys.y, w: phys.width, h: phys.height,
              dir: path.join(DATA_ROOT, 'shots'), log,
            });
            return { ok: true, file };
          } catch (err) { return { ok: false, error: '截不下来：' + err.message }; }
        },
        key: (id, name) => (terminals ? terminals.keyRemote(id, name) : { ok: false, error: '终端管理还没起来' }),
        /**
         * 手机上传过来的东西，落到电脑上（`<数据目录>/inbox/`），回一个路径。
         *
         * 【三道闸，一道都不能少 —— 这是唯一一条「外面往这台电脑写文件」的路】
         *   ① 名字只取 basename 再洗一遍：路径分隔符、.. 、控制字符全干掉，
         *      不然 `../../启动文件夹/x.bat` 就能写到别处去
         *   ② 后缀白名单：只收图、文本、pdf。**exe/bat/ps1 这些一律不收** ——
         *      收下来就等于给了一条「往这台机器上放可执行文件」的路
         *   ③ 落盘只在 inbox 一个目录，重名自动改名（不覆盖你已有的东西）
         */
        upload: (rawName, buf) => {
          const OK_EXT = new Set([
            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic',
            '.txt', '.log', '.md', '.json', '.csv', '.yml', '.yaml', '.pdf',
          ]);
          try {
            if (!buf || !buf.length) return { ok: false, error: '空文件' };
            // ① 洗名字
            let name = path.basename(String(rawName || '').replace(/[\\/]/g, '/'))
              .replace(/[\x00-\x1f<>:"|?*]/g, '')
              .replace(/^\.+/, '')
              .trim()
              .slice(0, 80);
            if (!name) name = 'file';
            // ② 后缀白名单
            const ext = path.extname(name).toLowerCase();
            if (!OK_EXT.has(ext)) {
              return { ok: false, error: '这种格式不收（只收图片、文本和 pdf）' };
            }
            // ③ 只落 inbox，重名改名
            const dir = path.join(DATA_ROOT, 'inbox');
            fs.mkdirSync(dir, { recursive: true });
            const fresh = desk.freshName(dir, name);
            const full = path.join(dir, fresh);
            fs.writeFileSync(full, buf);
            log('[mobile] 手机传来 ' + fresh + '（' + Math.round(buf.length / 1024) + ' KB）');
            return { ok: true, path: full, name: fresh };
          } catch (err) {
            return { ok: false, error: '存不下：' + err.message };
          }
        },
        // 叫停：只把 Esc 送进窗口。**不做关窗** —— 那不可逆，手机上误触
        // 的代价太大（要关就走到电脑前，或者在面板上关）
        interrupt: (id) => (terminals ? terminals.interruptRemote(id) : { ok: false, error: '终端管理还没起来' }),
      },
    });
    srv.on('error', (err) => {
      log('[mobile] 起不来: ' + err.message);
      mobileSrv = null;
      resolve({ ok: false, error: '手机工作台起不来：' + err.message + '（多半是 ' + port + ' 口被占了）' });
    });
    // 0.0.0.0：手机要从局域网进来。安全靠随机口令那道闸
    srv.listen(port, '0.0.0.0', () => {
      mobileSrv = srv;
      log('[mobile] 手机工作台开在 :' + port);
      resolve({ ok: true, urls, port, tunnelUrl });
    });
  });
}

// 收包侧：查一次。有新版就亮面板，她也吱一声（同一个版本只吱一次）。
// overrideSource：设置页「现在查一次」查的必须是**输入框里现在这个**，
// 不是盘上存的那个 —— 刚粘完地址还没保存就点查是最自然的操作，查旧值
// 等于谎报「已经是最新」（评审抓的）
let updateLatestSrc = null; // updateLatest 是从哪个源探到的（下载要用同一个源）
async function checkUpdate(overrideSource) {
  const cfg = loadConfig();
  const source = String(overrideSource != null ? overrideSource : ((cfg.update || {}).source || '')).trim();
  const current = app.getVersion();
  if (!source) {
    // 源清空了，之前探到的新版也一起作废 —— 不清的话面板按钮僵在那儿
    updateLatest = null;
    updateLatestSrc = null;
    return { ok: true, current, hasUpdate: false };
  }
  try {
    const m = await updates.fetchLatest(source);
    const hasUpdate = updates.cmpVer(m.version, current) > 0;
    updateLatest = hasUpdate ? m : null;
    updateLatestSrc = hasUpdate ? source : null;
    if (hasUpdate) {
      send('update:available', { version: m.version });
      if ((cfg.update || {}).announced !== m.version) {
        config.patch({ update: { announced: m.version } });
        send('session:say', {
          name: '',
          text: '有新版 ' + m.version + ' 啦（现在是 ' + current + '）。派活面板标题旁点一下就能更新。',
        });
      }
    }
    return { ok: true, current, hasUpdate, latest: m.version };
  } catch (err) {
    return { ok: false, current, hasUpdate: false, error: '够不着更新源（' + source + '）：' + err.message };
  }
}

// 收包侧：下载 + 校验 + 拉起安装器。装的时候我们得让路 —— 自己退出。
// 在途锁：下载几十秒里用户完全可能再点一次按钮，两条流写同一个文件互相踩、
// 校验失败那条还会把另一条正在写的删掉（评审抓的）—— 同一时刻只跑一单，
// 重复点直接搭上正在跑的那单
let updateApplying = null;
function applyUpdate() {
  if (!updateApplying) {
    updateApplying = _applyUpdate().finally(() => { updateApplying = null; });
  }
  return updateApplying;
}

async function _applyUpdate() {
  if (!updateLatest) {
    const r = await checkUpdate();
    if (!r.ok) return r;
    if (!updateLatest) return { ok: false, error: '现在就是最新版（' + r.current + '）' };
  }
  const source = updateLatestSrc || ((loadConfig().update || {}).source || '').trim();
  try {
    // 上一轮的旧安装包别攒着 —— 一个上百 MB，只进不出等于白吃硬盘（评审抓的）
    try { fs.rmSync(UPDATE_DL, { recursive: true, force: true }); } catch (_) { /* 没有就算了 */ }
    const exe = await updates.download(source, updateLatest, UPDATE_DL);
    // openPath 失败**不 reject**，只 resolve 一个错误串 —— 不看的话：安装器
    // 被杀软拦了没起来，她却先喊「装完再见」然后自己退了，用户面前空无一物
    const openErr = await shell.openPath(exe);
    if (openErr) {
      log('[update] 安装器拉不起来: ' + openErr);
      return {
        ok: false,
        error: '包下好了，但安装器没拉起来：' + openErr
             + '（多半被杀毒软件拦了。包在 ' + exe + '，可以手动跑）',
      };
    }
    log('[update] 安装器起来了，退出让路');
    send('session:say', { name: '', text: '新版下好啦，安装器出来了 —— 我先退下，装完再见！' });
    // 【必须死透，不能只是「开始退出」。】安装器那头会反复查
    // 「WaifuCode.exe 还在吗」，查到就弹「无法关闭」。app.quit() 走的
    // 那串事件里任何一步抛了/卡了，进程就僵住 —— 所以这儿手动把
    // 该收的收了（每步兜住），最后 app.exit() 一刀切：它不走事件链，
    // 没有任何东西能拦住它
    setTimeout(() => {
      const step = (fn) => { try { fn(); } catch (_) { /* 收不上也不能拦退出 */ } };
      step(() => stopTunnel());
      step(() => { if (updateSrv) updateSrv.close(); });
      step(() => { if (mobileSrv) mobileSrv.close(); });
      step(() => { if (sessions) sessions.stopAll(); });
      step(() => { if (terminals) terminals.dispose(); });
      step(() => { if (chat) chat.dispose(); });
      step(() => { if (mood) mood.dispose(); });
      step(() => { if (voice) voice.dispose(); });
      log('[update] 收拾完了，死透让路');
      app.exit(0);
    }, 1500); // 给气泡 1.5 秒露脸 —— 安装器要人点几下才走到检查那步，来得及
    return { ok: true };
  } catch (err) {
    log('[update] 更新没成: ' + err.message);
    return { ok: false, error: err.message };
  }
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

/**
 * 这个项目留着的线（面板那排 chip 和手机上那排，用的是**同一份**）。
 *
 * 空数组 = 「这个项目没留着线」，跟「读挂了」在协议上分不开 ——
 * 所以出错一定要记一行，不然连查都没得查（排查抓的）。
 */
function lanesFor(dir) {
  try {
    const d = String(dir || '').trim();
    if (!d || !fs.existsSync(d)) return [];
    return sessions.lanes(d).slice(0, 5).map((l) => ({
      laneId: l.id,
      name: l.name || '',
      lastRun: l.lastRun || '',
      alive: Boolean(l.alive),
      turns: l.turns || 0,
      hint: l.name ? '' : cost.lastUserPrompt(l.sessionId),
    }));
  } catch (err) {
    log('[session] 这个项目的线读不出来: ' + err.message);
    return [];
  }
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

    case 'diary': {
      // 周记写好了，点「看看」直接开文件
      if (offer.file && fs.existsSync(offer.file)) shell.openPath(offer.file);
      break;
    }

    case 'commitmsg': {
      // git 值日生的「拟一条」。派个终端去看 diff 写提交信息 ——
      // 花钱的是这一下（正常派活的价），点按钮 = 你同意了
      const agent = resolveDispatchAgent((loadConfig().dispatch || {}).agent);
      const noCli2 = guardAgent(agent);
      if (noCli2) { send('session:say', { name: '', text: noCli2.error }); break; }
      try {
        openLaneTerminal({
          projectPath: offer.dir, laneName: '拟提交信息',
          task: '看看这个仓库还没提交的改动（git status、git diff），帮我拟一条像样的提交信息给我过目。**先别真的提交**，等我确认。',
          agent,
          model: agent === 'codex' ? undefined : resolveDispatchModel((loadConfig().dispatch || {}).model),
        }, { minimized: false });
        send('session:say', { name: '拟提交信息', text: '好，我去看看改了什么，拟好念给你听。' });
      } catch (err) {
        log('[git] 拟提交信息没派出去: ' + err.message);
        send('session:say', { name: '', text: '没派出去：' + err.message });
      }
      break;
    }

    case 'resume': {
      // 隔天开场白的「接着弄」。跟面板上点「接着聊」走同一条路 ——
      // 老线只列 claude 侧 alive 的（codex 的会话档不在 ~/.claude，天然被滤掉），
      // 所以这儿写死 claude，别跟着全局默认走（面板那个坑踩过一次）
      const noCli = guardAgent('claude');
      if (noCli) { send('session:say', { name: '', text: noCli.error }); break; }
      try {
        openLaneTerminal({
          projectPath: offer.dir, laneId: offer.laneId, laneName: offer.laneName || '',
          task: '', agent: 'claude',
          model: resolveDispatchModel((loadConfig().dispatch || {}).model),
        }, { minimized: false });
        send('session:say', { name: offer.laneName || '', text: '接上了，窗口开好了。' });
      } catch (err) {
        log('[recap] 接不上昨天那条线: ' + err.message);
        send('session:say', { name: '', text: '没接上：' + err.message });
      }
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
    case 'remind': {
      // 「三点提醒我开会」—— 她聊天时听出来的，转手记进小本子
      const r = reminders ? reminders.add(a) : { ok: false, error: '还没起来' };
      if (r.ok) {
        const d = new Date(r.when);
        const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
        send('session:say', { name: '', text: '记下了，' + hm + ' 我喊你：' + r.text });
      } else {
        send('session:say', { name: '', text: '这个提醒我没记上（' + r.error + '），再说一遍？' });
      }
      break;
    }
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
      nx = Math.max(wx - petWinSize.w + GRAB, Math.min(wx + ww - GRAB, nx));
      ny = Math.max(wy, Math.min(wy + wh - GRAB, ny)); // 顶部不许出去，出去就抓不着了
    } catch (_) {
      /* 取不到屏幕信息就不夹，总比拖不动强 */
    }

    // setBounds 带上写死的尺寸，不走「只挪位置」的那条 API：那条在缩放屏上
    // 每次内部换算都可能把窗口撑大 1px，拖动高频调用就成了「拖着拖着变大」
    petWin.setBounds({ x: nx, y: ny, width: petWinSize.w, height: petWinSize.h });
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
    const live = terminals
      ? terminals.list().filter((t) => t.status !== 'done' && t.status !== 'closed')
      : [];
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
      { label: '截个图（复制）…', click: () => openShot() },
      { label: '她记的关于你的事…', click: () => {
        // 明文可翻可删：错了的记忆你能直接删那行，她就忘了
        if (!about) return;
        about.ensure(); // 只落头部说明，不写占位记忆 —— 占位话会被她当真事实提起
        shell.openPath(about.file);
      } },
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

  ipcMain.handle('session:dispatch', async (_e, opts) => {
    const cfg = loadConfig().dispatch || {};
    // 面板传了 agent 就用它；没这个字段的老入口用记住的默认（记住这件事在面板侧做）
    const agent = resolveDispatchAgent('agent' in (opts || {}) ? opts.agent : cfg.agent);
    const noCli = guardAgent(agent);
    if (noCli) return noCli;
    // **信任哈希没到手就先等它**（一般启动时就问完了，这儿是兜底）——
    // 不等的话第一个 codex 窗口开出来就是那张「Hooks need review」，
    // 而那张卡在窗口里的时候，手机上是彻底哑的（用户实拍）
    if (agent === 'codex') await ensureCodexHookHash();

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

  ipcMain.handle('session:open-terminal', async (_e, opts) => {
    const dcfg = loadConfig().dispatch || {};
    const agent = resolveDispatchAgent('agent' in (opts || {}) ? opts.agent : dcfg.agent);
    const noCli = guardAgent(agent);
    if (noCli) return noCli;
    if (agent === 'codex') await ensureCodexHookHash();   // 同上：别让「Hooks need review」冒出来

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

  // 「这个项目留着的线」：后端 lanes() 早就在了，只差这条 IPC。
  // 没名字的线拿「上次聊到什么」当名 —— 光靠时间戳认不出哪条是哪条
  ipcMain.handle('session:lanes', (_e, dir) => lanesFor(dir));

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
      // 跟远端差几个提交（没配 upstream 时 git 报错 → null → 按 0 算）
      const ab = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
      let behind = 0, ahead = 0;
      if (ab) {
        const m = ab.trim().split(/\s+/);
        behind = parseInt(m[0], 10) || 0;
        ahead = parseInt(m[1], 10) || 0;
      }
      const last = await git(['log', '-1', '--format=%s']);
      return {
        branch: branch.trim(), dirty, ahead, behind,
        lastCommit: String(last || '').trim().slice(0, 60),
      };
    } catch (err) {
      // null 在这条协议里的意思是「不是 git 仓库」。真出错也返回 null 的话，
      // 面板就装作这目录没被 git 管着 —— 至少留一行，别静默（排查抓的）
      log('[git] 查不了这个目录: ' + err.message);
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
  ipcMain.on('settings:preview-look', (_e, lookCfg) => {
    send('look:apply', lookCfg || {});
    applyPetScale(petScaleOf({ look: lookCfg }));
  });

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
      // announced（她喊过哪个新版）是她自己的小本本，不归设置窗管 —— 设置窗
      // 开着的当口她喊了一嗓子的话，保存旧快照会把这笔抹掉、下次又喊一遍
      if (next.update) { delete next.update.announced; delete next.update.seenVersion; }
      const after = config.patch(next);

      // 【下面每一步都各自兜住。】盘在上面那句 config.patch 就已经写了 ——
      // 这儿再抛，用户看到的是「没存上」（其实存了），而且排在抛点后面的
      // 步骤一件都不做：快捷键没重挂、角色没重载。一个不相干的小毛病
      // 不该让整串生效逻辑连坐（排查抓的）
      const step = (what, fn) => {
        try { fn(); } catch (e) { log('[settings] ' + what + ' 没做成: ' + e.message); }
      };

      // 语音的改动当场生效，不用重启
      if (voice) {
        Object.assign(voice.cfg, after.voice || {});
        // 音色变了得把连接扔掉重建 —— 那条 WebSocket 是绑着音色开的
        if ((before.voice || {}).voiceName !== (after.voice || {}).voiceName) {
          voice._drop('换了音色');
        }
      }

      // 「她的大小」：预览时窗口已经跟着了，这一步是落定（换角色那条路也得走到）
      step('调大小', () => applyPetScale(petScaleOf(after)));

      // 更新分发开关跟着存档走
      step('更新分发开关', () => syncUpdateServe(after));

      // 快捷键改了就当场重挂（不用重启）
      step('重挂快捷键', () => {
        if (JSON.stringify(before.hotkey || {}) !== JSON.stringify(after.hotkey || {})) registerHotkey();
      });

      // 情绪动作 / 情绪符号这两个开关，渲染层只在开机时读过一次 ——
      // 改了不重载的话存档对了、行为没换，跟快捷键那个坑一模一样（排查抓的）
      step('情绪开关生效', () => {
        if (JSON.stringify(before.gesture || {}) !== JSON.stringify(after.gesture || {})) {
          if (petWin && !petWin.isDestroyed()) petWin.reload();
        }
      });

      // 换角色：重新加载渲染层就行，整个应用不用重启
      if (before.modelPath !== after.modelPath) {
        log('[settings] 换角色: ' + before.modelPath + ' → ' + after.modelPath);
        if (petWin && !petWin.isDestroyed()) petWin.reload();
      } else {
        // 没换人的话，把外观推过去落定（预览时已经在看了，这一步是为了保险）
        send('look:apply', after.look || {});
      }

      log('[settings] 存好了');
      return { ok: true, hotkey: hotkeyState };
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
  ipcMain.handle('app:info', () => {
    // 面板一开就顺手查一次新版（配了源、且手上还没有已探到的才查）。
    // 不查的话：开机 20 秒内打开面板看不到更新按钮，用户以为「检测不到」——
    // 实机反馈的。异步放着跑，查到了走 update:available 推送，面板自己会亮
    if (((loadConfig().update || {}).source || '').trim() && !updateLatest) {
      checkUpdate().catch(() => { /* 查不到就等下一班 */ });
    }
    return appInfoData();
  });
  function appInfoData() { return ({
    claudeBin: resolveClaudeBin(),
    root: ROOT,
    dataRoot: DATA_ROOT,
    version: app.getVersion(),
    lanIPs: updates.lanIPs(),
    updateDir: UPDATE_DIR,
    updatePort: Number((loadConfig().update || {}).port) || 47200,
    // 已经探到、还没装的新版本号（面板开晚了靠这个补显示）
    updateAvailable: updateLatest ? updateLatest.version : null,
  }); }

  // 面板上的「说明书」：把随包带的功能手册开在一个独立窗口里。
  // 手册是单文件 HTML（图全内嵌），asar 又是关的，loadFile 直接就能吃
  ipcMain.on('docs:open', () => {
    if (docsWin && !docsWin.isDestroyed()) { docsWin.focus(); return; }
    docsWin = new BrowserWindow({
      width: 880,
      height: 920,
      autoHideMenuBar: true,
      title: '功能手册',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    docsWin.loadFile(path.join(ROOT, 'docs', '功能手册.html'));
    docsWin.on('closed', () => { docsWin = null; });
  });

  // 拖到她身上的文件（路径在 preload 里换好了）
  // 面板上拖进来的：只回「这几个分别是什么」，怎么用面板自己定
  ipcMain.handle('panel:drop', (_e, paths) => {
    try { return classifyDrop(paths); } catch (err) { log('[drop] 认不出来: ' + err.message); return []; }
  });

  ipcMain.on('drop:files', (_e, paths) => {
    try { routeDrop(Array.isArray(paths) ? paths.map(String) : []); }
    catch (err) { log('[drop] 分流出错: ' + err.message); }
  });

  // 截图浮罩：框好了 / 取消了
  // 哪层浮罩报上来的很关键：它的原点决定了框在哪块屏上（见 doShot）
  ipcMain.on('shot:pick', (e, rect) => {
    doShot(rect || {}, BrowserWindow.fromWebContents(e.sender));
  });
  ipcMain.on('shot:cancel', () => { closeShot(); });

  // 手机工作台：起服务（幂等）并把扫码用的地址给面板
  ipcMain.handle('mobile:info', () => ensureMobile());

  /**
   * 出门模式开关：起/断 cloudflared 隧道。
   * 没装 cloudflared 就先下（几 MB，落在数据目录，不进 C 盘）。
   */
  ipcMain.handle('mobile:tunnel', async (_e, on) => {
    if (!on) {
      if (tunnelHandle) { tunnelHandle.stop(); tunnelHandle = null; log('[tunnel] 出门模式关了'); }
      config.patch({ mobile: { tunnel: false } });
      return { ok: true, url: null };
    }
    const info = await ensureMobile();
    if (!info.ok) return info;
    const token = (loadConfig().mobile || {}).token;
    if (tunnelHandle) return { ok: true, url: tunnelHandle.url + '/?t=' + token };
    try {
      if (!tunnel.installed(DATA_ROOT)) {
        log('[tunnel] 下 cloudflared…');
        send('session:say', { name: '', text: '出门模式要先下个小工具（50 多 MB），第一次慢一点，稍等…' });
        let lastPct = 0;
        await tunnel.install(DATA_ROOT, (pct) => {
          // 每涨 20% 报一次，别把日志刷爆
          if (pct >= lastPct + 20) { lastPct = pct; log('[tunnel] 下到 ' + pct + '%'); }
        }, log);
        log('[tunnel] cloudflared 装好了');
      }
      tunnelHandle = await tunnel.start({ dataRoot: DATA_ROOT, port: info.port, log });
      config.patch({ mobile: { tunnel: true } });
      return { ok: true, url: tunnelHandle.url + '/?t=' + token };
    } catch (err) {
      tunnelHandle = null;
      log('[tunnel] 出门模式没开成: ' + err.message);
      return { ok: false, error: '出门模式没开成：' + err.message };
    }
  });

  // 版本更新：手动查一次 / 下载并安装
  ipcMain.handle('update:check', (_e, src) => checkUpdate(typeof src === 'string' ? src : undefined));
  ipcMain.handle('update:apply', () => applyUpdate());
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
  refreshTrayTip();
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

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(() => {
    fs.mkdirSync(STORE, { recursive: true });
    // 三个月前的流水清一次。启动时来这么一下就够，不用起定时器
    journal.sweep();
    // getTotals 给账本里程碑用（烧满一百刀、聊满一千轮）—— 注入而不是让
    // mood 自己 require：测试环境里 journal 读的是真实数据目录，注入才可控
    // 喂终身账（lifetime.json，读一个小文件）—— 千万别喂 totals()：
    // 那是全量扫 90 个日流水的，里程碑每分钟问一次会把主进程问出卡顿；
    // 而且它是 90 天滚动窗口，「烧满一百刀」的终身语义就不对了（评审抓的）
    mood = new Mood({ storeDir: STORE, getTotals: () => journal.lifetime() });
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
    // 装了 codex 就**开机先把 hook 的信任哈希问了**（本地 app-server，
    // 不调模型不花钱，约 2 秒）。原来是等到第一次派 codex 才问，而那一趟是
    // 异步的 —— 窗口早开出去了，于是升级完第一个 codex 窗口必然撞上
    // 「Hooks need review」，人在外面用手机根本没法点（用户实拍）
    try { if (agents.codexInstalled()) ensureCodexHookHash(); } catch (_) { /* 问不到不影响开机 */ }

    about = aboutStore(path.join(STORE, 'about-you.md'));
    chat = new Chat({
      storeDir: STORE,
      log,
      claudeBin: resolveClaudeBin(),
      getConfig: loadConfig,
      // 把心情接进聊天：她烦躁的时候说出来的话就该不一样
      getMoodDesc: () => (mood ? mood.describe() : ''),
      // 小本子喂回给她 —— 记得才谈得上「自然提起」，也防她重复记
      getAbout: () => about.forPrompt(),
    });
    // 她在回复里附了 <<MEM:...>>（听到了关于他的事）→ 记进小本子。
    // 不额外说话 —— 回复本身已经自然接过话头了，再蹦一句「记下了」很出戏
    chat.on('memory', (t) => {
      const r = about.add(t);
      if (r.ok) log('[about] 记了一条：' + r.text);
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
    startFullscreenWatch();
    startGitWatch();
    registerHotkey();

    // 隔天开场白：开机 12 秒后问一次（让开场那句先说完）。
    // 一直开着跨了天的机器走 presence 那条路（回来的第一眼补问）
    setTimeout(() => { try { tryOpener(); } catch (err) { log('[recap] 开场白没说成: ' + err.message); } }, 12 * 1000);

    // 口头提醒：30 秒查一拍。到点的都冒出来 —— 含桌宠关着时错过的
    // （过点 10 分钟以上算「错过」，措辞不一样）。提醒**穿透安静模式**：
    // 你亲口交代的事，专注中也得喊
    reminders = remindStore(path.join(STORE, 'reminders.json'));
    const remindTimer = setInterval(() => {
      try {
        // 人不在（离开/锁屏）就先压着不消费 —— due() 一取就从盘上删了，
        // 这时候弹的气泡 30 秒就没，回来什么都看不到。压着的话回来的
        // 第一拍照常冒，过点 10 分钟以上自动走「刚才你不在」那句（评审抓的）
        if (awaySince) return;
        for (const r of reminders.due()) {
          const late = Date.now() - r.when > 10 * 60000;
          const say = late ? '呃…这条提醒过点了：' + r.text + '（刚才你不在）'
                           : '到点啦！' + r.text;
          send('greet:say', { say, face: late ? 'panic' : 'excited', hold: 30000 });
          speakLine(say, { important: true, maxLen: 60 });
          log('[remind] 喊了：' + r.text);
        }
      } catch (err) { log('[remind] 查提醒出错: ' + err.message); }
    }, 30 * 1000);
    if (remindTimer.unref) remindTimer.unref();

    // 她写的周记：每周一你在电脑前时写一篇（一周一次、几分钱、写不出拉倒）。
    // 15 分钟查一拍条件，真正动笔在 tryDiary 里
    const diaryTimer = setInterval(() => { tryDiary(); }, 15 * 60 * 1000);
    if (diaryTimer.unref) diaryTimer.unref();
    setTimeout(() => { tryDiary(); }, 90 * 1000); // 开机也查一次（周一早上第一次开机）

    // 收工那句：深夜（23 点后到凌晨 5 点前）你还在敲，她打个哈欠带一句今日总结。
    // 一天一次；quiet / 没干正事 / 人不在，都不说
    const windTimer = setInterval(() => {
      try {
        const h = new Date().getHours();
        if (h < 23 && h >= 5) return;
        if (hushed() || (play && play.busy) || awaySince) return;
        if (dayMarks().windDown === journal.dayKey()) return;
        const r = recap.windDown(journal.today());
        if (!r) return;
        markDay('windDown');
        send('greet:say', { say: r.say, face: r.face, hold: 15000 });
        speakLine(r.say, { maxLen: 80 });
        log('[recap] 收工那句说了');
      } catch (err) { log('[recap] 收工那句没说成: ' + err.message); }
    }, 10 * 60 * 1000);
    if (windTimer.unref) windTimer.unref();

    // 升级后第一次启动：弹一版「这个版本更新了什么」。说明是打包时从 git
    // 提交收集的（release-notes.json 随包带着）。全新安装不弹 —— seenVersion
    // 还是空的说明没有「从哪个版本升上来」这回事，只默默记下当前版本
    try {
      const cur = app.getVersion();
      let seen = (loadConfig().update || {}).seenVersion || '';
      // 存档里没记「上次见过哪版」的（0.1.x 老版本没这个字段、或存档被清过），
      // 用安装器动手前抄的那张条子（data/prev-app-package.json）——
      // 没有这一手，从老版本手动重装上来的人一句说明都看不到
      // 条子在**安装根**的 data 里（exe 旁边）—— 不是 ROOT：打包后 ROOT 是
      // resources/app，差两层，读不到条子弹窗就一声不吭（实机踩的）
      const prevMark = path.join(path.dirname(process.execPath), 'data', 'prev-app-package.json');
      if (!seen) {
        try {
          seen = JSON.parse(fs.readFileSync(prevMark, 'utf8')).version || '';
          if (seen) log('[update] 安装器留的条子：从 v' + seen + ' 升上来的');
        } catch (_) { /* 全新安装没有条子，正常 */ }
      }
      if (seen && seen !== cur) {
        const rn = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-notes.json'), 'utf8'));
        // **跳版也要补显**：从 0.2.0 直接升到 1.0.1 的人，中间每一版的
        // 说明都得让他看到 —— 挑出 seen 到 cur 之间的每一版、新的在前，
        // 每版里再按「新增 → 修复 → 优化」分组（原生弹框排不了版，
        // 开一个独立窗口，样式跟面板一家人）
        const show = updates.notesSince(rn, seen, cur);
        if (show.length) {
          const payload = show.map((h) => {
            const g = { new: [], fix: [], opt: [] };
            for (const n of h.notes) g[updates.classifyNote(n)].push(n);
            return { version: h.version, at: h.at || '', groups: g };
          });
          const nw = new BrowserWindow({
            width: 560, height: 640, minWidth: 460, minHeight: 400,
            title: '更新到 v' + cur, backgroundColor: '#0d0f16',
            autoHideMenuBar: true, icon: iconOr(APP_ICON, undefined),
            webPreferences: { contextIsolation: true, nodeIntegration: false },
          });
          nw.loadFile(path.join(__dirname, 'renderer', 'notes.html'), {
            query: { from: seen, to: cur, data: JSON.stringify(payload) },
          });
        }
      }
      if (seen !== cur) config.patch({ update: { seenVersion: cur } });
      // 条子用过就撕（存档里已经记下了，条子留着会在下次误导）。
      // Program Files 下删不动就随它 —— seenVersion 的优先级在它前面
      try { fs.unlinkSync(prevMark); } catch (_) { /* 没有或删不掉都无妨 */ }
    } catch (_) { /* 没有说明文件就不弹，照常起 */ }

    // 手机工作台开过就一直开 —— 手机书签才随时能用（没开过完全不存在）
    if ((loadConfig().mobile || {}).enabled) ensureMobile();

    // 版本更新：分发开关对齐存档；开机 20 秒后查一次，之后每 4 小时一次
    // （没填更新源的话 checkUpdate 空手就回，一次网络请求都不发）
    syncUpdateServe(loadConfig());
    setTimeout(() => { checkUpdate(); }, 20 * 1000);
    setInterval(() => { checkUpdate(); }, 4 * 60 * 60 * 1000);

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
    // 【每步必须各自兜住。】这里抛出去就是主进程未捕获异常 → Electron
    // 弹原生错误框 → 进程僵在弹窗后面**再也退不掉**。装新版时表现为
    // NSIS 反复喊「WaifuCode 无法关闭」（错误框还常被安装器挡住，
    // 你只看到怎么关都关不掉）—— 实机排查出来的
    const step = (fn) => { try { fn(); } catch (err) { log('[quit] 收尾一步没做成: ' + err.message); } };
    step(() => stopTunnel()); // 出门模式的隧道跟着桌宠一起收 —— 别把公网口留在那儿
    step(() => { if (sessions) sessions.stopAll(); });
    step(() => { if (terminals) terminals.dispose(); });
    step(() => { if (chat) chat.dispose(); });
    step(() => { if (mood) mood.dispose(); });
    step(() => { if (voice) voice.dispose(); });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow();
  });
}
