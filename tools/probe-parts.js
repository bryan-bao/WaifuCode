'use strict';

// 这个模型身上有哪些部件、每个部件管着画面的哪一块、藏掉它能不能看出来。
//
// 「换装」能做到什么程度，全看模型作者把素材拆成了几个部件 —— 但**部件的 id
// 和它实际管的东西经常对不上号**。Mao 有个部件叫 PartHat，你以为是帽子；
// 光看名字猜必然猜错，得去问模型自己。
//
// 做法是直接读几何数据：每个网格（drawable）属于哪个部件，它的顶点铺在哪一片。
// 一开始试过「藏一个截一张图做像素差分」，翻车了两次，两次都很有代表性：
//
//   1. **藏过的部件没还原。** 部件透明度跟参数不一样 —— 帧末的 loadParameters
//      只管 parameters，一个字都不碰 parts.opacities，写下去就一直是那个值。
//      于是藏过的全留在画面外，越往后测「影响」越大，最后一个部件「影响」了整个身体。
//   2. **她根本没停下来。** 停了待机动作，物理还在惯性摆动；把物理也关了，
//      motionManager 又自己把 idle 动作接了回去。差分量到的是她在呼吸，
//      不是你藏掉的那块布。
//
// 读顶点就没这些事：不用截图、不受动画影响、瞬间出结果。
//
// 跑法：
//   npx electron tools/probe-parts.js                     当前配置里的模型
//   npx electron tools/probe-parts.js --model=models/Mao/Mao.model3.json
//
// 配好 hairStyles 之后想看看长什么样，不用启动整个桌宠：
//   npx electron tools/probe-parts.js --try=PartHat,PartRobe --shot=D:\看一眼.png
//
// 新加一个模型要往 profiles.js 里填 headRatio / mouthRatio（摸头摸哪儿、气泡从哪冒），
// 别用眼睛估 —— 拧一下参数看哪片顶点动了，动的那片就是嘴/就是头：
//   npx electron tools/probe-parts.js --face --model=models/Chitose/chitose.model3.json
//
// 不花钱，不显示窗口，几秒钟。

const { app, BrowserWindow } = require('electron');
const path = require('path');

const config = require('../src/config');

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : null;
};

app.whenReady().then(async () => {
  const mp = arg('model') || config.load().modelPath;
  console.log('\n模型: ' + mp);

  const win = new BrowserWindow({
    width: 460, height: 620, show: false,
    // backgroundThrottling 不关的话，窗口 show:false 时 rAF 会被掐停，
    // pixi 一帧都没渲染过，--shot 那条路上 app.render() 直接踩空
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false,
                      backgroundThrottling: false },
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
      const app = new Application({ view: document.getElementById('c'), width: 460, height: 620,
                                    backgroundAlpha: 0, preserveDrawingBuffer: true });
      Live2DModel.from(${JSON.stringify('../' + mp.replace(/\\/g, '/'))}, { autoInteract: false })
        .then((m) => {
          window.__m = m;
          m.anchor.set(0.5, 0.5); m.position.set(230, 310);
          m.scale.set(620 / m.internalModel.height * 0.92);
          app.stage.addChild(m);
          window.__done = true;
        })
        .catch((e) => { window.__err = e.message; window.__done = true; });

      // 预览用：每帧按住这几个部件，然后截一张
      window.__try = (ids) => {
        const core = window.__m.internalModel.coreModel;
        const all = Array.from(core._model.parts.ids);
        const idx = ids.map((s) => all.indexOf(s));
        const missing = ids.filter((s, i) => idx[i] < 0);
        window.__hidden = idx.filter((i) => i >= 0);
        if (!window.__hooked) {
          window.__hooked = true;
          window.__m.internalModel.on('beforeModelUpdate', () => {
            for (const i of (window.__hidden || [])) {
              try { core.setPartOpacityByIndex(i, 0); } catch (_) {}
            }
          });
        }
        return { hid: window.__hidden.length, missing };
      };
      window.__png = () => { try { app.render(); return app.view.toDataURL('image/png'); } catch (e) { return 'ERR:' + (e && e.message); } };

      /**
       * 嘴在哪、头到哪儿为止 —— 靠拧参数量，不靠看。
       *
       * 每个模型的网格 id 大多是 ArtMesh37 这种流水号，名字里根本没有 mouth；
       * 但参数 id 是有语义的（ParamMouthOpenY / PARAM_MOUTH_OPEN_Y）。
       * 于是：先记下全身顶点，把嘴张到 1，再记一次，**动了的那些顶点就是嘴**。
       * 头同理 —— 让她转个头，跟着转的整片（含头发）就是头，取它的下边界。
       *
       * 比例的分母必须是**画布**，不是「可见顶点铺开的范围」—— stage.js 那边用的是
       * model.getBounds()，量的就是画布。拿顶点范围当分母的话，画布留白多的模型
       * （haru、Hiyori 都留了不少）会算出一个偏上十几个百分点的嘴，气泡直接飘到额头。
       *
       * 全程同步跑完，中间不还给渲染循环，所以待机动作插不进来（那是 rAF 里的）。
       */
      window.__face = () => {
        const core = window.__m.internalModel.coreModel;
        const n = core.getDrawableCount();
        const pids = Array.from(core._model.parameters.ids);
        const find = (re) => pids.filter((id) => re.test(id));

        const snap = () => {
          const out = [];
          for (let i = 0; i < n; i++) {
            try { out.push(Float32Array.from(core.getDrawableVertices(i))); }
            catch (_) { out.push(null); }
          }
          return out;
        };
        const bounds = (snapshot, moved) => {
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (let i = 0; i < n; i++) {
            if (moved && !moved[i]) continue;
            const v = snapshot[i];
            if (!v || (!moved && core.getDrawableOpacity(i) <= 0.02)) continue;
            for (let k = 0; k < v.length; k += 2) {
              const x = v[k], y = v[k + 1];
              if (!isFinite(x) || !isFinite(y)) continue;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
          return { x0, x1, y0, y1 };
        };

        const base = snap();
        const body = bounds(base, null);

        /**
         * 拧一组参数，回报哪些网格动了。
         *
         * 阈值是**相对最大位移**的，不是一个绝对小数：转头的时候整个身子都会
         * 跟着晃一点点，拿绝对阈值一筛，「头」里就混进了半个身子（实测 Hiyori
         * 129 片、haru 84 片，量出来的下巴直接掉到脚踝）。头顶动得最狠，
         * 躯干只是余波 —— 按最大位移的 share 切一刀，剩下的才是真的头。
         */
        const wiggle = (ids, val, share) => {
          if (!ids.length) return null;
          const keep = ids.map((id) => core.getParameterValueById(id));
          ids.forEach((id) => core.setParameterValueById(id, val));
          core.update();
          const now = snap();

          const dist = [];
          let max = 0;
          for (let i = 0; i < n; i++) {
            const a = base[i], b = now[i];
            let d = 0;
            if (a && b && a.length === b.length && core.getDrawableOpacity(i) > 0.02) {
              for (let k = 0; k < a.length; k++) {
                const t = Math.abs(a[k] - b[k]);
                if (t > d) d = t;
              }
            }
            dist.push(d);
            if (d > max) max = d;
          }
          const cut = Math.max(max * share, (body.y1 - body.y0) * 5e-4);
          const moved = dist.map((d) => d >= cut);

          const box = bounds(now, moved);
          ids.forEach((id, i) => core.setParameterValueById(id, keep[i]));
          core.update();
          return isFinite(box.y0) ? { box, count: moved.filter(Boolean).length } : null;
        };

        // 转头只认 ParamAngleZ 本人 —— ParamBodyAngleZ 是身子，跟进来就没法分头和躯干了
        const mouthIds = find(/mouth.*open/i).length ? find(/mouth.*open/i) : find(/mouth/i);
        const headIds = find(/^param_?angle_?z$/i).length ? find(/^param_?angle_?z$/i) : find(/angle_?z$/i);
        const mouth = wiggle(mouthIds, 1, 0.25);
        const head = wiggle(headIds, 30, 0.35);

        // canvasinfo 里的宽高是**像素**，顶点坐标是模型单位，差着一个 PixelsPerUnit。
        // 忘了除的话每个模型都会算出 0.50 —— 分子比分母小三个数量级，恒等于原点那一半。
        const ci = core.getModel().canvasinfo;
        const H = ci.CanvasHeight / ci.PixelsPerUnit;
        const top = H - ci.CanvasOriginY / ci.PixelsPerUnit;
        const down = (y) => (top - y) / H; // 从画布顶往下数的比例
        return {
          mouthParams: mouthIds, headParams: headIds,
          canvas: [ci.CanvasWidth, ci.CanvasHeight],
          // 人在画布里的哪一段。超出 0~1 就说明模型画到画布外面去了，
          // 那 stage.js 按 getBounds() 定位的一切（气泡、摸头）都会偏
          body: [down(body.y1), down(body.y0)],
          mouth: mouth && { ratio: down((mouth.box.y0 + mouth.box.y1) / 2), meshes: mouth.count },
          head: head && { ratio: down(head.box.y0), meshes: head.count },
        };
      };

      window.__scan = () => {
        const im = window.__m.internalModel;
        const core = im.coreModel;
        const raw = core._model;

        const partIds = Array.from(raw.parts.ids);
        const parent = Array.from(raw.drawables.parentPartIndices);
        const n = core.getDrawableCount();

        // 先扫一遍全身，拿到整体范围，好把坐标归一化成「从头顶到脚底的百分之几」
        let X0 = Infinity, X1 = -Infinity, Y0 = Infinity, Y1 = -Infinity;
        const boxes = [];
        for (let i = 0; i < n; i++) {
          let v = null;
          try { v = core.getDrawableVertices(i); } catch (_) { }
          if (!v || !v.length) { boxes.push(null); continue; }
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (let k = 0; k < v.length; k += 2) {
            const x = v[k], y = v[k + 1];
            if (!isFinite(x) || !isFinite(y)) continue;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
          if (!isFinite(x0)) { boxes.push(null); continue; }
          const box = { x0, x1, y0, y1, verts: v.length / 2,
                        opacity: core.getDrawableOpacity(i) };
          boxes.push(box);
          // 完全透明的网格（特效层）不参与「整个人有多大」的统计
          if (box.opacity > 0.02) {
            if (x0 < X0) X0 = x0; if (x1 > X1) X1 = x1;
            if (y0 < Y0) Y0 = y0; if (y1 > Y1) Y1 = y1;
          }
        }

        // 按部件汇总
        const byPart = partIds.map((id) => ({
          id, meshes: 0, visible: 0, area: 0,
          x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity,
        }));
        for (let i = 0; i < n; i++) {
          const p = parent[i];
          const b = boxes[i];
          if (p == null || p < 0 || p >= byPart.length || !b) continue;
          const e = byPart[p];
          e.meshes++;
          if (b.opacity > 0.02) {
            e.visible++;
            e.area += Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
            if (b.x0 < e.x0) e.x0 = b.x0; if (b.x1 > e.x1) e.x1 = b.x1;
            if (b.y0 < e.y0) e.y0 = b.y0; if (b.y1 > e.y1) e.y1 = b.y1;
          }
        }

        return { partIds, byPart, bounds: { X0, X1, Y0, Y1 },
                 drawCount: n, hitAreas: (im.settings.hitAreas || []).map((h) => h.Name || h.name) };
      };
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
  await new Promise((r) => setTimeout(r, 900));

  // --try= 模式：只预览这套组合，截一张图就走
  const tryList = arg('try');
  if (tryList || arg('shot')) {
    const ids = (tryList || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) {
      const r = await win.webContents.executeJavaScript('window.__try(' + JSON.stringify(ids) + ')');
      if (r.missing.length) console.log('⚠️  这几个部件这个模型里没有: ' + r.missing.join(', '));
      console.log('藏起来 ' + r.hid + ' 个部件');
      await new Promise((res) => setTimeout(res, 900));
    }

    const out = arg('shot') || path.join(__dirname, '..', 'part-preview.png');
    const u = await win.webContents.executeJavaScript('window.__png()');
    if (!u || u.indexOf(',') < 0) {
      console.error('截图失败: ' + u);
      win.destroy();
      app.exit(1);
      return;
    }
    require('fs').writeFileSync(out, Buffer.from(u.split(',')[1], 'base64'));
    console.log('图存在: ' + out);
    win.destroy();
    app.exit(0);
    return;
  }

  // --face 模式：只报 profiles.js 要填的那两个比例
  if (process.argv.includes('--face')) {
    const f = await win.webContents.executeJavaScript('window.__face()');
    console.log('画布: ' + f.canvas.join('x') + '，人占画布纵向 ' + (f.body[0]*100).toFixed(0) + '%~' + (f.body[1]*100).toFixed(0) + '%');
    console.log('嘴巴参数: ' + (f.mouthParams.join(', ') || '没找到'));
    console.log('转头参数: ' + (f.headParams.join(', ') || '没找到'));
    console.log('');
    console.log(f.mouth
      ? `  mouthRatio: ${f.mouth.ratio.toFixed(2)},   // 嘴那 ${f.mouth.meshes} 片网格的中点`
      : '  mouthRatio: 量不出来，参数没匹配上，得手填');
    console.log(f.head
      ? `  headRatio: ${f.head.ratio.toFixed(2)},    // 跟着转头动的 ${f.head.meshes} 片，到这儿为止`
      : '  headRatio: 量不出来，参数没匹配上，得手填');
    console.log('\n模型自带点击区: ' +
      (await win.webContents.executeJavaScript(
        '(window.__m.internalModel.settings.hitAreas||[]).map(h=>h.Name||h.name).join("/")') || '无') +
      '（有 Head 的话 headRatio 可以写 null，用真的点击区）');
    win.destroy();
    app.exit(0);
    return;
  }

  const info = await win.webContents.executeJavaScript('window.__scan()');
  const { X0, X1, Y0, Y1 } = info.bounds;
  const spanY = Y1 - Y0;
  const spanX = X1 - X0;
  const bodyArea = spanX * spanY;

  console.log('部件 ' + info.partIds.length + ' 个，网格 ' + info.drawCount + ' 片' +
              (info.hitAreas.length ? '，点击区: ' + info.hitAreas.join('/') : '，没有点击区'));
  console.log('');

  // 模型坐标里 y 是往上的，转成「从头顶往下数」才好读
  const where = (e) => {
    const top = (Y1 - e.y1) / spanY;
    const bot = (Y1 - e.y0) / spanY;
    const mid = (top + bot) / 2;
    const band =
      mid < 0.15 ? '头顶' :
      mid < 0.30 ? '头脸' :
      mid < 0.50 ? '上身' :
      mid < 0.72 ? '腰胯' :
      mid < 0.88 ? '腿' : '脚';
    const cx = ((e.x0 + e.x1) / 2 - X0) / spanX;
    const side = cx < 0.40 ? '偏左' : cx > 0.60 ? '偏右' : '居中';
    return { band, side, top, bot };
  };

  const rows = info.byPart
    .filter((e) => e.visible > 0)
    .map((e) => ({ ...e, ...where(e), pct: (e.area / bodyArea) * 100 }))
    .sort((a, b) => b.pct - a.pct);

  console.log('看得见的部件（藏掉它画面上真的会少一块）：\n');
  console.log('  ' + '部件 id'.padEnd(20) + '网格'.padStart(5) + '  ' + '占地'.padStart(7) + '   位置        纵向范围');
  console.log('  ' + '-'.repeat(68));
  for (const r of rows) {
    console.log('  ' + r.id.padEnd(20) +
                String(r.visible).padStart(4) + '片' +
                (r.pct.toFixed(1) + '%').padStart(8) + '   ' +
                (r.band + ' ' + r.side).padEnd(10) + '  ' +
                (r.top * 100).toFixed(0) + '%~' + (r.bot * 100).toFixed(0) + '% 处');
  }

  const invisible = info.byPart.filter((e) => e.meshes > 0 && e.visible === 0);
  const empty = info.byPart.filter((e) => e.meshes === 0);

  if (invisible.length) {
    console.log('\n有网格但默认整个透明的 ' + invisible.length +
                ' 个（特效层，平时看不见，藏不藏都一样）：');
    console.log('  ' + invisible.map((e) => e.id + '(' + e.meshes + ')').join(', '));
  }
  if (empty.length) {
    console.log('\n一片网格都没挂的 ' + empty.length + ' 个（纯分组用的空壳）：');
    console.log('  ' + empty.map((e) => e.id).join(', '));
  }

  console.log('\n怎么用：挑几个部件的 id 写进 src/profiles.js 的 hairStyles，');
  console.log('右键菜单「换个发型」里就能切。比如把外套和帽子藏掉就是一套居家造型。');
  console.log('注意别去藏 pose3 里成组的那些（一般是 ArmA/ArmB），那是同一条胳膊的两个姿势。');

  win.destroy();
  app.exit(0);
}).catch((e) => { console.error('炸了: ' + (e && e.stack || e)); app.exit(1); });
