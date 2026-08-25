'use strict';
// 截图那条链的自检。真截一小块（不碰用户屏幕内容，只看尺寸对不对），
// 外加把几条「不许退」的规矩钉住：坐标要换算、拍之前浮罩必须没了、
// 图进剪贴板要放位图、以及**不许替用户发进终端**（他要的是可粘贴）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const shot = require('../src/shot');

let bad = 0;
const check = (cond, label) => {
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m ' : '\x1b[31m✗\x1b[0m ') + label);
  if (!cond) bad++;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-shot-'));

  console.log('[1] 真截一块，尺寸要分毫不差');
  {
    const f = await shot.grab({ x: 60, y: 60, w: 320, h: 200, dir, log: () => {} });
    const b = fs.readFileSync(f);
    check(b.slice(1, 4).toString() === 'PNG', '出来的是 PNG');
    check(b.readUInt32BE(16) === 320 && b.readUInt32BE(20) === 200,
          '尺寸就是要的那块（' + b.readUInt32BE(16) + '×' + b.readUInt32BE(20) + '）');
    check(b.length > 1000, '不是空图');
  }

  console.log('\n[2] 攒多了要自己清');
  {
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, 'shot-' + (1000 + i) + '.png'), 'x');
    fs.writeFileSync(path.join(dir, '别动我.png'), 'x');
    shot.sweep(dir, 3);
    const left = fs.readdirSync(dir).filter((f) => /^shot-\d+\.png$/.test(f));
    check(left.length === 3, '只留最近 3 张（现在 ' + left.length + ' 张）');
    check(fs.existsSync(path.join(dir, '别动我.png')), '不是我们截的图一个都不许删');
  }

  console.log('\n[3] 源码里几条不许退的');
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const seg = main.slice(main.indexOf('async function doShot'), main.indexOf('async function doShot') + 2600);
    check(seg.includes('dipToScreenRect'),
          '框的坐标要 DIP→物理像素换算 —— 缩放 125% 的机器上不换算就截歪');
    check(/win\.destroy\(\)[\s\S]{0,200}setTimeout/.test(seg),
          '先把浮罩关干净再拍（不然拍到自己那层灰罩）');
    // 用户明确要的是「可粘贴」而不是「自动发」（2026-08-25）：
    // 替他挑一条线发出去，猜错就是把图贴给了别人那条活
    check(seg.includes('clipboard.writeImage'),
          '图进剪贴板放的是**位图**（粘路径要她再读一次盘，还看不见预览）');
    check(!seg.includes('terminals.sendText'),
          '截完不许替用户发进终端 —— 粘哪儿、配什么话、什么时候发是他的事');
    check(seg.includes('clipboard.writeText'),
          '图读不回来时退而复制路径，别让这一下白截');
    const sh = fs.readFileSync(path.join(__dirname, '..', 'src', 'shot.js'), 'utf8');
    check(sh.includes('EncodedCommand'),
          '脚本走 base64 传给 PowerShell（这个项目在它的编码上栽过一次）');
    // 注释里提它是解释「为什么不用」，所以只看代码行
    const code = sh.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(!code.includes('desktopCapturer'),
          '别用 desktopCapturer —— 它给缩略图，截给 AI 看的字会糊');
    const conf = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
    // 截图键**默认留空**：全局快捷键跟别的软件撞是家常便饭（实机撞过），
    // 撞了按下去毫无反应，用户只会以为功能坏了 —— 让人自己在设置里按一个
    check(/shot:\s*''/.test(conf), '截图快捷键默认不占键，让用户自己设');
    const set = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.js'), 'utf8');
    check(set.includes('accelOf'), '设置页能录快捷键（手敲 CommandOrControl+Alt+S 这种写法不现实）');
    check(set.includes("if (!mods.length) return null"), '录的键必须带修饰键 —— 光一个字母会在打字时乱触发');
    check(main.includes('hotkeyState'), '挂没挂上要有回执 —— 被占了得如实告诉用户');
    check(/hotkey[\s\S]{0,80}registerHotkey\(\)/.test(main), '设置里改完当场重挂，不用重启');
    const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    check(pre.includes('shotPick') && pre.includes('shotCancel'), '浮罩那两个频道进了 preload');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('');
  console.log(bad === 0 ? '\x1b[32m全过了\x1b[0m' : '\x1b[31m' + bad + ' 项没过\x1b[0m');
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了: ' + e.stack); process.exit(1); });
