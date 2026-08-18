'use strict';

// 摸一遍模型运行时到底能改什么。
//
// 「换装」这种需求，能做到哪一步完全取决于两件事：
//   1. 模型里有没有备用素材（看 pose3/Parts 就知道）
//   2. Cubism Core 支不支持**单个部件染色 / 单独隐藏**
//
// 第二条只能在真的加载起来之后问运行时，猜没有意义。这个脚本就是去问的。
//
// ⚠️ **这个脚本骗过我们一次，值得记一笔。**
// 第一版问的是 `setPartOpacity` / `setDrawableMultiplyColor` /
// `getDrawableParentPartIndices` 这几个名字，结论是「全都 ✗，什么都做不了」，
// 还照着写进了开发手册。但 Cubism 4 Framework 里它们真实的名字是
// `setPartOpacityByIndex` / `setPartOpacityById`，部件表在 `coreModel._model.parts` 上 ——
// 名字对不上，`typeof core[name] === 'function'` 当然全是 false。
// **单个部件的隐藏一直是能用的**，白白错过了很久。
//
// 教训：问一个对象「支不支持某功能」时，别只按自己记得的名字问一遍就下结论；
// 下面 methods 那一项会把原型链上**所有**方法名列出来，先看那个再判断。
//
// 想知道「这个模型有哪些部件值得藏」，用 `npm run probe-parts`，
// 那个按顶点几何量得更准，还会告诉你每个部件落在身上哪个位置。

const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const config = require('../src/config');

app.whenReady().then(async () => {
  const mp = config.load().modelPath;
  console.log('模型: ' + mp + '\n');

  const win = new BrowserWindow({
    width: 400, height: 600, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
  });

  const html = `
    <body style="margin:0"><canvas id="c"></canvas>
    <script src="../vendor/live2dcubismcore.min.js"></script>
    <script src="../node_modules/pixi.js/dist/browser/pixi.min.js"></script>
    <script src="../node_modules/pixi-live2d-display/dist/cubism4.min.js"></script>
    <script>
      const { Application, Ticker } = PIXI;
      const { Live2DModel } = PIXI.live2d;
      Live2DModel.registerTicker(Ticker);
      window.__done = false;
      const app = new Application({ view: document.getElementById('c'), width: 400, height: 600, backgroundAlpha: 0 });
      Live2DModel.from(${JSON.stringify('../' + mp.replace(/\\/g, '/'))}, { autoInteract: false })
        .then((m) => { window.__m = m; app.stage.addChild(m); window.__done = true; })
        .catch((e) => { window.__err = e.message; window.__done = true; });
    </script></body>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html), {
    baseURLForDataURL: 'file://' + path.join(__dirname).replace(/\\/g, '/') + '/',
  });

  const err = await win.webContents.executeJavaScript(`
    new Promise((r) => {
      const t = setInterval(() => { if (window.__done) { clearInterval(t); r(window.__err || null); } }, 100);
      setTimeout(() => { clearInterval(t); r('超时'); }, 20000);
    })`);

  if (err) { console.error('加载失败: ' + err); win.destroy(); app.exit(1); return; }

  const info = await win.webContents.executeJavaScript(`
    (() => {
      const m = window.__m;
      const core = m.internalModel.coreModel;
      const proto = Object.getPrototypeOf(core);
      const methods = Object.getOwnPropertyNames(proto).filter((n) => typeof core[n] === 'function');

      // 名字必须跟 framework 里真实的叫法一致，否则问出来全是假的「不支持」
      const want = [
        'setPartOpacityByIndex', 'setPartOpacityById', 'getPartOpacityByIndex',
        'getPartCount', 'getPartId',
        'getDrawableCount', 'getDrawableId', 'getDrawableOpacity',
        'getDrawableVertices', 'getDrawableVertexUvs', 'getDrawableTextureIndex',
        // 乘算色/加算色是 Cubism 4.2 才加的，这套 framework 里大概率没有
        'setMultiplyColorByIndex', 'getMultiplyColor',
        'setScreenColorByIndex', 'getScreenColor',
        'setParameterValueById', 'getParameterIndex',
        'getParameterMaximumValue', 'getParameterMinimumValue',
      ];
      const has = {};
      for (const w of want) has[w] = typeof core[w] === 'function';

      // 部件表和网格归属都在原始 core 对象上，不在 framework 封装上
      const raw = core._model;
      let partIds = [], drawIds = [], parents = null;
      try { partIds = Array.from(raw.parts.ids); } catch (_) {}
      try {
        const n = core.getDrawableCount();
        for (let i = 0; i < n; i++) drawIds.push(core.getDrawableId(i));
      } catch (_) {}
      try { parents = Array.from(raw.drawables.parentPartIndices); } catch (_) {}

      // 真去染一次色，看会不会抛
      let tintWorks = null;
      try {
        if (core.setMultiplyColorByIndex) {
          core.setMultiplyColorByIndex(0, 1.0, 0.5, 0.5, 1.0);
          tintWorks = true;
        } else tintWorks = false;
      } catch (e) { tintWorks = 'throw: ' + e.message; }

      // 部件透明度也试一下 —— 写下去再读回来，不能只看「没抛异常」
      let partWorks = null;
      try {
        if (core.setPartOpacityByIndex) {
          const before = core.getPartOpacityByIndex(0);
          core.setPartOpacityByIndex(0, 0.25);
          partWorks = Math.abs(core.getPartOpacityByIndex(0) - 0.25) < 1e-6;
          core.setPartOpacityByIndex(0, before);
        } else partWorks = false;
      } catch (e) { partWorks = 'throw: ' + e.message; }

      return {
        methods, has, tintWorks, partWorks,
        partCount: partIds.length, drawCount: drawIds.length,
        hasParentMap: Array.isArray(parents) && parents.length > 0,
        samplePartIds: partIds.slice(0, 8),
        sampleDrawIds: drawIds.slice(0, 10),
        rendererType: m.internalModel.renderer ? m.internalModel.renderer.constructor.name : null,
      };
    })()`);

  console.log('部件 ' + info.partCount + ' 个，绘制网格 ' + info.drawCount + ' 个');
  console.log('渲染器: ' + info.rendererType);
  console.log('drawable→part 的归属表: ' + (info.hasParentMap ? '有' : '没有'));
  console.log('');
  console.log('关键能力：');
  for (const [k, v] of Object.entries(info.has)) {
    console.log('  ' + (v ? '✓' : '✗') + ' ' + k);
  }
  console.log('');
  console.log('  单个网格染色实测: ' + info.tintWorks);
  console.log('  单个部件透明度实测: ' + info.partWorks);
  console.log('');
  console.log('部件 id 样例: ' + info.samplePartIds.join(', '));
  console.log('网格 id 样例: ' + info.sampleDrawIds.join(', '));

  win.destroy();
  app.exit(0);
}).catch((e) => { console.error('炸了: ' + e.message); app.exit(1); });
