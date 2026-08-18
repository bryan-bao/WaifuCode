'use strict';

// 气泡长什么样，截几张图看看。
//
//   npm run preview-bubble
//
// 起一个独立的 Electron 窗口把渲染层跑起来（用 mock-preload 顶替主进程），
// 让她说几句长短不一的话，每句截一张图存到 assets/preview/。
// UI 改动不看效果等于瞎改 —— 尤其是「气泡该从嘴边冒出来」这种，
// 差十几像素就从嘴边跑到耳朵上去了。
//
// 跟桌宠本体互不干扰：这是独立入口，不抢单实例锁。

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'preview');

const CASES = [
  { name: '1-短句', text: '在呢在呢。' },
  { name: '2-中等', text: '这么晚还不睡呀？眼睛都熬红了吧。' },
  { name: '3-长段', text: '「WaifuCode」那段做完了。改了 main.js、chat.js、perform.js 三个文件，中间报了一次错，不过后来自己绕过去了。你要不要看一眼？' },
  {
    name: '4-带按钮',
    text: '哟，还记得我啊？我这边活儿早干完了，一个人在角落里发呆呢。',
    offer: { kind: 'joke', label: '讲个听听', payload: 'x' },
  },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 320,
    height: 520,
    show: true,     // 隐藏窗口截出来经常是空的，显示出来最稳（几秒后自己关）
    transparent: false, // 透明窗口 capturePage 拿不到内容，同 make-icon 那个坑；
    frame: false,       // 顺带给个深色底，白字气泡在上面才看得清
    backgroundColor: '#141824',
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 沙箱里的 preload 只能 require electron 自己那几个模块，
      // 而这个假 preload 要读项目里的 profiles/config —— 得把沙箱关了。
      // 只是个本地预览脚本，不碰网络，关掉没风险。
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (!/Security Warning|Content Security|unsafe-eval|electronjs\.org|once the app|^\s*$/.test(message)) {
      console.log('  [页面] ' + message.split('\n')[0]);
    }
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    console.log('  [preload 出错] ' + p + ' -> ' + err.message);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  // 等模型加载完（stage.js 挂上 window.waifuStage 才算好了）
  const ok = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const t = setInterval(() => {
        if (window.waifuStage) { clearInterval(t); resolve(true); }
      }, 120);
      setTimeout(() => { clearInterval(t); resolve(false); }, 25000);
    })
  `);

  if (!ok) {
    console.error('模型没加载出来，截不了');
    win.destroy();
    app.exit(1);
    return;
  }

  await wait(1200); // 让物理和入场动作稳定下来

  console.log('窗口 320×520\n');

  for (const c of CASES) {
    await win.webContents.executeJavaScript(
      'window.waifuStage.say(' + JSON.stringify(c.text) + ', 0, ' + JSON.stringify(c.offer || null) + ')'
    );
    await wait(700); // 等气泡的入场动画走完

    const m = await win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('bubble');
        const t = document.getElementById('bubble-text');
        const o = document.getElementById('bubble-offer');
        const b = el.getBoundingClientRect();
        const tr = t.getBoundingClientRect();
        const or_ = o.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
          textH: Math.round(tr.height), offerH: Math.round(or_.height),
          offerDisplay: getComputedStyle(o).display,
          minH: cs.minHeight, disp: cs.display, align: cs.alignItems,
        };
      })()
    `);
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, c.name + '.png');
    fs.writeFileSync(file, img.toPNG());

    console.log('  ' + c.name.padEnd(10) +
      '气泡 ' + String(m.w).padStart(3) + '×' + String(m.h).padStart(3) +
      '  位置 (' + String(m.x).padStart(3) + ',' + String(m.y).padStart(3) + ')' +
      '  字数 ' + String(c.text.length).padStart(3) +
      '  │ 文字块 ' + m.textH + '  按钮块 ' + m.offerH + '(' + m.offerDisplay + ')' +
      '  display=' + m.disp + ' minH=' + m.minH);
  }

  console.log('\n存到了 ' + OUT);
  win.destroy();
  app.exit(0);
}).catch((e) => {
  console.error('炸了: ' + (e && e.message));
  app.exit(1);
});
