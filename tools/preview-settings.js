'use strict';

// 把设置面板的四个页各截一张图。
//
//   npm run preview-settings
//
// 跟 bubble-preview 一个路子：独立窗口 + 假 preload 把渲染层顶起来。
// 设置面板是用户会盯着看的东西，光看代码看不出挤没挤、对没对齐。

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'preview');
const TABS = [['look', '形象'], ['voice', '声音'], ['work', '干活'], ['her', '她']];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 460, height: 620, show: true, frame: false,
    backgroundColor: '#0d0f16',
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, _l, m) => {
    if (!/Security|Content Security|electronjs/.test(m)) console.log('  [页面] ' + m.split('\n')[0]);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'settings.html'));

  const ok = await win.webContents.executeJavaScript(`
    new Promise((r) => {
      const t = setInterval(() => {
        if (document.querySelectorAll('#models .model').length || document.querySelector('#tints .chip')) {
          clearInterval(t); r(true);
        }
      }, 120);
      setTimeout(() => { clearInterval(t); r(false); }, 12000);
    })`);

  if (!ok) { console.error('设置页没渲染出来'); win.destroy(); app.exit(1); return; }
  await wait(400);

  console.log('窗口 460×620\n');

  for (const [id, label] of TABS) {
    await win.webContents.executeJavaScript(
      `document.querySelector('nav button[data-tab="${id}"]').click()`
    );
    await wait(320);

    const h = await win.webContents.executeJavaScript(
      `(() => { const m = document.querySelector('main');
         return { scroll: m.scrollHeight, view: m.clientHeight }; })()`
    );

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'settings-' + id + '.png'), img.toPNG());
    console.log('  ' + label.padEnd(4) + ' 内容高 ' + String(h.scroll).padStart(4) +
                '，可视 ' + h.view + (h.scroll > h.view ? '  （要滚动）' : '  （一屏放得下）'));
  }

  console.log('\n存到了 ' + OUT);
  win.destroy();
  app.exit(0);
}).catch((e) => { console.error('炸了: ' + e.message); app.exit(1); });
