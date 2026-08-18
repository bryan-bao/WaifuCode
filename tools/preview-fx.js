'use strict';

// 挨个试一遍这个模型自带的特效，看哪个好看。
//
// Mao 是个魔法师，身上带着一整套演出效果 —— 心心、光环、爆炸、烟雾、兔子、
// 墨水、法杖、治愈光。`npm run probe-params` 能量出这些参数**存在**，
// 但量不出**好不好看**、什么时候该用。那个只能眼睛看。
//
// 所以这个工具就一件事：开个窗口，把检测到的特效列出来，你点一个它演一遍。
// 挑中的记下来，再接到情绪上（比如干完活放个治愈光、高兴时冒心心）。
//
// 特效参数的套路是固定的：`ParamXxxOn` 是开关（0/1），`ParamXxx` 是动画进度
// （一般 0~30）。所以「演一遍」= 开关打开 + 进度从头走到尾 + 关掉。
//
// 跑法：
//   npx electron tools/preview-fx.js
//
// 不花钱。窗口会一直开着等你点，看完自己关。

const { app, BrowserWindow } = require('electron');
const path = require('path');

const { PARAM_MAP } = require('../src/renderer/dance');
const config = require('../src/config');

// --model= 只影响这次查看，**不动 config.json**。想看看别的模型身上有什么，
// 不该逼你先把桌宠切过去
const MODEL = (process.argv.find((x) => x.startsWith('--model=')) || '').slice(8);
if (MODEL) process.env.WAIFU_MODEL = MODEL;

// 这些是「正经身体参数」，不是特效，别混进列表里。
//
// **前缀匹配和全词匹配必须分开。** 头一版把五个元音口型（ParamA/I/U/E/O）
// 混在前缀那串里，结果 `ParamA` 这个分支把 **ParamAura** 也吃掉了，
// 同理 `ParamE` 吃掉 ParamExplosion、`ParamI` 吃掉 ParamInk ——
// 八组特效里静静少了三组，一句报错都没有。
const BORING_PREFIX = /^Param(Angle|Body|Eye|Brow|Mouth|Cheek|Breath|Arm|Hand|Leg|Shoulder|Hair|Bust|Skirt|Robe[LR]|Hat(Brim|Top)?|Neck|Ribbon|Wing|String|Accessory|oHair|Face)/;
const BORING_EXACT = /^Param([AIUEO])$/;
const USED = new Set(Object.values(PARAM_MAP).flat());

app.whenReady().then(async () => {
  const mp = MODEL || config.load().modelPath;

  const win = new BrowserWindow({
    width: 900, height: 700, show: true, frame: true, backgroundColor: '#161a26',
    title: '特效预览 · ' + path.basename(mp),
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const ready = await win.webContents.executeJavaScript(`
    new Promise((r) => {
      const t = setInterval(() => {
        if (window.waifuStage && window.waifuStage.model()) { clearInterval(t); r(true); }
      }, 120);
      setTimeout(() => { clearInterval(t); r(false); }, 25000);
    })`);
  if (!ready) { console.error('模型没加载出来'); win.destroy(); app.exit(1); return; }

  const groups = await win.webContents.executeJavaScript(`
    (() => {
      const core = window.waifuStage.model().internalModel.coreModel;
      const ids = core._parameterIds || [];
      const boringPrefix = ${BORING_PREFIX.toString()};
      const boringExact = ${BORING_EXACT.toString()};
      const used = new Set(${JSON.stringify([...USED])});

      // 按「Param 后面第一个大写词」分组：ParamHeartMissOn → Heart，ParamRabbitX → Rabbit
      const g = {};
      for (const id of ids) {
        if (used.has(id) || boringPrefix.test(id) || boringExact.test(id)) continue;
        const m = /^Param([A-Z][a-z]+)/.exec(id);
        if (!m) continue;
        const key = m[1];
        const i = core.getParameterIndex(id);
        (g[key] || (g[key] = [])).push({
          id, lo: core.getParameterMinimumValue(i), hi: core.getParameterMaximumValue(i),
          def: core.getParameterDefaultValue(i),
        });
      }
      // 只留有两个以上参数的组，或者本身范围就很大的（单参数特效）
      const out = {};
      for (const [k, v] of Object.entries(g)) {
        if (v.length >= 2 || v.some((p) => p.hi - p.lo >= 20)) out[k] = v;
      }
      return JSON.stringify(out);
    })()`);

  const parsed = JSON.parse(groups);
  const names = Object.keys(parsed);
  console.log('\n模型: ' + mp);
  if (!names.length) {
    console.log('这个模型身上没有特效参数（Mao 才有那一整套魔法演出）。');
    console.log('换到 Mao 再跑：设置面板 → 形象 → 换模型。');
  } else {
    console.log('检测到 ' + names.length + ' 组特效: ' + names.join('、'));
    console.log('窗口里点一个就演一遍。看完自己关窗口。\n');
  }

  // 把面板和播放逻辑注入到页面里
  await win.webContents.executeJavaScript(`
    (() => {
      const G = ${JSON.stringify(parsed)};
      const core = window.waifuStage.model().internalModel.coreModel;
      const im = window.waifuStage.model().internalModel;

      // 正在按住的参数。特效参数每帧都得写 —— 帧末的 loadParameters
      // 会把 beforeModelUpdate 之后写的全还原掉，只写一次等于没写
      const held = new Map();
      im.on('beforeModelUpdate', () => {
        for (const [id, v] of held) {
          try { core.setParameterValueById(id, v); } catch (_) {}
        }
      });

      const panel = document.createElement('div');
      panel.style.cssText =
        'position:fixed;right:0;top:0;bottom:0;width:280px;overflow:auto;z-index:9999;' +
        'background:rgba(16,20,32,.94);color:#dfe6f5;font:13px/1.7 system-ui;padding:12px;' +
        'border-left:1px solid rgba(120,200,255,.22)';
      panel.innerHTML = '<div style="font-weight:600;margin-bottom:8px">特效预览</div>' +
        '<div style="opacity:.6;font-size:12px;margin-bottom:10px">' +
        '点一下演一遍（1.6 秒）。好看的记下名字，回头接到情绪上。</div>';

      const play = (name) => {
        const ps = G[name];
        // 开关先打开：ParamXxxOn 这类
        const sw = ps.filter((p) => /On$/.test(p.id));
        const anim = ps.filter((p) => !/On$/.test(p.id) && p.hi - p.lo >= 5);
        for (const p of sw) held.set(p.id, p.hi);

        const t0 = performance.now();
        const DUR = 1600;
        const tick = () => {
          const t = (performance.now() - t0) / DUR;
          if (t >= 1) {
            // 收干净，不然下一个特效会叠在这个上面
            for (const p of ps) held.delete(p.id);
            for (const p of ps) { try { core.setParameterValueById(p.id, p.def); } catch (_) {} }
            return;
          }
          for (const p of anim) held.set(p.id, p.lo + (p.hi - p.lo) * t);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };

      for (const name of Object.keys(G)) {
        const b = document.createElement('button');
        b.textContent = name + '  (' + G[name].length + ' 个参数)';
        b.style.cssText =
          'display:block;width:100%;margin:4px 0;padding:7px 10px;text-align:left;' +
          'background:rgba(94,234,212,.12);color:#dfe6f5;border:1px solid rgba(94,234,212,.3);' +
          'border-radius:7px;cursor:pointer;font:13px system-ui';
        b.onmouseenter = () => { b.style.background = 'rgba(94,234,212,.26)'; };
        b.onmouseleave = () => { b.style.background = 'rgba(94,234,212,.12)'; };
        b.onclick = () => { play(name); console.log('[fx] ' + name + ' -> ' +
          G[name].map((p) => p.id).join(', ')); };
        panel.appendChild(b);
      }

      if (!Object.keys(G).length) {
        const d = document.createElement('div');
        d.style.cssText = 'opacity:.7;font-size:12px';
        d.textContent = '这个模型没有特效参数。Mao 才有那一整套魔法演出。';
        panel.appendChild(d);
      }

      document.body.appendChild(panel);
      return true;
    })()`);

  // 页面里 console.log 的东西转到终端上，你点了哪个、用的哪几个参数一目了然
  win.webContents.on('console-message', (_e, _lvl, m) => {
    if (m.startsWith('[fx]')) console.log('  ' + m);
  });

  win.on('closed', () => app.exit(0));
}).catch((e) => { console.error('炸了: ' + (e && e.stack || e)); app.exit(1); });
