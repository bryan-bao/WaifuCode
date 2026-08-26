// 把派活面板渲染出来截图（喂假数据），看布局对不对。
// 面板改版之后眼见为实用它：npx electron tools/preview-panel.js
// 产物 panel-lanes.png 落在它自己目录旁边。**preload 用真的那份** ——
// mock-preload 是给 stage 用的，没有面板要的方法。
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const LANES = [
  { laneId: 'L1', name: '又出现那个问题了，你adb看一下', lastRun: '2026-08-26T09:00:00Z', alive: true, turns: 3 },
  { laneId: 'L2', name: '又出现那个问题了，你adb看一下', lastRun: '2026-08-26T08:00:00Z', alive: true, turns: 5 },
  { laneId: 'L3', name: '', hint: '一条旧线', lastRun: '2026-08-25T08:00:00Z', alive: true, turns: 1 },
  { laneId: 'L4', name: '', hint: '一条旧线', lastRun: '2026-08-24T08:00:00Z', alive: true, turns: 2 },
];

app.whenReady().then(async () => {
  // 面板要的 IPC 全给桩，只关心布局
  const H = {
    'app:info': () => ({ version: '1.0.3', root: 'D:/WaifuCode', dataRoot: 'D:/WaifuCode',
      lanIPs: ['192.168.1.35'], updateDir: 'D:/WaifuCode/updates', updatePort: 47200, updateAvailable: null }),
    'term:list': () => [],
    'session:list': () => [],
    'session:projects': () => [{ name: 'WaifuCode', path: 'D:/WaifuCode', turns: 9, lastRun: new Date().toISOString() }],
    'session:lanes': () => LANES,
    'mood:get': () => ({ state: 'normal', energy: 70, mood: 62, affection: 68,
      bond: { level: 3, title: '老搭档', xp: 750, next: 900 }, busy: false, days: 12, tasks: 30, streak: 2 }),
    'journal:today': () => ({ today: { costUsd: 1.2, turns: 8, tasks: 2, terms: 1, briefs: [], lanes: [], spanMin: 120, unpriced: 0, projects: [] }, month: { costUsd: 9, days: 3 }, days: 12 }),
    'journal:totals': () => ({ since: '2026-08-14', sinceDays: 12, life: { turns: 522, tasks: 86, costUsd: 2497 }, days: 12, terms: 5, turns: 522, tasks: 86, greets: 0, chats: 0, costUsd: 2497, unpriced: 0 }),
    'project:status': () => ({ branch: 'feature/mood2', dirty: 3, ahead: 1, behind: 0, lastCommit: '心情系统三层重构' }),
    'config:get': () => ({ dispatch: {}, update: {}, mobile: {} }),
    'mobile:info': () => ({ ok: false }),
  };
  for (const [ch, fn] of Object.entries(H)) ipcMain.handle(ch, (_e, ...a) => fn(...a));
  ipcMain.on('panel:ready', () => {});

  const w = new BrowserWindow({
    width: 900, height: 640, show: false, backgroundColor: '#0d0f16',
    webPreferences: {
      preload: 'D:/WaifuCode/src/preload.js', // 用真 preload，方法齐全
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
    },
  });
  w.webContents.on('console-message', (_e, _l, m) => console.log('[panel] ' + m));
  await w.loadFile('D:/WaifuCode/src/renderer/panel.html');
  w.show();
  await new Promise((r) => setTimeout(r, 1500));
  // 把目录填上并触发线的渲染
  await w.webContents.executeJavaScript(`
    document.getElementById('dir').value = 'D:/WaifuCode';
    document.getElementById('dir').dispatchEvent(new Event('input'));
  `).catch((e) => console.log('fill err ' + e.message));
  await new Promise((r) => setTimeout(r, 1200));
  const img = await w.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'panel-preview.png'), img.toPNG());
  // 量一下 #lanes 到底在哪
  const box = await w.webContents.executeJavaScript(`
    (() => {
      const el = document.getElementById('lanes');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { rect: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)},
               display: cs.display, position: cs.position, count: el.children.length,
               parent: el.parentElement.className };
    })()
  `).catch((e) => ({ err: e.message }));
  console.log('#lanes → ' + JSON.stringify(box));
  app.exit(0);
});
