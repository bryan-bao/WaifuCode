'use strict';

// 给气泡预览用的假 window.waifu。
//
// stage.js 一起来就要调 waifu.getConfig()、waifu.on() 这些，
// 没有主进程撑着它就直接报错退出。这里塞一份最小的替身，
// 让渲染层能独立跑起来，好把气泡截出来看看长什么样。

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { profileFor } = require(path.join(ROOT, 'src', 'profiles'));
const config = require(path.join(ROOT, 'src', 'config'));

const cfg = config.load();
const handlers = {};

// 跟真的 pet:get-config 一样，把存档里那套贴图摊平成按贴图号排的 url
// （摊平用的是 config.atlasUrls 本人，不是抄一份）。**这个字段不能糊过去** ——
// 渲染层原来直接读 look.atlas（那是按模型分的一张表），于是开机永远退回原装、
// 一句提示都没有；替身这儿要是也没有，自检就永远看不见这个坑。
function mockAtlas(modelPath) {
  const a = (cfg.look || {}).atlas;
  return config.atlasUrls(typeof a === 'string' ? a : (a || {})[modelPath]);
}

// 设置页要的那几样。预览只看长相，所以保存之类的都是空转。
function fakeMeta() {
  const fs = require('fs');
  const models = [];
  try {
    for (const sub of fs.readdirSync(path.join(ROOT, 'models'))) {
      const d = path.join(ROOT, 'models', sub);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.model3.json')) {
          const rel = 'models/' + sub + '/' + f;
          models.push({ name: profileFor(rel).name || sub, path: rel });
        }
      }
    }
  } catch (_) { /* 没有就空着 */ }

  return {
    models,
    voices: [
      { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 年轻女声，活泼' },
      { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声，温柔' },
      { id: 'zh-CN-YunxiNeural', label: '云希 · 男声，年轻' },
    ],
    permissionModes: [
      { id: 'auto', label: 'auto · 她自己判断，安全放行危险拦下（推荐）' },
      { id: 'acceptEdits', label: 'acceptEdits · 只自动放行文件编辑' },
      { id: 'manual', label: 'manual · 每一步都问你' },
    ],
    terminalApps: [
      { id: 'auto', label: '自动 · 有 Windows Terminal 就用它' },
      { id: 'conhost', label: '老式控制台 · 就是那个灰白窗口' },
    ],
    tints: [
      { id: 'none', label: '原色' }, { id: 'warm', label: '暖调' },
      { id: 'cool', label: '冷调' }, { id: 'night', label: '夜间' },
      { id: 'vivid', label: '鲜艳' }, { id: 'faded', label: '淡雅' },
    ],
    presets: [
      { id: 'default', label: '原样' }, { id: 'gentle', label: '温柔' },
      { id: 'bright', label: '精神' }, { id: 'sleepyEyes', label: '慵懒' },
      { id: 'tsundere', label: '傲娇' }, { id: 'cool', label: '清冷' },
    ],
  };
}

contextBridge.exposeInMainWorld('waifu', {
  // 字段要跟真的 pet:get-config 对齐 —— 少一个 look，眼神预设在预览里就不生效，
  // 那样「预览」预览的就不是真实效果了
  getConfig: async () => ({
    // WAIFU_MODEL 能临时指定看哪个模型，**不动你 config.json 里的设置**。
    // 探针和预览工具用它 —— 想看看 Mao 身上有什么，不该逼你先把桌宠切过去
    modelPath: process.env.WAIFU_MODEL || cfg.modelPath,
    profile: profileFor(process.env.WAIFU_MODEL || cfg.modelPath),
    look: cfg.look || {},
    gesture: cfg.gesture || {},
    atlas: mockAtlas(process.env.WAIFU_MODEL || cfg.modelPath),
  }),

  getSettings: async () => ({ config: cfg, meta: fakeMeta() }),
  saveSettings: async () => ({ ok: true }),
  previewLook: () => {},
  tryVoice: async () => ({ ok: true }),
  closeSettings: () => {},
  on: (channel, cb) => { handlers[channel] = cb; },
  // 穿透状态转给主进程记着，测试要靠它判断「这会儿点得到点不到」
  setClickThrough: (v) => ipcRenderer.send('mock-through', Boolean(v)),
  openSettings: () => ipcRenderer.send('mock-open-settings'),
  drag: (dx, dy) => ipcRenderer.send('mock-drag', { dx, dy }),
  interact: (kind) => ipcRenderer.send('mock-interact', kind),
  // 这几个是后加的。**preload 里加了什么，这儿就得跟着加** ——
  // stage.js 一调到不存在的方法就当场抛错，而它是在 mousemove 里调的，
  // 表现出来是「预览窗口好好的，鼠标一动整个渲染层就死了」，很难查。
  // 转发回主进程是给 test-stage.js 断言用的（比如「拖一次只该喊一声」）。
  react: (kind) => ipcRenderer.send('mock-react', kind),
  openChatWith: (text) => ipcRenderer.send('mock-chat-with', text),
  // 她汇报干活时点气泡走的是这条：调出那个终端看现场
  focusTerminal: (id) => ipcRenderer.send('mock-focus-term', id),
  openPanel: () => {},
  contextMenu: () => {},
  acceptOffer: () => {},
  dropFiles: () => {},
  declineOffer: () => {},
  choose: (id) => ipcRenderer.send('mock-choose', id),
  // 唱歌时后台听出真实 BPM 会回调这个。少了它，放歌那条路一测出拍子就当场抛
  rememberBpm: () => {},
  startPlay: () => {},
  stopPlay: () => {},
});

// 主进程那边偶尔要直接发事件进来
ipcRenderer.on('mock', (_e, { channel, payload }) => {
  if (handlers[channel]) handlers[channel](payload);
});

// 注意：这里**不能**再架一座桥去调 window.waifuStage。
// contextIsolation 开着的时候，preload 和页面是两个隔离的世界 ——
// preload 里的 window 看不见 stage.js 在页面主世界里挂上的 waifuStage。
// 主进程直接用 executeJavaScript 就行，那个跑在主世界里。
