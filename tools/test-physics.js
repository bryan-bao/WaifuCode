'use strict';

// 她跳舞的时候，头发和裙子到底有没有跟着甩。
//
// 这是全项目最容易骗过自己的一条：身体参数明明每帧都写进去了，画面上她也确实在动，
// 但头发是塑料的 —— 而且**不会有任何报错**。原因在钩子挂错了地方：
//
//   动作 → afterMotionUpdate → saveParameters → 表情 → 眨眼 → 视线 → 呼吸
//        → physics.evaluate → pose → beforeModelUpdate → update → loadParameters
//
// 挂 beforeModelUpdate 是在**物理下游**，物理这一帧早就算完了，读不到你写的值。
// 所以这个自检不量「参数写进去没有」，而是量**物理的输出**（ParamSkirt 那些）
// 到底摆了多大 —— 那才是头发裙子真正在动的证据。
//
// 顺手还盯住另外两件同样静默的事：参数名写错了能不能发现、藏部件换发型灵不灵。
//
// 要开 Electron（不显示窗口），不花钱，十几秒跑完。

const { app, BrowserWindow } = require('electron');
const path = require('path');

const config = require('../src/config');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

app.whenReady().then(async () => {
  const mp = config.load().modelPath;
  console.log('\n模型: ' + mp);

  const win = new BrowserWindow({
    width: 420, height: 700, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
  });

  const html = `
    <body style="margin:0"><canvas id="c"></canvas>
    <script src="../vendor/live2dcubismcore.min.js"></script>
    <script src="../node_modules/pixi.js/dist/browser/pixi.min.js"></script>
    <script src="../node_modules/pixi-live2d-display/dist/cubism4.min.js"></script>
    <script src="../src/renderer/dance.js"></script>
    <script>
      const { Application, Ticker } = PIXI;
      const { Live2DModel } = PIXI.live2d;
      Live2DModel.registerTicker(Ticker);
      window.__done = false;
      const app = new Application({ view: document.getElementById('c'), width: 420, height: 700, backgroundAlpha: 0 });
      Live2DModel.from(${JSON.stringify('../' + mp.replace(/\\/g, '/'))}, { autoInteract: false })
        .then((m) => {
          window.__m = m;
          m.anchor.set(0.5, 0.5);
          m.position.set(210, 400);
          m.scale.set(700 / m.internalModel.height * 0.9);
          app.stage.addChild(m);
          window.__done = true;
        })
        .catch((e) => { window.__err = e.message; window.__done = true; });

      // 物理的输出参数 —— 量这些才是量「头发裙子有没有在动」。
      // 不写死，从模型自己的 physics3.json 里读：Hiyori 是裙子和缎带，
      // Mao 是长袍和帽檐，写死一套换个模型就全是 0 了。
      window.__loadOut = async (url) => {
        try {
          const r = await fetch(url);
          const j = await r.json();
          const out = new Set();
          for (const s of (j.PhysicsSettings || [])) {
            for (const o of (s.Output || [])) out.add(o.Destination.Id);
          }
          // 每个物理链只取一个代表，太多了列不下
          window.__OUT = Array.from(out).filter((id) => !/Rotation_\\d/.test(id)).slice(0, 6);
        } catch (e) {
          window.__OUT = [];
        }
        return window.__OUT;
      };

      /**
       * 跑一段舞，统计物理输出的摆幅（峰峰值）。
       * mode='new' 走当前代码；mode='old' 把钩子全塞回 beforeModelUpdate，
       * 也就是这次修复之前的行为，用来做对照。
       */
      window.__measure = (mode, seconds) => new Promise((resolve) => {
        const m = window.__m;
        const im = m.internalModel;
        const core = im.coreModel;

        const d = new window.WaifuDancer(m, () => {});
        if (mode === 'old') {
          // 对照组：连物理输入也拖到 beforeModelUpdate 去写（物理下游）
          d._hook = function () {
            if (this.hooked) return;
            im.on('beforeModelUpdate', () => { this._frame(); if (this._live) this._write(false); });
            this.hooked = true;
          };
        }

        const seen = {};
        for (const p of window.__OUT) seen[p] = { min: Infinity, max: -Infinity };

        // 在 beforeModelUpdate 里读 —— 这时候 physics.evaluate 已经跑完了，
        // 读到的就是物理这一帧算出来的结果
        const sample = () => {
          for (const p of window.__OUT) {
            let v = 0;
            try { v = core.getParameterValueById(p); } catch (_) { continue; }
            if (typeof v !== 'number' || !isFinite(v)) continue;
            if (v < seen[p].min) seen[p].min = v;
            if (v > seen[p].max) seen[p].max = v;
          }
        };
        im.on('beforeModelUpdate', sample);

        d.start({ bpm: 128, steps: ['swing', 'sway'], amp: 1.2 });

        setTimeout(() => {
          d.stop();
          const out = {};
          for (const p of window.__OUT) {
            out[p] = seen[p].max > seen[p].min ? +(seen[p].max - seen[p].min).toFixed(3) : 0;
          }
          resolve(out);
        }, seconds * 1000);
      });
    </script></body>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html), {
    baseURLForDataURL: 'file://' + path.join(__dirname).replace(/\\/g, '/') + '/',
  });

  const err = await win.webContents.executeJavaScript(`
    new Promise((r) => {
      const t = setInterval(() => { if (window.__done) { clearInterval(t); r(window.__err || null); } }, 100);
      setTimeout(() => { clearInterval(t); r('超时'); }, 20000);
    })`);
  if (err) { console.error('模型加载失败: ' + err); win.destroy(); app.exit(1); return; }

  await new Promise((r) => setTimeout(r, 800));

  const physUrl = '../' + mp.replace(/\\/g, '/').replace(/\.model3\.json$/, '.physics3.json');
  const outs = await win.webContents.executeJavaScript(
    'window.__loadOut(' + JSON.stringify(physUrl) + ')');
  console.log('这个模型的物理输出: ' + (outs.length ? outs.join(', ') : '（没读到）'));

  // --- 1. 参数名写错了能不能发现 -------------------------------------------
  console.log('\n[1] 参数名写错了要发现得了');
  const probe = await win.webContents.executeJavaScript(`
    (() => {
      const core = window.__m.internalModel.coreModel;
      const fake = 'ParamThisDoesNotExist';
      return {
        idxOfFake: core.getParameterIndex(fake),   // 这个函数会现编一个下标出来
        total: core.getParameterCount(),
        hasReal: !!(core._parameterIds && core._parameterIds.includes('ParamAngleZ')),
        hasFake: !!(core._parameterIds && core._parameterIds.includes(fake)),
        // 手臂在不同模型上叫法不同（Hiyori: ParamArmLA，Mao: ParamArmLA01），
        // 备选名机制修好之前，后面那些候选一个都轮不到
        armFound: ['ParamArmLA', 'ParamArmL', 'ParamArmLA01']
          .find((n) => core._parameterIds.includes(n)) || null,
      };
    })()`);

  console.log('    getParameterIndex(瞎编的名字) = ' + probe.idxOfFake +
              '，而参数总数是 ' + probe.total + ' —— 它不返回 -1，是现编的');
  check(probe.idxOfFake >= 0, '证实了 idx >= 0 这个判据恒真（所以不能用它）');
  check(probe.hasReal === true, '_parameterIds 认得出真参数 ParamAngleZ');
  check(probe.hasFake === false, '_parameterIds 认得出假参数（这才是能用的判据）');
  check(probe.armFound !== null,
        '手臂参数在 PARAM_MAP 的备选名里找得到（这个模型上叫 ' + probe.armFound + '）');

  // --- 2. 开合量的行程换算 --------------------------------------------------
  console.log('\n[2] 开合量按模型的真实范围换算');
  const scale = await win.webContents.executeJavaScript(`
    (() => {
      const d = new window.WaifuDancer(window.__m, () => {});
      const core = window.__m.internalModel.coreModel;
      const rng = (id) => {
        if (!id) return null;
        const i = core.getParameterIndex(id);
        return [core.getParameterMinimumValue(i), core.getParameterMaximumValue(i)];
      };
      return { scale: d.scale, available: d.available,
               armRange: rng(d.available.armL), breathRange: rng('ParamBreath') };
    })()`);
  console.log('    编舞能驱动的部位: ' + Object.keys(scale.available).join(', '));
  console.log('    ' + scale.available.armL + ' 的实际范围是 ' + JSON.stringify(scale.armRange) +
              '，ParamBreath 是 ' + JSON.stringify(scale.breathRange));
  check(scale.scale.armL > 3, '手臂按行程放大了（×' + (scale.scale.armL || 0).toFixed(1) +
        '），舞步里那句 armL:0.8 才真的抬得起手');
  check(Math.abs((scale.scale.breath || 1) - 1) < 0.01, '呼吸本来就是 0~1，没有被乱缩放');

  // --- 3. 正题：跳舞时头发裙子到底动没动 -------------------------------------
  console.log('\n[3] 跳舞时物理有没有被驱动（这是本文件存在的理由）');
  console.log('    量的是物理的输出参数，跑 3 秒 swing+sway，128 BPM');

  const before = await win.webContents.executeJavaScript('window.__measure("old", 3)');
  await new Promise((r) => setTimeout(r, 1200)); // 等上一组收干净
  const after = await win.webContents.executeJavaScript('window.__measure("new", 3)');

  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  console.log('');
  console.log('    参数              修之前    修之后');
  for (const k of Object.keys(after)) {
    console.log('    ' + k.padEnd(18) + String(before[k]).padStart(6) + '    ' + String(after[k]).padStart(6));
  }
  console.log('    ' + '合计'.padEnd(17) + String(sum(before).toFixed(3)).padStart(6) +
              '    ' + String(sum(after).toFixed(3)).padStart(6));
  console.log('');

  check(sum(before) < 1.2, '修之前物理几乎没被驱动（合计 ' + sum(before).toFixed(3) + '，基本是死的）');
  check(sum(after) > Math.max(0.15, sum(before) * 2), '修之后明显动起来了（涨了 ' +
        (sum(before) > 0.001 ? (sum(after) / sum(before)).toFixed(1) : '∞') + ' 倍）');

  // --- 4. 藏部件换造型 -------------------------------------------------------
  console.log('\n[4] 藏几个部件换身打扮');
  const { profileFor } = require('../src/profiles');
  const styles = profileFor(mp).hairStyles || {};
  const wanted = Array.from(new Set(Object.values(styles).flatMap((s) => s.hide || [])));

  const hair = await win.webContents.executeJavaScript(`
    (() => {
      const core = window.__m.internalModel.coreModel;
      const ids = Array.from(core._model.parts.ids);
      const want = ${JSON.stringify(wanted)};
      const missing = want.filter((w) => !ids.includes(w));
      const idx = want.length ? ids.indexOf(want[0]) : -1;
      let hidden = null, restored = null;
      if (idx >= 0) {
        core.setPartOpacityByIndex(idx, 0);
        hidden = core.getPartOpacityByIndex(idx);
        core.setPartOpacityByIndex(idx, 1);
        restored = core.getPartOpacityByIndex(idx);
      }
      // pose3 成组的那些部件绝不能无条件写 1，这里确认它们确实存在
      const posed = ids.filter((s) => /Arm(L|R)?[AB]$/.test(s));
      return { total: ids.length, missing, hidden, restored, posed };
    })()`);

  if (!wanted.length) {
    console.log('    这个模型在 profiles.js 里还没配 hairStyles，跳过');
  } else {
    check(hair.missing.length === 0,
          'profiles.js 里列的 ' + wanted.length + ' 个部件在模型里全找得到' +
          (hair.missing.length ? '（少了 ' + hair.missing.join(', ') + '）' : ''));
    check(hair.hidden === 0, '藏得掉（透明度写 0 生效）');
    check(hair.restored === 1, '也放得回来');
    check(hair.posed.length > 0,
          'pose3 管的部件在这儿: ' + hair.posed.join(', ') +
          ' —— 所以绝不能无条件把别的部件写成 1（会多长条胳膊）');
  }

  win.destroy();
  console.log('');
  console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
  app.exit(bad === 0 ? 0 : 1);
}).catch((e) => {
  console.error('炸了: ' + (e && e.stack || e));
  app.exit(1);
});
