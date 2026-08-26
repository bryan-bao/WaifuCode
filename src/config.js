'use strict';

const fs = require('fs');
const path = require('path');

const { APP_ROOT, DATA_ROOT } = require('./paths');

const ROOT = APP_ROOT;
// 配置是**要写的**，所以跟着数据走，不跟着安装目录走。
// 装到 Program Files 底下时安装目录只读，写在那儿等于设置永远存不下来 ——
// 而且 patch() 的写失败一路冒到上层才被吞，表现是「改了保存，重启又变回去」
const FILE = path.join(DATA_ROOT, 'config.json');

// 默认人设。写在这儿而不是散在各处 —— 后面的情感系统还要接着往上长，
// 「她是谁」这件事必须只有一个出处。
const DEFAULT_PERSONA = {
  name: '小依',
  text:
    '你是我的桌面助手小依，一个住在我电脑右下角的二次元女孩。\n' +
    '说话短、自然、口语化，像朋友聊天，不要长篇大论，一般一两句话就够。\n' +
    '偶尔会撒娇、会吐槽、会催我早点睡。你懂编程，但闲聊时别老扯技术。',
};

const DEFAULTS = {
  modelPath: 'models/Hiyori/Hiyori.model3.json',

  voice: {
    enabled: true,
    voiceName: 'zh-CN-XiaoyiNeural',
    rate: '+8%',
    pitch: '+12Hz',
    volume: 0.9,
  },

  /**
   * 派活时给 claude 的权限模式。
   *
   * auto —— 让它自己用分类器判断：安全的放行，危险的拦下。
   * 比 acceptEdits 聪明（那个只自动放行文件编辑，跑个命令照样卡住），
   * 又比 bypassPermissions 安全得多（那个等于把整台机器交出去）。
   * 规则可以用 `claude auto-mode config` 看、`claude auto-mode critique` 让它帮你审。
   *
   * 想改回去：acceptEdits / dontAsk / plan / manual 都是合法值。
   */
  dispatch: {
    permissionMode: 'auto',
    // 派活用哪个模型。空 = 跟 Claude Code 自己的设置走。
    // 面板上选一次就记住（后台干 / 开终端两条路都用它）
    model: '',
    // 派活用哪个 CLI：claude / codex。给没装 Claude、装了 Codex 的机器用的。
    // codex 的线只有窗口管理（开/关/再来），汇报、护栏、金额那套靠的是
    // claude 的 hook，codex 没有 —— 面板上会标出来
    agent: 'claude',
  },

  // 派活面板的皮肤。deep 深空（默认）/ mecha 机甲 / moe 软萌 / minimal 简约，
  // 面板头部那个下拉换，换完就记住
  panel: {
    theme: 'deep',
  },

  // 全局快捷键。派活是最高频的动作，不该每次都去桌面上找她双击。
  // 抢不到（被别的软件占了）就安静跳过，只在日志里留一行。
  // 想关掉就设成空字符串。
  hotkey: {
    panel: 'CommandOrControl+Alt+W',
    // 截图**默认不占键**：全局快捷键跟别的软件撞是家常便饭（实机就撞了），
    // 而撞了之后按下去毫无反应，用户只会以为功能坏了。留空 = 不挂，
    // 让人在设置里按一个自己确定没被占的组合（右键菜单里也能截，不设也能用）
    shot: '',
    // 剪贴板求助键（复制了报错按一下，她拿去看）。同截图：默认不占键
    clip: '',
  },

  // 开终端用哪个壳。auto = 有 Windows Terminal 就用它，没有才回落到
  // 老式控制台（就是那个灰白窗口）。
  terminal: {
    app: 'auto', // auto | wt | conhost
    theme: 'dark',
    permissionMode: 'auto', // 终端里有你盯着，同样交给分类器判断
  },

  // 终端任务的「监督」：她盯着你开出去的终端，阶段性汇报进度
  supervise: {
    enabled: true,
    speak: true,       // 用语音播报（关掉就只弹气泡）
    minGapSec: 20,     // 两次播报之间至少隔这么久，免得她碎碎念
    /**
     * 她动手之前扫一眼「干的事对不对」：要改的文件跑到项目外面去了、
     * 一轮里整份重写太多文件、要跑 rm -rf / git reset --hard 这类回不来的命令。
     *
     * 命中就转过来喊你 —— **只喊不拦**，她该干还是会干，你自己按 Ctrl+C 决定。
     * 纯本地判断，一分钱不花。规则刻意窄，`rm -rf node_modules` 这种不吭声。
     *
     * 这条报警**不受上面 speak 管**：那个开关的意思是「每做完一段别念了，太吵」，
     * 而这个是你必须知道的事。整个不想要就把 guard 关掉。
     */
    guard: true,
  },

  /**
   * 外观。
   *
   * 说明一下「换衣服」能到哪一步（这段结论是实测出来的，不是猜的）：
   *
   * · **换不了衣服款式** —— 三个模型的衣服全塞在同一个 PartBody 部件里，
   *   pose3 的可切换组只有手臂 A/B。素材里没有第二条裙子，代码补不出来。
   * · **单个部件的透明度是能改的**（`setPartOpacityByIndex`）。所以「把马尾
   *   放下来」这种造型变化不用任何新素材，见 profiles.js 的 hairStyles。
   *   早先以为这条不行，是因为当年探测时问的是 `setPartOpacity` 这个不存在
   *   的名字 —— 名字对不上，自然全是「不支持」。
   * · **单个网格实时染色确实不行** —— `setMultiplyColorByIndex` 是 Cubism 4.2
   *   才加的，而 pixi-live2d-display 0.4.0 打包的 framework 比那个早，
   *   且版本被 PixiJS 6 锁死升不了。
   */
  look: {
    tint: 'none',      // none | warm | cool | night | vivid | faded
    preset: 'default', // 眼神预设，见 src/renderer/look.js
    hair: 'normal',    // 发型，见 src/profiles.js 的 hairStyles
    // 预设之上的微调，都是 -1~1 或 0~1
    smile: 0,          // 笑眼程度
    cheek: 0,          // 脸红浓淡
    brow: 0,           // 眉毛上下（正数扬眉，负数垂眉）
    browAngle: 0,      // 眉角（正数挑眉）
    eyeX: 0,           // 瞳孔左右偏
    eyeY: 0,           // 瞳孔上下偏
    scale: 1,          // 她的大小（0.6~1.6）。改的是整个窗口的尺寸，主进程处理
  },

  // 版本更新（局域网分发，没有服务器）。source：去哪儿查新版（发包那台机器
  // 的地址，如 192.168.1.5:47200；空 = 从不查）；serve：把本机当分发点
  // （发包的那台才开，安装包丢 data\updates）；announced：她已经喊过的
  // 版本号 —— 同一个新版只喊一次，别每 4 小时唠叨一遍
  update: {
    source: '',
    serve: false,
    port: 47200,
    announced: '',
    seenVersion: '',   // 弹过「这版更新了什么」的版本 —— 升级后第一次启动才弹
  },

  // 手机工作台：面板扫码进的手机页（派活 + 实时进度 + 放行）。
  // enabled 由面板「手机」按钮第一次点开时置真并持久 —— 之后开机自动起，
  // 手机书签才一直能用。token 第一次起服务时生成
  mobile: {
    enabled: false,
    port: 47201,
    token: '',
    // 出门模式：把手机工作台临时暴露到公网（cloudflared 免费隧道）。
    // **不持久开**：每次开桌宠都要手动点，网址也每次不一样 ——
    // 一直挂在公网上不是这个功能该有的样子
    tunnel: false,
  },

  // 情绪动作：心情一变就配个身体动作，不光是换张脸
  gesture: {
    enabled: true,
    marks: true,   // 情绪符号：头顶冒 💢/💧/❓…（小尺寸下最好读的情绪信号）
    minGapSec: 8, // 两个动作之间至少隔这么久，免得她一直抽搐
  },

  persona: DEFAULT_PERSONA,
};

/**
 * 读一个 JSON 文件，顺手把 BOM 摘掉。
 *
 * **这不是洁癖，是踩出来的。** UTF-8 的 BOM（`EF BB BF`）在 `readFileSync(f,'utf8')`
 * 里会变成开头一个 `﻿` 字符，而 `JSON.parse` 见了它直接抛错。
 * 底下那个 `catch` 一接住，整个配置**静默退回默认值** —— 不报错、不警告，
 * 你只会发现「我设置好好保存的东西，重启全没了」。
 *
 * 这个文件是明说了给人手改的，而 Windows 上一堆东西默认写带 BOM 的 UTF-8：
 * 记事本选「UTF-8 with BOM」、PowerShell 5.1 的 `Set-Content -Encoding utf8`、
 * VS Code 手滑选错编码。实测撞过一次：拿 PowerShell 改了下存档，
 * 结果加载出来全是默认值，找了半天才发现是这三个字节。
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 存档里记的那套贴图，摊平成「第几张换成哪个 url」。
 *
 * 两种形态都收：
 *   · 一张 png   → 只换第 0 张（老写法，Mao 的翡翠长袍就是这么一张图）
 *   · 一个目录   → 里面的 `texture_NN.png` 按号对位，目录里没有的那号保持原装
 *
 * 目录这条是给「换皮模型」用的 —— 同一个 moc3 换一身配色，动的往往是好几张图
 * （海梦九张里六张不一样）。以前只能换第 0 张，等于头发变了衣服没变。
 *
 * 放在这儿而不是 main.js：渲染层的替身（tools/mock-preload.js）和自检也要用同一份，
 * 各抄一遍的话哪天改坏了自检还是绿的。
 */
function atlasUrls(file) {
  if (!file) return [];
  const url = (p) => 'file:///' + p.replace(/\\/g, '/');
  let names = [];
  try {
    if (!fs.statSync(file).isDirectory()) return [url(file)];
    names = fs.readdirSync(file);
  } catch (_) { return []; }   // 皮肤被删了/盘没挂上 —— 当没设过，别把她的贴图弄坏

  const out = [];
  for (const f of names) {
    const m = /^texture_(\d+)\.png$/i.exec(f);
    if (m) out[Number(m[1])] = url(path.join(file, f));
  }
  // 空洞填成 null：稀疏数组过 IPC 不保准，而渲染层靠「这格是空的」判断保持原装
  return Array.from(out, (u) => u || null);
}

// 只补缺失的键，不覆盖用户已经写过的值
function fillDefaults(target, defaults) {
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(defaults)) {
    if (isPlainObject(v)) out[k] = fillDefaults(out[k], v);
    else if (out[k] === undefined) out[k] = v;
  }
  return out;
}

function load() {
  let raw = {};
  try {
    raw = readJson(FILE);
  } catch (_) {
    /* 没有配置文件、或者被改坏了，都退回默认值，不能因此起不来 */
  }
  return fillDefaults(raw, DEFAULTS);
}

/**
 * 把改动合并回磁盘。
 *
 * 用「读-合并-写」而不是直接写整个对象：这个文件用户会手动编辑，
 * 把他写的别的东西冲掉是很讨厌的事。
 */
function patch(changes) {
  let raw = {};
  try {
    raw = readJson(FILE);
  } catch (_) {
    /* 同上 */
  }
  const merged = deepMerge(isPlainObject(raw) ? raw : {}, changes);
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return fillDefaults(merged, DEFAULTS);
}

function deepMerge(base, changes) {
  const out = { ...base };
  for (const [k, v] of Object.entries(changes || {})) {
    if (isPlainObject(v)) out[k] = deepMerge(isPlainObject(out[k]) ? out[k] : {}, v);
    else out[k] = v;
  }
  return out;
}

module.exports = { load, patch, atlasUrls, FILE, ROOT, DEFAULTS, DEFAULT_PERSONA };
