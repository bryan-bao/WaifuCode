'use strict';

// 每个部件在贴图上占哪些像素，以及把那些像素抠出来 / 改完贴回去。
//
// 这是「换贴图」那条路的地基。整张图集重画是**必然错位**的 —— UV 是像素级的，
// 谁也复现不了作者那个排布。唯一走得通的做法是：
//
//   把某个部件的像素抠出来 → 只改这些像素 → 原位贴回去
//
// 对齐关系分毫不动，因为网格取的还是同一片 UV。
// 能换的是**颜色、花纹、材质**；**换不了版型** —— 版型由网格几何决定，跟贴图无关。
//
// ---------------------------------------------------------------------------
// 为什么不能用「部件的包围盒」
//
// 头一版就是这么写的，跑出来 115 对部件互相重叠 —— 因为**一个部件的网格是
// 散落在图集各处的**（打包器按零件塞得很紧，同一个部件的零件根本不挨着）。
// PartHoodie 16 片网格的包围盒占了整张图的 38%，抠出来会带走一大堆别人的东西，
// 贴回去就把别的部件覆盖了。**而且不会报错。**
//
// 所以改成按**三角形精确建掩膜**：把这个部件所有网格的三角形照着 UV 画到
// 一张跟图集同尺寸的画布上，那张就是「哪些像素属于它」的精确答案。
// ---------------------------------------------------------------------------
//
// 跑法：
//   npx electron tools/probe-uv.js                    每个部件占多少像素
//   npx electron tools/probe-uv.js --cut=PartRobe --out=D:\robe.png
//        → 一张跟图集同尺寸的图，只有这个部件的像素，其余透明。
//          交给画图的（人或者模型）改颜色/花纹，**不要动尺寸、不要挪位置**
//   npx electron tools/probe-uv.js --paste=PartRobe --from=D:\robe-new.png --out=D:\atlas.png
//        → 拿原图集打底，只把掩膜内的像素换成你改好的，生成一张新图集
//   npx electron tools/probe-uv.js --verify=PartHat
//        → 把那个部件涂成品红贴回去看一眼，验证掩膜对不对
//   npx electron tools/probe-uv.js --cut=PartRobe --pattern=D:\星空.png --out=D:tlas.png --shot=D:\看一眼.png
//        → 把一张花纹铺到这个部件上，**保留原图的明暗**（褶皱阴影都在明暗里），
//          顺便截一张应用后的效果图
//
// ---------------------------------------------------------------------------
// 为什么是「贴花纹」而不是「让 AI 直接改这张图」
//
// 图像模型**没法保住像素级的排布** —— 你给它一张 2048 的图集（上面是一堆散落的、
// 摊平的布料零件），让它「把长袍改成星空色」，它会重新理解并重画整张图，
// 出来的东西按掩膜贴回去就是一坨糊的，褶皱和缝线全对不上。
// 而且 gpt-image-2 不支持透明背景、尺寸只有 1024 档，两条都跟图集对不上。
//
// 所以分工要反过来：**模型只做它擅长的（画一张好看的无缝花纹），
// 像素级的活交给程序**。合成时用 `color` 混合 —— 色相和饱和度取自花纹，
// **明暗取自原图**，于是所有褶皱、阴影、缝线一根都不少。
//
// 不花钱。--verify 会开一个可见窗口，其余不开窗。

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const config = require('../src/config');

// --model= 只影响这次查看，**不动 config.json**。想看看别的模型身上有什么，
// 不该逼你先把桌宠切过去
const MODEL = (process.argv.find((x) => x.startsWith('--model=')) || '').slice(8);
if (MODEL) process.env.WAIFU_MODEL = MODEL;

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : null;
};

const CUT = arg('cut');
const PATTERN = arg('pattern');   // 贴花纹：拿一张图当材质铺上去
const BLEND = arg('blend') || 'color';
const SHOT = arg('shot');
const PASTE = arg('paste');
const VERIFY = arg('verify');
const OUT = arg('out');
const FROM = arg('from');

// 在页面里建掩膜：把一个部件所有网格的三角形照着 UV 画出来。
// 三角形之间会有一像素的缝，所以描一道边把缝糊上 —— 缝留着的话贴回去
// 会出现一圈发丝一样的旧颜色
const MASK_FN = `
  window.__mask = (part) => {
    const m = window.waifuStage.model();
    const core = m.internalModel.coreModel;
    const W = m.textures[0].width, H = m.textures[0].height;
    const parts = Array.from(core._model.parts.ids);
    const parent = Array.from(core._model.drawables.parentPartIndices);
    const n = core.getDrawableCount();

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.lineJoin = 'round';

    let tris = 0;
    for (let i = 0; i < n; i++) {
      if (parts[parent[i]] !== part) continue;
      let uv, idx;
      try { uv = core.getDrawableVertexUvs(i); idx = core.getDrawableVertexIndices(i); } catch (_) { continue; }
      if (!uv || !idx || !idx.length) continue;
      // UV 原点在左下、图片像素原点在左上，**纵向必须翻**。
      // 不翻不会报错，只会静静地拿到上下颠倒的另一块地方
      const px = (k) => [uv[k * 2] * W, (1 - uv[k * 2 + 1]) * H];
      g.beginPath();
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = px(idx[t]), b = px(idx[t + 1]), d = px(idx[t + 2]);
        g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(d[0], d[1]); g.closePath();
        tris++;
      }
      g.fill(); g.stroke();
    }
    c.__tris = tris;
    return c;
  };
  window.__loadImg = (src) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('读不到 ' + src));
    im.src = src;
  });
  true;`;

app.whenReady().then(async () => {
  const mp = MODEL || config.load().modelPath;
  const modelJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', mp), 'utf8'));
  const atlasRel = path.posix.join(
    path.dirname(mp).replace(/\\/g, '/'), modelJson.FileReferences.Textures[0]);
  const atlasUrl = '../../' + atlasRel;

  const win = new BrowserWindow({
    width: 460, height: 620, show: Boolean(VERIFY || SHOT), frame: false, backgroundColor: '#202030',
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
  await win.webContents.executeJavaScript(MASK_FN);

  const partList = JSON.parse(await win.webContents.executeJavaScript(`
    JSON.stringify((() => {
      const m = window.waifuStage.model();
      const core = m.internalModel.coreModel;
      const parts = Array.from(core._model.parts.ids);
      const parent = Array.from(core._model.drawables.parentPartIndices);
      const n = core.getDrawableCount();
      const cnt = {};
      for (let i = 0; i < n; i++) {
        const p = parts[parent[i]] || '(无部件)';
        cnt[p] = (cnt[p] || 0) + 1;
      }
      return { cnt, size: { w: m.textures[0].width, h: m.textures[0].height } };
    })())`));

  const target = CUT || PASTE || VERIFY;
  const makeAtlas = Boolean(PASTE || PATTERN);

  // --- 抠 / 贴 / 验 ---------------------------------------------------------
  if (target) {
    if (!partList.cnt[target]) {
      console.error('没有这个部件: ' + target +
        '\n有的是: ' + Object.keys(partList.cnt).join('、'));
      win.destroy(); app.exit(1); return;
    }

    const png = await win.webContents.executeJavaScript(`
      (async () => {
        const atlas = await window.__loadImg(${JSON.stringify(atlasUrl)});
        const mask = window.__mask(${JSON.stringify(target)});
        const W = mask.width, H = mask.height;
        const out = document.createElement('canvas'); out.width = W; out.height = H;
        const g = out.getContext('2d');

        ${CUT && !PATTERN ? `
        // 只留掩膜里的像素：先画掩膜，再用 source-in 把图集裁进去
        g.drawImage(mask, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.drawImage(atlas, 0, 0);
        window.__lastTris = mask.__tris;
        return out.toDataURL('image/png');` : ''}

        ${VERIFY || PASTE || PATTERN ? `
        // 改好的那层：VERIFY 用纯品红，PASTE 用你给的整张图，PATTERN 铺花纹
        const patch = document.createElement('canvas'); patch.width = W; patch.height = H;
        const pg = patch.getContext('2d');
        ${VERIFY ? `pg.fillStyle = 'rgb(255,0,255)'; pg.fillRect(0, 0, W, H);` : ''}
        ${PASTE ? `const edited = await window.__loadImg(${JSON.stringify('file:///' + String(FROM || '').replace(/\\/g, '/'))});
                   pg.drawImage(edited, 0, 0, W, H);` : ''}
        ${PATTERN ? `
        // 先铺原图（明暗的来源），再用 color 混合把花纹的色相饱和度盖上去。
        // 反过来做的话明暗就丢了，出来是一块死板的色块
        const pat = await window.__loadImg(${JSON.stringify('file:///' + String(PATTERN || '').replace(/\\/g, '/'))});
        pg.drawImage(atlas, 0, 0);
        pg.globalCompositeOperation = ${JSON.stringify(BLEND)};
        const tile = pg.createPattern(pat, 'repeat');
        pg.fillStyle = tile; pg.fillRect(0, 0, W, H);
        pg.globalCompositeOperation = 'source-over';` : ''}

        pg.globalCompositeOperation = 'destination-in';
        pg.drawImage(mask, 0, 0);

        // 原图集打底，改好的那层盖上去 —— 掩膜外一个像素都没碰
        g.drawImage(atlas, 0, 0);
        g.drawImage(patch, 0, 0);
        window.__newAtlas = out;
        window.__lastTris = mask.__tris;
        return out.toDataURL('image/png');` : ''}
      })()`);

    const tris = await win.webContents.executeJavaScript('window.__lastTris');

    if (VERIFY) {
      // **先把整套参数冻住。** 不冻的话她一直在呼吸眨眼、物理一直在摆，
      // 前后两张截图的差异绝大部分是这些动作 —— 实测噪声底 3%，
      // 而贴图替换本身可能才 1%，直接被淹掉，还会给出「变化遍布全身」的假象
      await win.webContents.executeJavaScript(`
        const im = window.waifuStage.model().internalModel;
        const core = im.coreModel;
        const ids = core._parameterIds || [];
        const frozen = ids.map((_, i) => core.getParameterValueByIndex(i));
        im.on('beforeModelUpdate', () => {
          for (let i = 0; i < ids.length; i++) {
            try { core.setParameterValueByIndex(i, frozen[i]); } catch (_) {}
          }
        });
        true;`);

      // 位图尺寸不等于窗口尺寸 —— capturePage 是按设备像素比出图的。
      // 把宽度写死成窗口宽的话，算出来的 x/y 全是错的（而且看着还挺像那么回事）
      let SHOT_W = 0;
      const shot = async () => {
        await new Promise((res) => setTimeout(res, 700));
        const img = await win.capturePage();
        SHOT_W = img.getSize().width;
        return img.toBitmap();
      };
      // 先连拍两张量噪声底，冻住之后应该接近 0
      const n1 = await shot();
      const before = await shot();
      let noise = 0;
      for (let i = 0; i < Math.min(n1.length, before.length); i += 4) {
        if (Math.abs(n1[i] - before[i]) + Math.abs(n1[i + 1] - before[i + 1]) +
            Math.abs(n1[i + 2] - before[i + 2]) > 40) noise++;
      }
      await win.webContents.executeJavaScript(
        '(() => { window.waifuStage.model().textures[0] = PIXI.Texture.from(window.__newAtlas); return true; })()');
      const after = await shot();

      const W = SHOT_W || 460;
      let n = 0, y0 = 1e9, y1 = -1, x0 = 1e9, x1 = -1;
      for (let i = 0; i < Math.min(before.length, after.length); i += 4) {
        const d = Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) +
                  Math.abs(before[i + 2] - after[i + 2]);
        if (d > 40) {
          const px = (i / 4) % W, py = Math.floor((i / 4) / W);
          n++;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
        }
      }
      const pct = n / (before.length / 4) * 100;
      console.log('\n验证 ' + target + '（' + tris + ' 个三角形的掩膜，涂成品红贴回去）');
      console.log('  截图 ' + W + ' 像素宽（窗口 460，差的是设备像素比）');
      console.log('  噪声底 ' + noise + ' 个像素（冻住参数之后应该接近 0）');
      console.log('  屏幕上变了 ' + n + ' 个像素（' + pct.toFixed(2) + '%），' +
                  '落在 y=' + y0 + '~' + y1 + '、x=' + x0 + '~' + x1);
      console.log(n > 150
        ? '  ✅ 生效了，而且只动了一块局部 —— 掩膜和贴图替换都是对的'
        : '  ❌ 几乎没变化，掩膜或者贴图替换有问题');
      await new Promise((res) => setTimeout(res, 3000)); // 留几秒让你自己看一眼
    } else if (OUT) {
      fs.writeFileSync(OUT, Buffer.from(png.split(',')[1], 'base64'));
      console.log((PATTERN ? '铺好花纹了' : (makeAtlas ? '贴回去了' : '抠出来了')) + ': ' + OUT);
      console.log('  ' + partList.size.w + '×' + partList.size.h + '，' + tris + ' 个三角形的掩膜' +
                  (PATTERN ? '，混合方式 ' + BLEND : ''));

      // 顺手截一张应用后的效果图 —— 不然你拿到一张图集也不知道穿上什么样
      if (SHOT) {
        await win.webContents.executeJavaScript(`
          const im = window.waifuStage.model().internalModel;
          const core = im.coreModel;
          const ids = core._parameterIds || [];
          const frozen = ids.map((_, i) => core.getParameterValueByIndex(i));
          im.on('beforeModelUpdate', () => {
            for (let i = 0; i < ids.length; i++) {
              try { core.setParameterValueByIndex(i, frozen[i]); } catch (_) {}
            }
          });
          window.waifuStage.model().textures[0] = PIXI.Texture.from(window.__newAtlas);
          true;`);
        await new Promise((res) => setTimeout(res, 900));
        fs.writeFileSync(SHOT, (await win.capturePage()).toPNG());
        console.log('  效果图: ' + SHOT);
      }

      if (CUT && !PATTERN) {
        console.log('\n  改的时候三条规矩：');
        console.log('  1. **尺寸不许变**，位置不许挪 —— 挪一个像素就跟网格对不上了');
        console.log('  2. 只改颜色/花纹/材质。版型是网格几何决定的，画不出来');
        console.log('  3. 透明的地方保持透明（那些像素不属于这个部件）');
      } else {
        console.log('\n  这是一张**完整的新图集**。让她用上：把它放进 models/… 里替换原图，');
        console.log('  或者留着原图、在 stage.js 里 model.textures[0] = PIXI.Texture.from(新图)');
      }
    } else {
      console.error('少了 --out=输出路径');
    }

    win.destroy(); app.exit(0);
    return;
  }

  // --- 只报告：每个部件真正占了多少像素 -------------------------------------
  const rows = [];
  for (const part of Object.keys(partList.cnt)) {
    const r = JSON.parse(await win.webContents.executeJavaScript(`
      JSON.stringify((() => {
        const mask = window.__mask(${JSON.stringify(part)});
        const g = mask.getContext('2d');
        const d = g.getImageData(0, 0, mask.width, mask.height).data;
        let on = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] < 8) continue;
          on++;
          const p = (i - 3) / 4, x = p % mask.width, y = (p / mask.width) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return { on, x0, x1, y0, y1, tris: mask.__tris, W: mask.width, H: mask.height };
      })())`));
    if (r.on > 0) rows.push({ part, ...r, meshes: partList.cnt[part] });
  }
  win.destroy();

  rows.sort((a, b) => b.on - a.on);
  const total = partList.size.w * partList.size.h;

  console.log('\n模型: ' + mp);
  console.log('贴图: ' + atlasRel + '  ' + partList.size.w + '×' + partList.size.h);
  console.log('\n每个部件**真正占用**的像素（按三角形算的，不是包围盒）：');
  console.log('  部件                    网格    占图集    像素散布的范围');
  console.log('  ' + '-'.repeat(66));
  for (const r of rows) {
    console.log('  ' + r.part.padEnd(23) + String(r.meshes).padStart(3) + ' 片  ' +
      ((r.on / total * 100).toFixed(2) + '%').padStart(8) + '   ' +
      ('x ' + r.x0 + '~' + r.x1 + '  y ' + r.y0 + '~' + r.y1));
  }

  console.log('\n注意「范围」是零件散布的跨度，不是一块实心矩形 ——');
  console.log('同一个部件的网格在图集上是**散着放**的，所以只能按掩膜抠，不能按矩形裁。');
  console.log('\n抠一块出来改：npx electron tools/probe-uv.js --cut=' +
              (rows[0] ? rows[0].part : 'PartXxx') + ' --out=D:\\一块.png');
  console.log('先验一下掩膜对不对：npx electron tools/probe-uv.js --verify=' +
              (rows[0] ? rows[0].part : 'PartXxx'));
  app.exit(0);
}).catch((e) => { console.error('炸了: ' + (e && e.stack || e)); app.exit(1); });
