'use strict';

// 把一个模型的**所有表情排成一张联络表**，一眼看完，每张下面标着「它到底改了多少」。
//
// 为什么需要它：表情名经常一点意思都没有（海梦那七个叫 expression1~7，
// 改的参数叫 Param40、Action03），而 `src/profiles.js` 的 faceMap 要求你说出
// 「哪张脸是害羞」。靠名字猜必然猜错，**切表情失败又是静默的** ——
// 脸一直不变，日志里一个字都没有。
//
// 也是新写表情之后的验收：写完 12 张脸，得看一眼它们真的**互相不一样** ——
// 而不是参数写了一堆、屏幕上纹丝不动（Hiyori 第一版把情绪全压在眉毛上，
// 而她厚刘海几乎盖住眉毛，实测应用成功但看不出任何变化）。
//
// 跑法：
//   npx electron tools/expression-sheet.js
//   npx electron tools/expression-sheet.js --model=models/海梦/female_01Arkit_6.model3.json
//   ... --out=D:\看一眼.png --cols=4 --cell=260
//
// 四件必须做对的事，少一件这张表就是骗人的：
//
//   · **先拍一张「不加表情」当参照**，每张脸都跟它比出一个 Δ。没有它你分不清
//     「表情没生效」和「这个模型的表情本来就细微」—— 而前者天天发生
//   · **每张之前清干净**：表情是叠加的，不清的话第五张带着前四张的效果
//   · **掐掉噪声源**（待机动作、眨眼、呼吸、物理），而且待机动作**会自己再起来**，
//     每张之前都得再停一次
//   · **不能用「每帧把所有参数写回快照」那招**（probe-uv 量贴图差分用的那个）——
//     那个钩子挂在 beforeModelUpdate 上，而表情是在它**之前**应用的，
//     于是每张脸都被写回中性表情，拼出来是一排一模一样的脸，
//     你还会得出「这个模型的表情根本没区别」的结论。上一轮就是这么误判的。

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DELTA = String.fromCharCode(916); // Δ
const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith('--' + k + '='));
  return a ? a.slice(k.length + 3) : d;
};

const MODEL = arg('model', '');
const COLS = Number(arg('cols', 4));
const CELL = Number(arg('cell', 260));   // 每格多大（像素）
const OUT = arg('out', '');

if (MODEL) process.env.WAIFU_MODEL = MODEL;

app.whenReady().then(async () => {
  try {
    const { profileFor } = require(path.join(ROOT, 'src', 'profiles'));
    const config = require(path.join(ROOT, 'src', 'config'));
    const modelPath = MODEL || config.load().modelPath;
    const profile = profileFor(modelPath);

    const win = new BrowserWindow({
      width: 420, height: 700, show: true, x: -3000, frame: false,
      transparent: false, backgroundColor: '#20242e',
      webPreferences: {
        preload: path.join(ROOT, 'tools', 'mock-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
        // 关掉后台节流：窗口在屏幕外，不关的话 rAF 被掐到近乎停止，
        // 表情的淡入根本走不完，截出来是一堆过渡态
        backgroundThrottling: false,
      },
    });

    // 渲染层里抛的错要说出来 —— 不然 executeJavaScript 只回一句
    // 「Script failed to execute」，真正的原因躺在你看不见的那个控制台里
    win.webContents.on('console-message', (_e, level, m) => {
      if (level >= 3) console.error('  [页面报错] ' + String(m).slice(0, 200));
    });

    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const ready = await win.webContents.executeJavaScript(`
      new Promise((r) => { const t = setInterval(() => {
        if (window.waifuStage && window.waifuStage.model()) { clearInterval(t); r(true); }
      }, 120); setTimeout(() => { clearInterval(t); r(false); }, 25000); })`);
    if (!ready) { console.error('模型没加载出来'); win.destroy(); app.exit(1); return; }
    await new Promise((r) => setTimeout(r, 1200));

    await win.webContents.executeJavaScript(`
      const im = window.waifuStage.model().internalModel;
      im.eyeBlink = undefined;   // 不眨眼 —— 正好眨在快门上，看着就像「闭眼」那张表情
      im.breath = undefined;     // 不呼吸
      im.physics = undefined;    // 头发不摆
      im.pose = undefined;       // 部件的自动开关不动
      // **视线必须掐掉**，这条最阴：stage.js 里鼠标静止 8 秒她就开始走神
      // （GAZE_IDLE_MS）。一张脸拍一秒多，于是前三张是老实的、第四张开始她
      // 眼睛已经转开了 —— 拼出来后半页整齐地差 21.9%，看着像「后四个表情
      // 效果一样、前三个没效果」，实际全是走神造成的。收尾那张参照就是抓它的
      im.updateFocus = () => {};
      im.updateNaturalMovements = () => {};
      // 待机动作**会自己再起来**（一段放完 motionManager 就再点一个）。
      // 不断根的话前几张是停住的、后几张她已经把头转过去了，拼出来后半页整体偏移，
      // 看着像「这些表情把整个头都改了」，实际是她在动
      im.motionManager.groups.idle = '';
      im.motionManager.stopAllMotions();
      // 气泡藏掉。她一起来就说「我在的，有活儿随时叫我～」，3.2 秒后自己收 ——
      // 于是前两张带着气泡、后面没有，**差异像素全落在气泡上**：Δ 全变成一模一样的
      // 4.3%，而「脸在哪儿」是按差异区域算的，直接把镜头框到了整个人身上
      const b = document.getElementById('bubble');
      if (b) b.style.display = 'none';
      true;`);

    const names = await win.webContents.executeJavaScript(`(() => {
      const em = window.waifuStage.model().internalModel.motionManager.expressionManager;
      if (!em || !em.definitions) return [];
      return em.definitions.map((d) => String(d.Name || d.File || ''));
    })()`);

    if (!names.length) {
      console.log('这个模型一个表情都没有（' + (profile.name || '') + '）。');
      console.log('可以用 node tools/make-expressions.js <模型名> 自己生成一套。');
      win.destroy(); app.exit(0); return;
    }

    const clear = async () => {
      await win.webContents.executeJavaScript(`(() => {
        const mm = window.waifuStage.model().internalModel.motionManager;
        mm.stopAllMotions();
        if (mm.expressionManager) mm.expressionManager.resetExpression();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 700));
    };

    // 两张图差在哪儿：变了多少个像素、都落在哪块区域。
    // Δ 是判读的全部依据：**0.0% 就是这张表情屏幕上什么都没发生**
    //（参数名对不上就是这个样，而且不报错、不警告）
    const diff = (a, b) => {
      const x = a.toBitmap(), y = b.toBitmap();
      const w = a.getSize().width;
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0; i < Math.min(x.length, y.length); i += 4) {
        if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) +
            Math.abs(x[i + 2] - y[i + 2]) > 24) {
          const px = (i / 4) % w, py = Math.floor((i / 4) / w);
          n++;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
        }
      }
      return { pct: n / (x.length / 4) * 100, n, x0, y0, x1, y1 };
    };

    // 先整帧拍一遍，**裁剪框最后再算** —— 见下面「脸在哪儿」
    await clear();
    const base = await win.webContents.capturePage();
    const frames = [];
    for (const name of names) {
      await clear();
      await win.webContents.executeJavaScript(
        'window.waifuStage.setExpression(' + JSON.stringify(name) + '); true');
      await new Promise((r) => setTimeout(r, 900)); // 等淡入走完（FadeInTime 0.45）
      frames.push({ name, img: await win.webContents.capturePage() });
    }

    /**
     * 脸在画面上的哪一块 —— **量出来，不是猜出来**。
     *
     * 头一版拿 `getBounds()` 的水平中心当脸的位置，对大多数模型碰巧是对的，
     * 但 Rice 是横版画布、人站在右半边 —— 裁出来是一条肩膀，十二张脸整整齐齐
     * 全是 0.0%，看着像「这个模型的表情全废了」，其实是**镜头对错了地方**。
     *
     * 现在改成：把每张表情跟「不加表情」的差异像素并起来，那块区域就是脸
     * （表情能改的东西全在脸上）。再往外放一圈当留白。
     * 一张都没差异时退回按 headRatio 估 —— 那种情况下裁哪儿都一样。
     */
    let X0 = 1e9, Y0 = 1e9, X1 = -1, Y1 = -1;
    for (const fr of frames) {
      const d = diff(base, fr.img);
      if (d.n < 30) continue;   // 几十个像素多半是噪声，别让它把框拉歪
      X0 = Math.min(X0, d.x0); Y0 = Math.min(Y0, d.y0);
      X1 = Math.max(X1, d.x1); Y1 = Math.max(Y1, d.y1);
    }

    const size = base.getSize();
    let box;
    if (X1 < 0) {
      console.log('  [!] 每一张表情都没让画面变过 —— 镜头对不对都无所谓了，按估的裁');
      const k = size.width / 420;
      const g = JSON.parse(await win.webContents.executeJavaScript(
        'JSON.stringify(window.waifuStage.model().getBounds())'));
      const h = g.height * (profile.headRatio || 0.34) * k;
      box = { x: Math.round((g.x + g.width / 2) * k - h / 2), y: Math.round(g.y * k),
              width: Math.round(h), height: Math.round(h) };
    } else {
      // 放一圈留白，再摆成正方形 —— 光有眼睛嘴巴那一小条看不出是谁
      const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
      const half = Math.max(X1 - X0, Y1 - Y0) * 1.15 + 20;
      box = {
        x: Math.round(Math.max(0, Math.min(size.width - 1, cx - half))),
        y: Math.round(Math.max(0, Math.min(size.height - 1, cy - half))),
        width: Math.round(half * 2), height: Math.round(half * 2),
      };
      box.width = Math.min(box.width, size.width - box.x);
      box.height = Math.min(box.height, size.height - box.y);
    }

    const cut = (img) => img.crop(box);
    const baseFace = cut(base);
    const shots = [{ name: '（不加表情）',
                     url: baseFace.resize({ width: CELL, height: CELL }).toDataURL() }];

    // Δ 要在**裁完之后**算：整帧算的话，脸上那点变化被大片背景稀释成 0.1%，
    // 「有没有变化」这件事就问不出来了
    for (const fr of frames) {
      const face = cut(fr.img);
      const d = diff(baseFace, face).pct;
      shots.push({ name: fr.name + '  ' + DELTA + d.toFixed(1) + '%',
                   url: face.resize({ width: CELL, height: CELL }).toDataURL() });
      console.log('  ' + fr.name.padEnd(12) + ' ' + DELTA + d.toFixed(1) + '%' +
                  (d < 0.5 ? '   <- 屏幕上几乎没变化' : ''));
    }

    // **收尾再拍一张「不加表情」。** 跟开头那张应该一模一样；差得多就说明这一趟里
    // 有东西没被清干净，那么上面每一格的 Δ 都掺了这份漂移，不能照着判读
    await clear();
    const base2 = cut(await win.webContents.capturePage());
    const drift = diff(baseFace, base2).pct;
    if (drift > 1) {
      console.log('  [!] 收尾那张「不加表情」跟开头差 ' + drift.toFixed(1) +
                  '% —— 有东西没清干净，上面的 ' + DELTA + ' 掺了这份漂移');
      shots.push({ name: '（收尾·不加表情）' + DELTA + drift.toFixed(1) + '%',
                   url: base2.resize({ width: CELL, height: CELL }).toDataURL() });
    }

    // 拼成一张。在页面里用 canvas 拼 —— NativeImage 只能裁和缩，不会拼
    const sheet = await win.webContents.executeJavaScript(`(async () => {
      const shots = ${JSON.stringify(shots)};
      const cols = ${COLS}, cell = ${CELL}, pad = 8, label = 26;
      const rows = Math.ceil(shots.length / cols);
      const c = document.createElement('canvas');
      c.width = cols * (cell + pad) + pad;
      c.height = rows * (cell + label + pad) + pad;
      const g = c.getContext('2d');
      g.fillStyle = '#20242e'; g.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < shots.length; i++) {
        const x = pad + (i % cols) * (cell + pad);
        const y = pad + Math.floor(i / cols) * (cell + label + pad);
        const im = await new Promise((res, rej) => {
          const t = new Image(); t.onload = () => res(t); t.onerror = rej; t.src = shots[i].url;
        });
        g.drawImage(im, x, y, cell, cell);
        g.fillStyle = '#e8ecf5';
        g.font = '16px sans-serif';
        g.fillText(shots[i].name, x + 2, y + cell + 18);
      }
      return c.toDataURL('image/png');
    })()`);

    const out = OUT ||
      path.join(ROOT, 'expressions-' + path.basename(path.dirname(modelPath)) + '.png');
    fs.writeFileSync(out, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log('');
    console.log(names.length + ' 张脸拼在: ' + out);
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error('挂了: ' + (err && err.message));
    app.exit(1);
  }
});
