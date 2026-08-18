'use strict';

// 这个模型身上有哪些**参数**、每个参数真的能动多少东西、我们用了几个。
//
// 「她的动作能做到多拟人」这件事，上限完全由模型作者暴露了哪些参数决定 ——
// 但参数名和它实际管的东西经常对不上号，光看名字猜必然猜错。得去问模型自己。
//
// 做法跟 probe-parts 一样是**读顶点**，不截图：
// 把参数推到最小、算一次、记下所有网格的顶点；再推到最大、算一次、再记一次；
// 两次一减就知道这个参数到底掀动了哪些网格、掀了多远。
//
// 关键在于**两次采样放在同一个同步块里**（中间不过帧）。probe-parts 的头注释里
// 记着截图差分翻车的两个原因：藏过的部件没还原、物理和待机动作一直在动。
// 不过帧就没这些事 —— 谁都插不进来，量到的纯粹是这一个参数的效果。
//
// ---------------------------------------------------------------------------
// 顶点探针有个盲区，必须知道：**它只看得见「东西挪没挪位置」。**
//
// 改颜色、改透明度的参数它一个都量不到 —— 顶点纹丝不动，但画面完全变了。
// Mao 身上一堆 `Param*Color*` / `Param*On` 就是这类，头一遍全被误判成「没效果」。
// 而 `ParamAllColor1/2` 恰恰是**整体换配色**的开关，是「换装」最值钱的东西。
//
// 所以有第二遍：`--color` 会去截图差分。截图差分本身有个大坑 ——
// 她一直在呼吸眨眼、物理一直在摆，实测噪声底 6%，信号完全淹在里面。
// 解法是**把整套参数每帧全冻住**，只放开被测的那一个，噪声底就降到 0。
// 只冻被测参数是不够的：眨眼、呼吸、物理输出全都是参数。
// ---------------------------------------------------------------------------
//
// 跑法：
//   npx electron tools/probe-params.js            量的是 config 里当前那个模型
//   npx electron tools/probe-params.js --all      连没效果的也列出来
//   npx electron tools/probe-params.js --color    对「没效果」的那批再做截图差分
//
// 不花钱，几秒钟（--color 会慢一些，每个参数要拍两张）。

const { app, BrowserWindow } = require('electron');
const path = require('path');

const config = require('../src/config');

// --model= 只影响这次查看，**不动 config.json**。想看看别的模型身上有什么，
// 不该逼你先把桌宠切过去
const MODEL = (process.argv.find((x) => x.startsWith('--model=')) || '').slice(8);
if (MODEL) process.env.WAIFU_MODEL = MODEL;
const { PARAM_MAP } = require('../src/renderer/dance');

const has = (name) => process.argv.includes('--' + name);

// dance.js 现在真正会去驱动的那些名字（每个槽位按顺序试，命中第一个存在的）
const USED = new Set(Object.values(PARAM_MAP).flat());

app.whenReady().then(async () => {
  const mp = MODEL || config.load().modelPath;

  // 直接开真正的舞台页面，用它已经加载好的那个模型 —— 省一次加载，
  // 而且量到的就是桌宠实际在跑的东西，不会出现「探针里是这样、跑起来不是」
  const win = new BrowserWindow({
    width: 480, height: 640, show: has('color'), frame: false, backgroundColor: '#202030',
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

  const out = await win.webContents.executeJavaScript(`
    (() => {
      const im = window.waifuStage.model().internalModel;
      const core = im.coreModel;
      const raw = core._model;
      const ids = core._parameterIds || [];
      const n = core.getDrawableCount();
      const partIds = Array.from(raw.parts.ids);
      const parent = Array.from(raw.drawables.parentPartIndices);

      // 待机动作和物理会在帧里改参数，先让它们别插手。
      // 就算停不干净也没关系 —— 下面两次采样中间不过帧，它们没有机会跑
      try { im.motionManager.stopAllMotions(); } catch (_) {}

      // 整个人有多大，用来把位移换算成「身高的百分之几」
      const snap = () => {
        const out = [];
        for (let i = 0; i < n; i++) {
          let v = null;
          try { v = core.getDrawableVertices(i); } catch (_) {}
          out.push(v ? Float32Array.from(v) : null);
        }
        return out;
      };

      core.update();
      const base = snap();
      let Y0 = Infinity, Y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = base[i];
        if (!v || core.getDrawableOpacity(i) <= 0.02) continue;
        for (let k = 1; k < v.length; k += 2) {
          if (v[k] < Y0) Y0 = v[k];
          if (v[k] > Y1) Y1 = v[k];
        }
      }
      const height = (isFinite(Y0) && Y1 > Y0) ? (Y1 - Y0) : 1;

      const rows = [];
      for (let p = 0; p < ids.length; p++) {
        const id = ids[p];
        const def = core.getParameterDefaultValue(p);
        const lo = core.getParameterMinimumValue(p);
        const hi = core.getParameterMaximumValue(p);

        // 两头各算一次。中间不 return、不 await、不过帧
        core.setParameterValueByIndex(p, lo); core.update();
        const A = snap();
        core.setParameterValueByIndex(p, hi); core.update();
        const B = snap();
        core.setParameterValueByIndex(p, def); core.update();

        let moved = 0, worst = 0, worstPart = -1;
        const parts = new Set();
        for (let i = 0; i < n; i++) {
          const a = A[i], b = B[i];
          if (!a || !b || a.length !== b.length) continue;
          let d = 0;
          for (let k = 0; k < a.length; k++) {
            const t = Math.abs(a[k] - b[k]);
            if (t > d) d = t;
          }
          if (d > height * 0.002) {           // 小于身高千分之二当没动
            moved++;
            parts.add(parent[i]);
            if (d > worst) { worst = d; worstPart = parent[i]; }
          }
        }

        rows.push({
          id, lo: +lo.toFixed(1), hi: +hi.toFixed(1), def: +def.toFixed(1),
          meshes: moved,
          travel: +(worst / height * 100).toFixed(1),   // 最远掀了身高的百分之几
          part: worstPart >= 0 ? partIds[worstPart] : '',
          parts: parts.size,
        });
      }
      return JSON.stringify({ rows, total: ids.length, drawables: n });
    })()`);

  const { rows, total, drawables } = JSON.parse(out);

  // 第二遍：顶点没动的那批，去截图看看画面变不变（改颜色/改透明度的参数）
  let colorHits = new Map();
  if (has('color')) {
    const suspects = rows.filter((r) => r.meshes === 0).map((r) => r.id);
    console.log('\n第二遍：对 ' + suspects.length + ' 个「顶点没动」的参数做截图差分…');

    await win.webContents.executeJavaScript(`
      const im = window.waifuStage.model().internalModel;
      const core = im.coreModel;
      const ids = core._parameterIds || [];
      const frozen = ids.map((_, i) => core.getParameterValueByIndex(i));
      window.__pin = null;
      // 整套参数每帧全冻住，只放开被测的那个。不这么干的话，
      // 她的呼吸眨眼物理会把噪声底顶到 6%，什么都测不出来
      im.on('beforeModelUpdate', () => {
        for (let i = 0; i < ids.length; i++) {
          try { core.setParameterValueByIndex(i, frozen[i]); } catch (_) {}
        }
        if (window.__pin) {
          try { core.setParameterValueById(window.__pin.id, window.__pin.v); } catch (_) {}
        }
      });
      true;`);

    const shoot = async () => {
      await new Promise((r) => setTimeout(r, 420));
      return (await win.capturePage()).toBitmap();
    };
    const diff = (a, b) => {
      let n = 0;
      const len = Math.min(a.length, b.length);
      for (let i = 0; i < len; i += 4) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) +
            Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
      }
      return n / (len / 4) * 100;
    };

    const noise = diff(await shoot(), await shoot());
    for (const id of suspects) {
      const r = rows.find((x) => x.id === id);
      await win.webContents.executeJavaScript(
        `window.__pin = { id: ${JSON.stringify(id)}, v: ${r.lo} }; true;`);
      const A = await shoot();
      await win.webContents.executeJavaScript(
        `window.__pin = { id: ${JSON.stringify(id)}, v: ${r.hi} }; true;`);
      const B = await shoot();
      const d = diff(A, B);
      if (d > Math.max(noise * 3, 0.25)) colorHits.set(id, +d.toFixed(2));
    }
    console.log('  噪声底 ' + noise.toFixed(2) + '%，量出 ' + colorHits.size + ' 个真的改画面的');
  }

  win.destroy();

  const live = rows.filter((r) => r.meshes > 0);
  const dead = rows.filter((r) => r.meshes === 0);
  const used = live.filter((r) => USED.has(r.id));
  const idle = live.filter((r) => !USED.has(r.id));

  console.log('\n模型: ' + mp);
  console.log('参数 ' + total + ' 个，网格 ' + drawables + ' 片');
  console.log('  真的能掀动东西的: ' + live.length +
              '（其中 dance.js 已经在驱动的 ' + used.length + ' 个）');
  console.log('  推到头也纹丝不动的: ' + dead.length + '（多半是特效开关，得配合别的参数用）');

  const table = (list, title) => {
    if (!list.length) return;
    console.log('\n' + title);
    console.log('  参数                     范围         掀动网格   最大位移   主要影响');
    console.log('  ' + '-'.repeat(74));
    for (const r of list) {
      console.log('  ' + r.id.padEnd(24) +
        (r.lo + '~' + r.hi).padEnd(12) +
        String(r.meshes).padStart(5) + ' 片' +
        (r.travel + '%').padStart(10) + '   ' + r.part);
    }
  };

  idle.sort((a, b) => b.travel - a.travel);
  used.sort((a, b) => b.travel - a.travel);

  table(idle, '【还没用过的】—— 按「能掀动多少」排序，越靠上越值得接');
  table(used, '【dance.js 已经在驱动的】');

  if (colorHits.size) {
    console.log('\n【顶点没动、但画面真的变了】—— 改颜色 / 改透明度的那批');
    console.log('  参数                     范围         画面变化');
    console.log('  ' + '-'.repeat(52));
    for (const [id, d] of [...colorHits].sort((a, b) => b[1] - a[1])) {
      const r = rows.find((x) => x.id === id);
      console.log('  ' + id.padEnd(24) + (r.lo + '~' + r.hi).padEnd(12) + (d + '%').padStart(8));
    }
    console.log('  这批是「换配色 / 开特效」的路子，顶点探针看不见它们。');
  }

  if (has('all') && dead.length) {
    const still = dead.filter((r) => !colorHits.has(r.id));
    console.log('\n【推到头也不动的】' + (has('color') ? '（截图也确认过了）' : '（还没做颜色差分，跑 --color 再确认一遍）'));
    console.log('  ' + still.map((r) => r.id).join('、'));
  }

  console.log('\n位移是按身高的百分比算的：5% 就是能挪动她身高的二十分之一，肉眼很明显。');
  console.log('想接哪个，写进 src/renderer/dance.js 的 PARAM_MAP 即可。');
  app.exit(0);
}).catch((e) => { console.error('炸了: ' + (e && e.stack || e)); app.exit(1); });
