'use strict';

// 生成托盘和窗口图标：把她的头渲染出来、裁成方图、存成几个尺寸。
//
//   npm run make-icon
//   npm run make-icon -- --model=models/Mao/Mao.model3.json
//
// 这是个**独立的 Electron 入口**，不是桌宠本体 —— 它不去抢单实例锁，
// 所以桌宠开着的时候也能跑，不会把正在跑的那只顶掉。
//
// 生成的东西：
//   assets/tray.png      32×32   托盘
//   assets/tray@2x.png   64×64   高 DPI 托盘（Electron 自己会找）
//   assets/icon.png      256×256 窗口和任务栏
//   assets/icon-full.png 整张渲染图，用来核对裁的位置对不对

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets');

const { profileFor } = require('../src/profiles');
const config = require('../src/config');

function modelPath() {
  const arg = process.argv.find((a) => a.startsWith('--model='));
  if (arg) return arg.slice('--model='.length);
  return config.load().modelPath;
}

function saveDataUrl(dataUrl, file) {
  const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(file, buf);
  return buf.length;
}

app.disableHardwareAcceleration = app.disableHardwareAcceleration || (() => {});

app.whenReady().then(async () => {
  const mp = modelPath();
  const profile = profileFor(mp);
  // headRatio 为 null 表示这个模型自带真的 Head 判定区，但渲染层这儿用不上，
  // 还是得靠几何比例去裁，给个通用值
  const headRatio = profile.headRatio || 0.32;

  console.log('模型      ' + mp);
  console.log('头部比例  ' + headRatio + '（外接框顶上这一段算头）');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: {
      offscreen: false,
      nodeIntegration: false,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('  [页面] ' + message);
  });

  const url = 'file://' + path.join(__dirname, 'icon-shot.html').replace(/\\/g, '/') +
              '?model=' + encodeURIComponent('../' + mp.replace(/\\/g, '/')) +
              '&headRatio=' + headRatio;

  await win.loadURL(url);

  // 等模型加载 + 物理稳定
  const err = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const t = setInterval(() => {
        if (window.__ready) { clearInterval(t); resolve(window.__error); }
      }, 100);
      setTimeout(() => { clearInterval(t); resolve('等了 25 秒模型还没加载出来'); }, 25000);
    })
  `);

  if (err) {
    console.error('\n渲染失败: ' + err);
    win.destroy();
    app.exit(1);
    return;
  }

  const box = await win.webContents.executeJavaScript('window.__headBox()');
  console.log('外接框    ' + Math.round(box.w) + '×' + Math.round(box.h) +
              ' @ (' + Math.round(box.x) + ',' + Math.round(box.y) + ')');
  console.log('');

  const jobs = [
    ['tray.png', 32],
    ['tray@2x.png', 64],
    ['icon.png', 256],
  ];

  for (const [name, size] of jobs) {
    const dataUrl = await win.webContents.executeJavaScript('window.__makeIcon(' + size + ')');
    const bytes = saveDataUrl(dataUrl, path.join(OUT_DIR, name));
    console.log('  ✓ ' + name.padEnd(14) + size + '×' + size + '  ' + Math.round(bytes / 1024 * 10) / 10 + 'KB');
  }

  // 整张图留一份，方便肉眼核对裁的位置准不准
  const full = await win.webContents.executeJavaScript('window.__fullShot()');
  saveDataUrl(full, path.join(OUT_DIR, 'icon-full.png'));
  console.log('  · icon-full.png  整张渲染图（对照用，看裁得准不准）');

  console.log('');
  console.log('存到了 ' + OUT_DIR);
  console.log('重启桌宠就能在托盘里看到她了。');

  win.destroy();
  app.exit(0);
}).catch((e) => {
  console.error('炸了: ' + (e && e.message));
  app.exit(1);
});
