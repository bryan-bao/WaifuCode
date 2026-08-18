'use strict';

// 右下角那个设置齿轮，到底点不点得到。
//
// 起因是第一版根本点不到：齿轮只在「鼠标在角色上或在齿轮上」时显示，
// 而判定它「在不在齿轮上」又要求它当前是显示的 —— 死锁。
// 你从她身上往右下角挪，中间那片空白一进去齿轮就藏了，窗口跟着恢复穿透，
// 鼠标事件直接穿到桌面，于是永远够不着。
//
// 这种问题读代码很难看出来，得真的让鼠标走一遍。这里就是走一遍：
// 角色身上 → 中间空白 → 齿轮上，每一步检查齿轮显没显示、窗口穿不穿透。

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

let through = true; // 渲染层最后一次报的穿透状态
let opened = 0;
ipcMain.on('mock-through', (_e, v) => { through = v; });
ipcMain.on('mock-open-settings', () => { opened++; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 540, show: true, frame: false, transparent: false,
    backgroundColor: '#141824',
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (/失败|错误|Error/.test(m) && !/Security/.test(m)) console.log('  [页面] ' + m.split('\n')[0]);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  const ok = await win.webContents.executeJavaScript(`
    new Promise((r) => {
      const t = setInterval(() => { if (window.waifuStage) { clearInterval(t); r(true); } }, 120);
      setTimeout(() => { clearInterval(t); r(false); }, 25000);
    })`);
  if (!ok) { console.error('模型没加载出来'); win.destroy(); app.exit(1); return; }
  await wait(800);

  // 页面里的辅助函数：挪鼠标、读齿轮状态
  await win.webContents.executeJavaScript(`
    window.__move = (x, y) => window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
    window.__gear = () => {
      const g = document.getElementById('gear');
      const r = g.getBoundingClientRect();
      return { show: g.classList.contains('show'),
               cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
    };
    window.__center = () => {
      // 角色身上的一个点：外接框中心
      const b = window.__model ? null : null;
      return { x: Math.round(innerWidth / 2), y: Math.round(innerHeight * 0.55) };
    };
    true;
  `);

  const gear = await win.webContents.executeJavaScript('window.__gear()');
  const body = await win.webContents.executeJavaScript('window.__center()');
  console.log('齿轮在 (' + gear.cx + ',' + gear.cy + ')，角色身上取点 (' + body.x + ',' + body.y + ')\n');

  const move = async (x, y) => {
    await win.webContents.executeJavaScript(`window.__move(${x}, ${y})`);
    await wait(120);
    return win.webContents.executeJavaScript('window.__gear()');
  };

  console.log('[1] 鼠标移到她身上');
  let g = await move(body.x, body.y);
  check(g.show, '齿轮浮出来了');
  check(through === false, '窗口不穿透了（她身上本来就该能点）');

  console.log('\n[2] 往右下角挪，路过中间那片空白 —— 这是老版本翻车的地方');
  // 取点要真的落在空白里：角色是按椭圆判定的，直接取「她和齿轮的中点」
  // 往往还在她身上（第一版测试就是这么骗了自己）。
  // 这里取右侧边缘、齿轮热区上方的一块，确定既不是她也不是齿轮。
  const gapX = Math.min(410, gear.cx + 10);
  const gapY = Math.round(gear.cy - 150);
  g = await move(gapX, gapY);
  console.log('    空白点 (' + gapX + ',' + gapY + ')');
  check(g.show, '齿轮**还亮着**（不是一离开她就立刻消失）');
  check(through === true, '空白区恢复穿透（这样才不挡桌面图标）');

  console.log('\n[3] 挪到齿轮上');
  g = await move(gear.cx, gear.cy);
  check(g.show, '齿轮还在');
  check(through === false, '**窗口不穿透了 —— 这一下点得到**');

  console.log('\n[4] 真点一下');
  await win.webContents.executeJavaScript(`document.getElementById('gear').click()`);
  await wait(200);
  check(opened === 1, '设置窗口被叫起来了');

  console.log('\n[5] 走开之后它该自己收起来');
  await move(10, 10);
  g = await win.webContents.executeJavaScript('window.__gear()');
  check(g.show, '刚走开还留着（给你回头的机会）');
  await wait(2400);
  g = await win.webContents.executeJavaScript('window.__gear()');
  check(!g.show, '两秒后收起来了');

  console.log('\n[6] 收起来之后还能再够到吗（第一版就是死在这儿）');
  g = await move(gear.cx, gear.cy);
  check(g.show, '直接挪到齿轮位置，它又亮了 —— 判定不依赖它当前显不显示');
  check(through === false, '并且立刻不穿透，点得到');

  win.destroy();
  console.log('\n' + (bad ? '\x1b[31m有 ' + bad + ' 项没过\x1b[0m' : '\x1b[32m全过了\x1b[0m'));
  app.exit(bad ? 1 : 0);
}).catch((e) => { console.error('炸了: ' + e.message); app.exit(1); });
